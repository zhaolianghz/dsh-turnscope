import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readlink, stat } from 'node:fs/promises'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { checkpointIdFor, checkpointPathIdFor } from '../domain/ids.ts'
import { SCHEMA_VERSION } from '../domain/types.ts'
import type {
  CheckpointCompleteness,
  CheckpointPathState,
  CheckpointPhase,
  CheckpointRecord,
  PathStatus,
} from '../domain/types.ts'
import { OBJECT_KINDS } from '../storage/object-store.ts'
import type { ObjectStore } from '../storage/object-store.ts'
import type { TraceRepository } from '../storage/repository.ts'
import type { GitPort, GitStatusEntry } from './git-port.ts'

/** The storage operations a capture performs. */
export type CheckpointSink = Pick<
  TraceRepository,
  'putCheckpoint' | 'putCheckpointPath' | 'putObjectRecord'
>

/** What a capture needs from its environment. */
export interface CheckpointDeps {
  readonly git: GitPort
  readonly store: ObjectStore
  readonly sink: CheckpointSink
  /**
   * Files larger than this are fingerprinted but not copied.
   *
   * The hash still goes into `fileDigests`, so drift on a large file is still
   * detectable; what is lost is the ability to put the bytes back, which is why
   * the checkpoint's `completeness` drops to `partial` rather than staying
   * `complete`.
   */
  readonly maxBlobBytes: number
  /** Paths never observed, matched by exact path or directory prefix. */
  readonly ignorePaths: readonly string[]
}

/** One checkpoint to take. */
export interface CaptureCheckpointInput {
  readonly workspaceId: string
  /** Symlink-resolved worktree root, as {@link RepositoryIdentity} reports it. */
  readonly repoRoot: string
  readonly turnId: string
  readonly phase: CheckpointPhase
  /**
   * Paths a tool hint named. They are unioned with what git reports as changed,
   * because a file the agent touched and then restored to its old content is
   * still evidence about the turn even though `git status` no longer shows it.
   */
  readonly hintedPaths?: readonly string[]
  /** Epoch milliseconds; injectable so a test can pin the timestamp. */
  readonly now?: number
}

/** The records one capture produced, already persisted. */
export interface CheckpointCapture {
  readonly record: CheckpointRecord
  readonly paths: readonly CheckpointPathState[]
  /** Paths whose bytes were stored, sorted. */
  readonly capturedPaths: readonly string[]
}

/**
 * Convert an absolute or relative path to a repository-relative one, or reject
 * it. This is `docs/ARCHITECTURE.md §34.2`'s first two steps — normalize, then
 * prove it stays inside the root — applied before any path reaches the
 * filesystem.
 */
export function toRepoRelative(root: string, candidate: string): string | undefined {
  const value = candidate.replaceAll('\\', '/')
  const relativePath = isAbsolute(value) ? relative(root, value) : value
  if (relativePath.length === 0) return undefined
  const normalized = normalize(relativePath).replaceAll('\\', '/')
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return undefined
  return normalized
}

/**
 * The absolute path of `candidate` only when it is provably inside `root`.
 *
 * The prefix check is on the separator, not on the bare root string: without
 * it, `/repo-other` would pass as a descendant of `/repo`.
 */
export function resolveWithin(root: string, candidate: string): string | undefined {
  const relativePath = toRepoRelative(root, candidate)
  if (relativePath === undefined) return undefined
  const absolute = resolve(root, relativePath)
  return absolute === root || absolute.startsWith(root + sep) ? absolute : undefined
}

/** Whether a repo-relative path falls under an ignore entry. */
export function isIgnored(path: string, ignorePaths: readonly string[]): boolean {
  return ignorePaths.some(entry => {
    const normalized = entry.replaceAll('\\', '/').replace(/\/+$/, '')
    if (normalized.length === 0) return false
    return path === normalized || path.startsWith(`${normalized}/`)
  })
}

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

const contentHashOf = (bytes: Uint8Array): string => `sha256:${sha256Hex(bytes)}`

/** A zero byte is git's own binary heuristic and it is cheap to apply here. */
const isBinaryBytes = (bytes: Uint8Array): boolean => bytes.includes(0)

/** What was found for one path, before it is turned into a row. */
type Content =
  | { readonly mode: 'bytes'; readonly bytes: Uint8Array; readonly binary: boolean }
  | { readonly mode: 'streamed'; readonly hash: string; readonly binary: boolean }
  | undefined

/**
 * Fingerprint a file without holding it in memory.
 *
 * Only reached for files past the blob budget, where the point is to still get
 * a stable digest without reading a multi-gigabyte file into the harness
 * process. Binary detection rides along on the first chunk that contains a zero.
 */
async function digestStream(path: string): Promise<{ hash: string; binary: boolean }> {
  const hash = createHash('sha256')
  let binary = false
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer
    if (!binary && isBinaryBytes(buffer)) binary = true
    hash.update(buffer)
  }
  return { hash: hash.digest('hex'), binary }
}

