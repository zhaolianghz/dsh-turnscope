import type { PathStatus } from '../domain/types.ts'
import type { CommandRunner } from './command-runner.ts'

/**
 * One changed path as `git status --porcelain=v2 -z` reports it.
 *
 * The upstream field names are kept (`mW` is the worktree mode, `hH`/`hI` are
 * the HEAD and index blob ids) because they are what a reader will look up in
 * the format documentation, and renaming them would hide which upstream column
 * each value actually came from.
 */
export interface GitStatusEntry {
  /** Repo-relative, forward-slashed; never quoted, because `-z` is used. */
  readonly path: string
  /** Where a rename came from; only present when `status` is `renamed`. */
  readonly previousPath?: string
  readonly status: PathStatus
  /** True when the index differs from `HEAD`, not when the worktree does. */
  readonly staged: boolean
  /** True for an unmerged entry, which `pathStatus` reports as `modified`. */
  readonly unmerged: boolean
  /** Worktree mode, e.g. `100644`; absent when the worktree has no file. */
  readonly mode?: string
  /** HEAD blob id, when the path is tracked. */
  readonly headOid?: string
  /** Index blob id, when the path is staged. */
  readonly indexOid?: string
}

/** `HEAD`, and the branch it is on when it is not detached. */
export interface GitHead {
  readonly oid: string
  readonly branch?: string
}

/**
 * The only way this plugin reaches Git.
 *
 * Every method names a read operation, and `runGit` refuses a subcommand that
 * is not on {@link ALLOWED_SUBCOMMANDS}. That runtime set is the enforcement of
 * `docs/ARCHITECTURE.md §11.3`: the source-level guard in
 * `tests/host/architecture.spec.ts` pins what the code *says*, and this pins
 * what it can *do*, so a future call site cannot reach a write by assembling an
 * argv the guard's regular expressions did not anticipate.
 *
 * A method returns `undefined` for any non-zero exit rather than a partial
 * value. Git's failure modes are mostly "this question does not apply here" —
 * no commits, no remote, not a repository — and a half-parsed answer to those
 * would be worse than no answer, because the caller stores it.
 */
export interface GitPort {
  /** Whether `cwd` is inside a work tree. */
  isRepository(cwd: string): Promise<boolean>
  /** Absolute, symlink-resolved worktree root. */
  toplevel(cwd: string): Promise<string | undefined>
  /** Absolute, symlink-resolved git common directory (shared across worktrees). */
  commonDir(cwd: string): Promise<string | undefined>
  /** The `origin` URL, verbatim, or `undefined` when there is no remote. */
  canonicalRemote(cwd: string): Promise<string | undefined>
  /** The current commit and branch, or `undefined` in a repository with no commit. */
  head(cwd: string): Promise<GitHead | undefined>
  /** Every changed path, or `undefined` when `git status` could not answer. */
  status(cwd: string): Promise<readonly GitStatusEntry[] | undefined>
  /** The blob id of a worktree file, computed without writing an object. */
  hashObject(cwd: string, path: string): Promise<string | undefined>
  /** The bytes of a stored blob. */
  blob(cwd: string, oid: string): Promise<Uint8Array | undefined>
  /**
   * The bytes a path had in a commit-ish, e.g. `HEAD` or the commit a turn
   * started from.
   *
   * This is how the *before* side of a diff is recovered for a file that was
   * clean when the turn began: no checkpoint copied it, because nothing about it
   * had changed yet, and the committed content is not an approximation of the
   * before state — it **is** the before state. Reads only, like everything else
   * on this port. A path is resolved from the top of the worktree, so a caller
   * should pass the repository root.
   */
  blobAt(cwd: string, treeish: string, path: string): Promise<Uint8Array | undefined>
  /** Resolve a git path such as `MERGE_HEAD`, for in-progress-state detection. */
  gitPath(cwd: string, name: string): Promise<string | undefined>
}

/**
 * The read-only subcommands this port may run.
 *
 * `hash-object` is here but `hash-object -w` is not: hashing a file is how a
 * fingerprint is taken, and `-w` would write a loose object into the user's
 * repository, which is a side effect this slice promises never to have.
 * `config --get` reads a value and cannot write one without `--set`.
 */
