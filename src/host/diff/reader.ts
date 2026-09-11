/**
 * The one place that knows where a file's two sides come from.
 *
 * `unified.ts` compares two lists of lines and cannot fail. Getting to those
 * lines is where all the ways a diff can be *unavailable* live, and this module
 * exists so that they are decided once, deliberately, and in one file:
 *
 * - The **after** side is the end of the turn, which only `POST` can describe. If
 *   the path is absent from `POST`'s rows, its bytes were not copied, and the
 *   honest answer is that we cannot show them — the current worktree is not a
 *   substitute, because the user may have edited the file since.
 *
 * - The **before** side usually has no row at all, and that is the normal case,
 *   not a gap: a checkpoint observes the paths that are *dirty* plus the ones a
 *   tool hint names (`docs/ARCHITECTURE.md §12.2`), so an agent editing a clean
 *   tracked file produces a `PRE` checkpoint with nothing to say about it. The
 *   content is still recoverable, because at that moment the file *was* its
 *   committed content — so `PRE`'s recorded `headOid` plus the path is the exact
 *   before state, read through the read-only `cat-file` the port already allows.
 *   This fallback is gated on there being no row: when a row exists and says
 *   "not captured", falling back to `HEAD` would quietly compare against the
 *   wrong baseline, and for a file that was already dirty that would be a lie
 *   about what the turn changed.
 *
 * Everything the reader needs about *whose* change this is travels with the
 * result, because a diff without its attribution invites the reader to assume
 * the agent wrote it.
 */
import { checkpointIdFor } from '../domain/ids.ts'
import type { CheckpointPathState, CheckpointRecord, FileChange, TurnRecord } from '../domain/types.ts'
import type { GitPort } from '../git/git-port.ts'
import type { TurnWorkspace } from '../inspection/types.ts'
import type { ObjectStore } from '../storage/object-store.ts'
import type { TraceRepository } from '../storage/repository.ts'
import {
  DEFAULT_DIFF_OPTIONS,
  splitLines,
  unifiedDiff,
  type DiffText,
  type UnifiedDiffOptions,
} from './unified.ts'
import type { DiffSide, DiffSource, DiffUnavailableReason, FileDiff } from './types.ts'

/** The stored evidence a diff is assembled from. */
export type DiffSink = Pick<
  TraceRepository,
  'getCheckpoint' | 'listCheckpointPaths' | 'listFileChanges'
>

export interface DiffDeps {
  readonly git: GitPort
  readonly store: ObjectStore
  readonly sink: DiffSink
  /** Overrides for the renderer's caps; the defaults are in `unified.ts`. */
  readonly limits?: Partial<UnifiedDiffOptions> | undefined
}

export interface FileDiffReader {
  /**
   * The diff of one path in one turn, or `undefined` when the turn did not
   * change that path.
   *
   * `undefined` rather than an "unavailable" answer on purpose: a path the turn
   * never touched is *not found*, and a caller that rendered it as "we cannot
   * show you this" would be claiming evidence it does not have. The caller turns
   * this into the contract's `null`.
   */
  read(turn: TurnRecord, workspace: TurnWorkspace, path: string): Promise<FileDiff | undefined>
}

/** One side, resolved to bytes, to absence, or to a reason there are none. */
type Resolved =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array; readonly source: DiffSource }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable'; readonly reason: SideFailure; readonly detail: string }

/** Why a *side* could not be produced, short of the file not existing. */
type SideFailure = 'not-recorded' | 'missing-blob' | 'git-unavailable'