/**
 * Read the bytes that describe a path.
 *
 * The worktree is consulted first. A path absent from it (a deletion) falls back
 * to the bytes git already holds — the index copy, then `HEAD` — because the
 * content a recovery would need for a deleted file is exactly the content that
 * is no longer on disk.
 *
 * A symlink is stored as its target string, which is what git stores too: the
 * bytes of the link are the path it points at, and following it could read a
 * file outside the workspace for a reason the user never intended.
 */
async function resolveContent(
  git: GitPort,
  root: string,
  entry: GitStatusEntry,
  maxBlobBytes: number,
): Promise<Content> {
  const absolute = resolveWithin(root, entry.path)
  if (absolute !== undefined) {
    try {
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute)
        const bytes = Buffer.from(target, 'utf8')
        return { mode: 'bytes', bytes, binary: false }
      }
      if (info.isFile()) {
        if (info.size <= maxBlobBytes) {
          const bytes = await readFile(absolute)
          return { mode: 'bytes', bytes, binary: isBinaryBytes(bytes) }
        }
        const { hash, binary } = await digestStream(absolute)
        return { mode: 'streamed', hash, binary }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
    }
  }

  const oid = entry.indexOid ?? entry.headOid
  if (oid === undefined) return undefined
  const bytes = await git.blob(root, oid)
  if (bytes === undefined) return undefined
  return { mode: 'bytes', bytes, binary: isBinaryBytes(bytes) }
}

const sortObject = (record: Readonly<Record<string, string>>): Readonly<Record<string, string>> => {
  const sorted: Record<string, string> = {}
  for (const key of Object.keys(record).sort()) {
    const value = record[key]
    if (value !== undefined) sorted[key] = value
  }
  return sorted
}

const digestOfParts = (parts: readonly string[]): string | undefined =>
  parts.length === 0 ? undefined : `sha256:${sha256Hex(Buffer.from(parts.join('\n'), 'utf8'))}`

/**
 * Whether a git path such as `MERGE_HEAD` names a file that is actually there.
 *
 * `rev-parse --git-path` prints the path it *would* use whether or not the file
 * exists, so its exit code says nothing about an in-progress merge. The only
 * question that answers that is whether the file is on disk.
 */
async function gitPathExists(git: GitPort, root: string, name: string): Promise<boolean> {
  const path = await git.gitPath(root, name)
  if (path === undefined) return false
  try {
    await stat(isAbsolute(path) ? path : resolve(root, path))
    return true
  } catch {
    return false
  }
}

/**
 * Why a checkpoint could not be taken.
 *
 * Exported rather than spelled inline at both the producer and the consumer, so
 * a safety rule can name "the workspace is not a repository" without matching on
 * a string someone may reword later.
 */
export const CHECKPOINT_FAILURE = {
  /** The path is not inside a Git worktree at all (`§14.1` S009). */
  NOT_A_REPOSITORY: 'not a git worktree',
  /** `git status` ran and failed, which is different from having no changes. */
  STATUS_UNAVAILABLE: 'git status unavailable',
} as const

/**
 * Observe a workspace and persist the result.
 *
 * This is the observer of `docs/ARCHITECTURE.md §11`: it answers "what is here
 * right now" with facts only — a HEAD, a branch, a status, a digest per changed
 * path, and the raw bytes of each — and makes no attribution judgement, which
 * belongs to the pure engine in Phase D.
 *
 * It never throws for an expected Git condition. A missing repository or an
 * unavailable `git status` produces a `failed` checkpoint instead, because the
 * caller stores that row and the safety engine must be able to read "we could
 * not look" without a try/catch around every capture.
 */