const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'rev-parse',
  'status',
  'hash-object',
  'cat-file',
  'symbolic-ref',
  'config',
])

/** Git prints a zero object id to mean "no such object"; it is not a real id. */
const ZERO_OID = /^0{40,64}$/

const oidOrUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value.length === 0 || ZERO_OID.test(value) ? undefined : value

/** Join the tail of a space-split porcelain-v2 line back into a path. */
const pathFrom = (parts: readonly string[], start: number): string | undefined => {
  const path = parts.slice(start).join(' ')
  return path.length === 0 ? undefined : path
}

const statusFromXY = (xy: string, renamed: boolean): PathStatus => {
  if (renamed) return 'renamed'
  const x = xy.charAt(0)
  const y = xy.charAt(1)
  if (x === 'R' || y === 'R') return 'renamed'
  // Precedence matters: `D` beats `M` because a deletion is the fact a recovery
  // plan needs, and an `AM` (added then modified) is still an addition.
  const codes = `${x}${y}`
  if (codes.includes('D')) return 'deleted'
  if (codes.includes('A')) return 'added'
  return 'modified'
}

interface Fields {
  readonly xy: string
  readonly mode: string | undefined
  readonly headOid: string | undefined
  readonly indexOid: string | undefined
}

const fieldsOf = (parts: readonly string[]): Fields | undefined => {
  const xy = parts[1]
  if (xy === undefined) return undefined
  const mW = parts[5]
  return {
    xy,
    mode: mW === undefined || mW === '000000' ? undefined : mW,
    headOid: oidOrUndefined(parts[6]),
    indexOid: oidOrUndefined(parts[7]),
  }
}

const optionalOids = (
  fields: Fields,
): { readonly mode?: string; readonly headOid?: string; readonly indexOid?: string } => ({
  ...(fields.mode === undefined ? {} : { mode: fields.mode }),
  ...(fields.headOid === undefined ? {} : { headOid: fields.headOid }),
  ...(fields.indexOid === undefined ? {} : { indexOid: fields.indexOid }),
})

/**
 * Parse NUL-separated porcelain-v2 output.
 *
 * `-z` is required rather than convenient: the default format quotes a path
 * containing a space or a non-ASCII byte and escapes it C-style, and decoding
 * that back is a recurring source of bugs. With `-z` the path is literal and the
 * only separator is the byte that cannot appear in one.
 *
 * A rename is the reason this is a loop with an index rather than a `map`: type
 * `2` records carry the original path as the *next* NUL-separated field.
 */
export function parseStatusPorcelainV2(input: Uint8Array): readonly GitStatusEntry[] {
  const tokens = Buffer.from(input).toString('utf8').split('\0')
  const entries: GitStatusEntry[] = []

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined || token.length === 0) continue
    const tag = token.charAt(0)

    if (tag === '1') {
      const parts = token.split(' ')
      const fields = fieldsOf(parts)
      const path = pathFrom(parts, 8)
      if (fields === undefined || path === undefined) continue
      entries.push({
        path,
        status: statusFromXY(fields.xy, false),
        staged: fields.xy.charAt(0) !== '.',
        unmerged: false,
        ...optionalOids(fields),
      })
      continue
    }

    if (tag === '2') {
      const parts = token.split(' ')
      const fields = fieldsOf(parts)
      const path = pathFrom(parts, 9)
      const previousPath = tokens[i + 1]
      i += 1
      if (fields === undefined || path === undefined) continue
      entries.push({
        path,
        ...(previousPath === undefined || previousPath.length === 0
          ? {}
          : { previousPath }),
        status: 'renamed',
        staged: fields.xy.charAt(0) !== '.',
        unmerged: false,
        ...optionalOids(fields),
      })
      continue
    }

    if (tag === 'u') {
      const parts = token.split(' ')
      const fields = fieldsOf(parts)
      const path = pathFrom(parts, 10)
      if (fields === undefined || path === undefined) continue
      entries.push({
        path,
        status: 'modified',
        staged: fields.xy.charAt(0) !== '.',
        unmerged: true,
        ...optionalOids(fields),
      })
      continue
    }

    if (tag === '?') {
      const path = token.slice(2)
      if (path.length === 0) continue
      entries.push({ path, status: 'untracked', staged: false, unmerged: false })
    }

    // `!` records are ignored files, which `--ignored=no` already excludes; a
    // tag this build does not know is skipped rather than guessed at.
  }

  return entries
}