export function createFileDiffReader(deps: DiffDeps): FileDiffReader {
  const options: UnifiedDiffOptions = { ...DEFAULT_DIFF_OPTIONS, ...(deps.limits ?? {}) }

  const read = async (
    turn: TurnRecord,
    workspace: TurnWorkspace,
    path: string,
  ): Promise<FileDiff | undefined> => {
    const changes = await deps.sink.listFileChanges(turn.id)
    const change = changes.find(candidate => candidate.path === path)
    if (change === undefined) return undefined

    const pre = await checkpointOf(turn.id, 'pre')
    const post = await checkpointOf(turn.id, 'post')
    if (pre === undefined || post === undefined) {
      return failed(
        change,
        undefined,
        undefined,
        undefined,
        'no-checkpoint',
        'The turn does not have both a before and an after checkpoint, so there is nothing to compare.',
      )
    }

    const beforeRow = pre.paths.find(row => row.path === (change.previousPath ?? change.path))
    const afterRow = post.paths.find(row => row.path === change.path)

    const before = await resolveBefore(change, pre.record, beforeRow, workspace)
    const after = await resolveAfter(change, afterRow)

    const sides: { readonly before: DiffSide; readonly after: DiffSide } = {
      before: sideInfo(before, change.beforeHash),
      after: sideInfo(after, change.afterHash),
    }

    // Checked one side at a time rather than as one condition: the reader has to
    // name which side failed, and a union test would not carry that through.
    if (before.kind === 'unavailable') {
      return failed(change, beforeRow, afterRow, sides, before.reason, before.detail)
    }
    if (after.kind === 'unavailable') {
      return failed(change, beforeRow, afterRow, sides, after.reason, after.detail)
    }

    const beforeText = textOf(before, beforeRow)
    const afterText = textOf(after, afterRow)
    if (beforeText === undefined || afterText === undefined) {
      // A binary side has no lines to compare. The sizes and digests above are
      // still offered, which is what `FR-07` asks for: metadata, not a rendering.
      return { ...header(change, beforeRow, afterRow), ...sides, availability: { kind: 'binary' } }
    }

    const diff = unifiedDiff(beforeText, afterText, options)
    return {
      ...header(change, beforeRow, afterRow),
      ...sides,
      availability: { kind: 'text', hunks: diff.hunks, truncated: diff.truncated },
    }
  }

  const checkpointOf = async (
    turnId: string,
    phase: 'pre' | 'post',
  ): Promise<{ record: CheckpointRecord; paths: readonly CheckpointPathState[] } | undefined> => {
    const record = await deps.sink.getCheckpoint(checkpointIdFor(turnId, phase))
    if (record === undefined) return undefined
    return { record, paths: await deps.sink.listCheckpointPaths(record.id) }
  }

  /**
   * The before side: a copied blob, the file at the turn's starting commit, or a
   * reason there is neither.
   */
  const resolveBefore = async (
    change: FileChange,
    pre: CheckpointRecord,
    row: CheckpointPathState | undefined,
    workspace: TurnWorkspace,
  ): Promise<Resolved> => {
    // A created file has no before state at all — this is a fact about the
    // change, not a gap in the capture.
    if (change.kind === 'created') return { kind: 'absent' }

    if (row !== undefined) return fromRow(row, 'before')

    if (pre.headOid === undefined) {
      return {
        kind: 'unavailable',
        reason: 'git-unavailable',
        detail:
          'The file was unchanged when the turn started, and the commit it started from could not be read.',
      }
    }

    // The path is the recorded one, not the requested one: a request may only
    // *select* a recorded path, never supply one. `cat-file` resolves a
    // `<treeish>:<path>` suffix from the top of the worktree, which is the
    // `repoRoot` this is run in.
    const bytes = await deps.git.blobAt(
      workspace.repoRoot,
      pre.headOid,
      change.previousPath ?? change.path,
    )
    if (bytes === undefined) {
      return {
        kind: 'unavailable',
        reason: 'git-unavailable',
        detail:
          'The file was unchanged when the turn started, and its committed content is no longer in the repository.',
      }
    }
    return { kind: 'bytes', bytes, source: 'git-object' }
  }

  /** The after side: the copy `POST` took, or a reason there is none. */
  const resolveAfter = async (
    change: FileChange,
    row: CheckpointPathState | undefined,
  ): Promise<Resolved> => {
    if (change.kind === 'deleted') return { kind: 'absent' }
    if (row === undefined) {
      return {
        kind: 'unavailable',
        reason: 'not-recorded',
        detail: 'The content after this turn was not saved, so there is nothing to compare against.',
      }
    }
    return fromRow(row, 'after')
  }

  const fromRow = async (row: CheckpointPathState, when: 'before' | 'after'): Promise<Resolved> => {
    if (row.blobRef === undefined) {
      return {
        kind: 'unavailable',
        reason: 'not-recorded',
        detail:
          `The content ${when === 'before' ? 'before' : 'after'} this turn was fingerprinted ` +
          'but not saved: it was larger than the size a checkpoint copies.',
      }
    }
    if (!(await deps.store.has(row.blobRef))) {
      return {
        kind: 'unavailable',
        reason: 'missing-blob',
        detail: 'The saved content is no longer in the local store, so it cannot be compared.',
      }
    }
    try {
      return { kind: 'bytes', bytes: await deps.store.get(row.blobRef), source: 'recovery-blob' }
    } catch (error) {
      // `get` re-hashes what it read, so this is corruption rather than absence;
      // either way there is no content to show, and saying which is the
      // difference between a retention setting and a bug report.
      return {
        kind: 'unavailable',
        reason: 'missing-blob',
        detail: `The saved content could not be read: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  return { read }
}

/** The part of a {@link FileDiff} that describes the change rather than a side. */
type DiffHeader = Pick<
  FileDiff,
  'path' | 'previousPath' | 'kind' | 'status' | 'attribution' | 'confidence' | 'baseline'
>

const header = (
  change: FileChange,
  beforeRow: CheckpointPathState | undefined,
  afterRow: CheckpointPathState | undefined,
): DiffHeader => {
  // `POST`'s row speaks for the state the turn ended in; a deleted path only has
  // a `PRE` row, and that one is still the truth about what it was.
  const status = afterRow?.status ?? beforeRow?.status
  return {
    path: change.path,
    ...(change.previousPath === undefined ? {} : { previousPath: change.previousPath }),
    kind: change.kind,
    ...(status === undefined ? {} : { status }),
    attribution: change.attribution,
    confidence: change.confidence,
    baseline: change.baseline,
  }
}

/**
 * The whole-diff answer when either side could not be produced.
 *
 * The sides that were *resolved* are kept, and the ones that were not come back
 * as `unknown` rather than absent: a failure to load a side says nothing about
 * whether the file existed, and a diff panel that drew an empty file for it
 * would be inventing a fact. Keeping the recorded sizes and digests is what lets
 * the panel still say "4 KiB, fingerprint `sha256:…`" about a side whose bytes
 * are gone — the difference between "we did not keep this" and "we know nothing
 * about this".
 */
const failed = (
  change: FileChange,
  beforeRow: CheckpointPathState | undefined,
  afterRow: CheckpointPathState | undefined,
  sides: { readonly before: DiffSide; readonly after: DiffSide } | undefined,
  reason: DiffUnavailableReason,
  detail: string,
): FileDiff => ({
  ...header(change, beforeRow, afterRow),
  before: sides?.before ?? emptySide('unknown', change.beforeHash),
  after: sides?.after ?? emptySide('unknown', change.afterHash),
  availability: { kind: 'unavailable', reason, detail },
})

const emptySide = (source: DiffSource, contentHash?: string): DiffSide => ({
  source,
  byteSize: 0,
  lineCount: 0,
  endsWithNewline: false,
  ...(contentHash === undefined ? {} : { contentHash }),
})

const sideInfo = (resolved: Resolved, contentHash: string | undefined): DiffSide => {
  if (resolved.kind === 'absent') return emptySide('absent')
  // A side we could not read is not an absent one — it is unknown, and the hash
  // the change row recorded is the only thing left to say about it.
  if (resolved.kind === 'unavailable') return emptySide('unknown', contentHash)
  const text = splitLines(resolved.bytes)
  return {
    source: resolved.source,
    byteSize: resolved.bytes.byteLength,
    lineCount: text === undefined ? 0 : text.lines.length,
    endsWithNewline: text?.endsWithNewline ?? false,
    ...(contentHash === undefined ? {} : { contentHash }),
  }
}

/**
 * The lines of a side, or `undefined` when it is binary.
 *
 * The recorded `binary` flag is believed over the sniff when a row exists: the
 * checkpoint decided it over the *whole* file, while the sniff deliberately only
 * looks at the head (see `splitLines`), and a file git calls binary should not be
 * rendered as text just because its NUL byte is late.
 */
const textOf = (
  resolved: Resolved,
  row: CheckpointPathState | undefined,
): DiffText | undefined => {
  if (resolved.kind === 'absent') return { lines: [], endsWithNewline: false }
  // Unreachable: an unavailable side has already been answered above. Returning
  // `undefined` here would mean "binary", so the guard stays explicit rather
  // than relying on the caller's ordering.
  if (resolved.kind === 'unavailable') return undefined
  if (row?.binary === true) return undefined
  return splitLines(resolved.bytes)
}