export async function captureCheckpoint(
  deps: CheckpointDeps,
  input: CaptureCheckpointInput,
): Promise<CheckpointCapture> {
  const { git, store, sink, maxBlobBytes, ignorePaths } = deps
  const { workspaceId, repoRoot, turnId, phase } = input
  const createdAt = input.now ?? Date.now()
  const id = checkpointIdFor(turnId, phase)

  const failed = (failureReason: string): CheckpointRecord => ({
    schemaVersion: SCHEMA_VERSION,
    id,
    workspaceId,
    turnId,
    phase,
    cleanStart: false,
    mergeInProgress: false,
    rebaseInProgress: false,
    cherryPickInProgress: false,
    completeness: 'failed',
    restorable: false,
    createdAt,
    failureReason,
  })

  if (!(await git.isRepository(repoRoot))) {
    const record = failed(CHECKPOINT_FAILURE.NOT_A_REPOSITORY)
    await sink.putCheckpoint(record)
    return { record, paths: [], capturedPaths: [] }
  }

  const status = await git.status(repoRoot)
  if (status === undefined) {
    const record = failed(CHECKPOINT_FAILURE.STATUS_UNAVAILABLE)
    await sink.putCheckpoint(record)
    return { record, paths: [], capturedPaths: [] }
  }

  // The raw status decides cleanliness, before hints add clean paths to the set
  // of things worth fingerprinting: a hint does not make a repository dirty.
  const cleanStart = status.length === 0

  const seen = new Set(status.map(entry => entry.path))
  const entries: GitStatusEntry[] = [...status]
  for (const hint of input.hintedPaths ?? []) {
    const path = toRepoRelative(repoRoot, hint)
    if (path === undefined || seen.has(path)) continue
    seen.add(path)
    entries.push({ path, status: 'clean', staged: false, unmerged: false })
  }

  const relevant = entries.filter(entry => !isIgnored(entry.path, ignorePaths))

  const paths: CheckpointPathState[] = []
  const fileDigests: Record<string, string> = {}
  const capturedPaths: string[] = []
  let missing = 0
  let oversized = 0

  for (const entry of relevant) {
    const content = await resolveContent(git, repoRoot, entry, maxBlobBytes)
    const contentHash =
      content === undefined
        ? undefined
        : content.mode === 'bytes'
          ? contentHashOf(content.bytes)
          : `sha256:${content.hash}`
    if (contentHash !== undefined) fileDigests[entry.path] = contentHash

    let blobRef: string | undefined
    if (content !== undefined && content.mode === 'bytes') {
      if (content.bytes.byteLength > maxBlobBytes) {
        oversized += 1
      } else {
        const stored = await store.put(OBJECT_KINDS.RECOVERY_BLOB, content.bytes, {
          redaction: 'raw-bytes',
        })
        await sink.putObjectRecord({
          schemaVersion: SCHEMA_VERSION,
          ref: stored.ref,
          kind: OBJECT_KINDS.RECOVERY_BLOB,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          createdAt,
        })
        blobRef = stored.ref
        capturedPaths.push(entry.path)
      }
    } else if (content !== undefined) {
      oversized += 1
    } else {
      // A path we chose to observe and could not read is a hole, whether git
      // called it changed or clean: a hint whose file vanished still means the
      // observation is not whole.
      missing += 1
    }

    const status: PathStatus = entry.status

    paths.push({
      schemaVersion: SCHEMA_VERSION,
      id: checkpointPathIdFor(id, entry.path),
      checkpointId: id,
      path: entry.path,
      status,
      staged: entry.staged,
      binary: content?.binary ?? false,
      ...(entry.previousPath === undefined ? {} : { previousPath: entry.previousPath }),
      ...(contentHash === undefined ? {} : { contentHash }),
      ...(entry.mode === undefined ? {} : { mode: entry.mode }),
      ...(blobRef === undefined ? {} : { blobRef }),
    })
  }

  const indexParts = relevant
    .filter(entry => entry.staged)
    .map(entry => `${entry.path}\0${entry.indexOid ?? entry.headOid ?? ''}`)
    .sort()
  const worktreeParts = Object.entries(fileDigests)
    .map(([path, hash]) => `${path}\0${hash}`)
    .sort()

  const completeness: CheckpointCompleteness =
    missing > 0 || oversized > 0 ? 'partial' : 'complete'

  const head = await git.head(repoRoot)
  const mergeInProgress = await gitPathExists(git, repoRoot, 'MERGE_HEAD')
  const rebaseInProgress =
    (await gitPathExists(git, repoRoot, 'rebase-merge')) ||
    (await gitPathExists(git, repoRoot, 'rebase-apply'))
  const cherryPickInProgress = await gitPathExists(git, repoRoot, 'CHERRY_PICK_HEAD')

  const indexDigest = digestOfParts(indexParts)
  const worktreeDigest = digestOfParts(worktreeParts)

  const record: CheckpointRecord = {
    schemaVersion: SCHEMA_VERSION,
    id,
    workspaceId,
    turnId,
    phase,
    ...(head === undefined ? {} : { headOid: head.oid }),
    ...(head?.branch === undefined ? {} : { branch: head.branch }),
    cleanStart,
    mergeInProgress,
    rebaseInProgress,
    cherryPickInProgress,
    ...(indexDigest === undefined ? {} : { indexDigest }),
    ...(worktreeDigest === undefined ? {} : { worktreeDigest }),
    fileDigests: sortObject(fileDigests),
    completeness,
    // "Restorable" is a claim about the *data*: every changed path was finger-
    // printed and copied. V0.1 performs no recovery, so nothing reads this to
    // act, but overstating it now would be the wrong thing to build on.
    restorable: completeness === 'complete',
    createdAt,
  }

  await sink.putCheckpoint(record)
  for (const path of paths) await sink.putCheckpointPath(path)

  return { record, paths, capturedPaths: capturedPaths.sort() }
}