/**
 * Build a {@link GitPort} over an injected runner.
 *
 * The runner is a parameter so tests can drive the port through a recording
 * double, and so there is exactly one place — {@link createExecFileRunner} in
 * the production wiring — where a real process is spawned.
 */
export function createGitPort(runner: CommandRunner): GitPort {
  const runGit = async (
    cwd: string,
    args: readonly string[],
  ): Promise<Uint8Array | undefined> => {
    const subcommand = args[0]
    if (subcommand === undefined || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
      throw new Error(`git subcommand not on the read-only allowlist: ${String(subcommand)}`)
    }
    const result = await runner.run(['git', ...args], { cwd })
    if (result.incomplete !== undefined || result.exitCode !== 0) return undefined
    return result.stdout
  }

  const text = async (cwd: string, args: readonly string[]): Promise<string | undefined> => {
    const bytes = await runGit(cwd, args)
    if (bytes === undefined) return undefined
    return Buffer.from(bytes).toString('utf8').trim()
  }

  const isRepository = async (cwd: string): Promise<boolean> =>
    (await text(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true'

  const toplevel = async (cwd: string): Promise<string | undefined> => {
    const path = await text(cwd, ['rev-parse', '--show-toplevel'])
    return path === undefined || path.length === 0 ? undefined : path
  }

  const commonDir = async (cwd: string): Promise<string | undefined> => {
    // `--path-format=absolute` is what keeps a linked worktree's common dir from
    // being reported relative to the worktree, which would make two identities
    // for one repository.
    const path = await text(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    return path === undefined || path.length === 0 ? undefined : path
  }

  const canonicalRemote = async (cwd: string): Promise<string | undefined> => {
    const url = await text(cwd, ['config', '--get', 'remote.origin.url'])
    return url === undefined || url.length === 0 ? undefined : url
  }

  const head = async (cwd: string): Promise<GitHead | undefined> => {
    const oid = await text(cwd, ['rev-parse', 'HEAD'])
    if (oid === undefined || oid.length === 0) return undefined
    // `-q` is what makes a detached HEAD an absent branch instead of a message
    // on stderr; the exit code is the same either way.
    const branch = await text(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
    return { oid, ...(branch === undefined || branch.length === 0 ? {} : { branch }) }
  }

  const status = async (cwd: string): Promise<readonly GitStatusEntry[] | undefined> => {
    // `--untracked-files=all` lists the files inside an untracked directory
    // rather than collapsing it to the directory, because attribution is
    // per-path: `? tests/` cannot say which new test file the agent wrote.
    const bytes = await runGit(cwd, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
    ])
    return bytes === undefined ? undefined : parseStatusPorcelainV2(bytes)
  }

  const hashObject = async (cwd: string, path: string): Promise<string | undefined> => {
    // `--` ends option parsing, so a path beginning with `-` is a path. `-w` is
    // deliberately absent: hashing must not write an object into the repository.
    const oid = await text(cwd, ['hash-object', '--', path])
    return oid === undefined || oid.length === 0 ? undefined : oid
  }

  const blob = async (cwd: string, oid: string): Promise<Uint8Array | undefined> =>
    runGit(cwd, ['cat-file', 'blob', oid])

  /**
   * A file's content at a revision, as `<treeish>:<path>`.
   *
   * `cat-file` resolves that suffix from the top of the worktree whatever `cwd`
   * is — only a path starting `./` or `../` would be relative to it — so a
   * caller should pass the repository root and a repo-relative path, which is
   * what a status entry already holds.
   */
  const blobAt = async (
    cwd: string,
    treeish: string,
    path: string,
  ): Promise<Uint8Array | undefined> => runGit(cwd, ['cat-file', 'blob', `${treeish}:${path}`])

  const gitPath = async (cwd: string, name: string): Promise<string | undefined> => {
    const path = await text(cwd, ['rev-parse', '--git-path', name])
    return path === undefined || path.length === 0 ? undefined : path
  }

  return {
    isRepository,
    toplevel,
    commonDir,
    canonicalRemote,
    head,
    status,
    hashObject,
    blob,
    blobAt,
    gitPath,
  }
}
