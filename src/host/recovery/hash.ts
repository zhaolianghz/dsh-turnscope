/**
 * Compute a "state hash" for a workspace at a moment in time, per
 * `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §5.4`.
 *
 * The hash has two jobs:
 *
 * 1. **Preview → Apply drift detection.** The planner hashes the worktree
 *    state it saw at preview time; the apply runner hashes again right before
 *    touching the file system. Any difference rejects the apply (`RECOVERY_STALE`)
 *    rather than silently overwriting work the user did between Preview and
 *    Confirm.
 *
 * 2. **Determinism for plan ids.** The same workspace state must produce the
 *    same hash on the same input, so that two previews of the same turn land
 *    on the same plan row when nothing has changed in between.
 *
 * What the hash covers:
 *
 * - Workspace identity (`workspaceId`) — different worktrees, different hashes.
 * - Git context (`headOid`, `branch`, `worktreePath`) — moving HEAD between
 *   previews is the same kind of event as the user editing a file, because
 *   either could invalidate the plan's assumption about file content.
 * - Per-path content hashes — only the paths the recovery plan actually
 *   touches, so unrelated edits do not invalidate a clean rewind.
 *
 * What the hash deliberately does **not** cover:
 *
 * - The blob bytes themselves — the planner has already snapshotted them in
 *   `checkpoint_paths.blob_ref`, and the hash is about *current* state, not
 *   historical. Reading every blob just to hash it would double the IO cost of
 *   every preview.
 * - Anything outside `relevantPaths` — a stray edit to a README is none of
 *   the rewind's business.
 */

import { createHash } from 'node:crypto'

/** The minimal git context a worktree must report for the hash to be sound. */
export interface GitContext {
  /** Commit oid of the branch's tip when the hash was taken. */
  readonly headOid: string
  /** Branch name; empty for detached HEAD. */
  readonly branch: string
  /** Filesystem path to the worktree root (absolute). */
  readonly worktreePath: string
}

/** Per-path state included in the hash. */
export interface RelevantPath {
  /** Repo-relative, forward-slashed. */
  readonly path: string
  /** Blob content hash (`git hash-object`-style hex), or absent for untracked. */
  readonly contentHash: string | undefined
  /** True when the path is staged in the index. */
  readonly staged: boolean
}

export interface StateHashInput {
  readonly workspaceId: string
  readonly git: GitContext
  readonly relevantPaths: readonly RelevantPath[]
}

/**
 * Produce a stable, deterministic encoding of the input.
 *
 * The encoding is `key=value\n` for each field, sorted by key, joined with a
 * separator. The exact format is not a contract — what matters is that the
 * same input always produces the same hash, and any change in any field
 * produces a different hash. Sorting by key prevents a path-order change from
 * looking like a state change.
 */
function canonicalize(input: StateHashInput): string {
  const parts: string[] = []
  parts.push(`workspaceId=${input.workspaceId}`)
  parts.push(`headOid=${input.git.headOid}`)
  parts.push(`branch=${input.git.branch}`)
  parts.push(`worktreePath=${input.git.worktreePath}`)
  const sorted = [...input.relevantPaths].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const p of sorted) {
    parts.push(`path=${p.path}`)
    parts.push(`contentHash=${p.contentHash ?? ''}`)
    parts.push(`staged=${p.staged ? '1' : '0'}`)
  }
  return parts.join('\n')
}

/**
 * Compute the state hash. Returns the canonical form `sha256:<64 hex>` so
 * callers can compare strings directly without worrying about whether the
 * algorithm was upgraded later — the prefix forces them to notice.
 */
export function computeStateHash(input: StateHashInput): string {
  const enc = canonicalize(input)
  const digest = createHash('sha256').update(enc, 'utf8').digest('hex')
  return `sha256:${digest}`
}