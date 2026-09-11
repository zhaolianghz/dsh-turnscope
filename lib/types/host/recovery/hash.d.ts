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
/** The minimal git context a worktree must report for the hash to be sound. */
export interface GitContext {
    /** Commit oid of the branch's tip when the hash was taken. */
    readonly headOid: string;
    /** Branch name; empty for detached HEAD. */
    readonly branch: string;
    /** Filesystem path to the worktree root (absolute). */
    readonly worktreePath: string;
}
/** Per-path state included in the hash. */
export interface RelevantPath {
    /** Repo-relative, forward-slashed. */
    readonly path: string;
    /** Blob content hash (`git hash-object`-style hex), or absent for untracked. */
    readonly contentHash: string | undefined;
    /** True when the path is staged in the index. */
    readonly staged: boolean;
}
export interface StateHashInput {
    readonly workspaceId: string;
    readonly git: GitContext;
    readonly relevantPaths: readonly RelevantPath[];
}
/**
 * Compute the state hash. Returns the canonical form `sha256:<64 hex>` so
 * callers can compare strings directly without worrying about whether the
 * algorithm was upgraded later — the prefix forces them to notice.
 */
export declare function computeStateHash(input: StateHashInput): string;
//# sourceMappingURL=hash.d.ts.map