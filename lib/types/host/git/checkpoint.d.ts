import type { CheckpointPathState, CheckpointPhase, CheckpointRecord } from '../domain/types.ts';
import type { ObjectStore } from '../storage/object-store.ts';
import type { TraceRepository } from '../storage/repository.ts';
import type { GitPort } from './git-port.ts';
/** The storage operations a capture performs. */
export type CheckpointSink = Pick<TraceRepository, 'putCheckpoint' | 'putCheckpointPath' | 'putObjectRecord'>;
/** What a capture needs from its environment. */
export interface CheckpointDeps {
    readonly git: GitPort;
    readonly store: ObjectStore;
    readonly sink: CheckpointSink;
    /**
     * Files larger than this are fingerprinted but not copied.
     *
     * The hash still goes into `fileDigests`, so drift on a large file is still
     * detectable; what is lost is the ability to put the bytes back, which is why
     * the checkpoint's `completeness` drops to `partial` rather than staying
     * `complete`.
     */
    readonly maxBlobBytes: number;
    /** Paths never observed, matched by exact path or directory prefix. */
    readonly ignorePaths: readonly string[];
}
/** One checkpoint to take. */
export interface CaptureCheckpointInput {
    readonly workspaceId: string;
    /** Symlink-resolved worktree root, as {@link RepositoryIdentity} reports it. */
    readonly repoRoot: string;
    readonly turnId: string;
    readonly phase: CheckpointPhase;
    /**
     * Paths a tool hint named. They are unioned with what git reports as changed,
     * because a file the agent touched and then restored to its old content is
     * still evidence about the turn even though `git status` no longer shows it.
     */
    readonly hintedPaths?: readonly string[];
    /** Epoch milliseconds; injectable so a test can pin the timestamp. */
    readonly now?: number;
}
/** The records one capture produced, already persisted. */
export interface CheckpointCapture {
    readonly record: CheckpointRecord;
    readonly paths: readonly CheckpointPathState[];
    /** Paths whose bytes were stored, sorted. */
    readonly capturedPaths: readonly string[];
}
/**
 * Convert an absolute or relative path to a repository-relative one, or reject
 * it. This is `docs/ARCHITECTURE.md §34.2`'s first two steps — normalize, then
 * prove it stays inside the root — applied before any path reaches the
 * filesystem.
 */
export declare function toRepoRelative(root: string, candidate: string): string | undefined;
/**
 * The absolute path of `candidate` only when it is provably inside `root`.
 *
 * The prefix check is on the separator, not on the bare root string: without
 * it, `/repo-other` would pass as a descendant of `/repo`.
 */
export declare function resolveWithin(root: string, candidate: string): string | undefined;
/** Whether a repo-relative path falls under an ignore entry. */
export declare function isIgnored(path: string, ignorePaths: readonly string[]): boolean;
/**
 * Why a checkpoint could not be taken.
 *
 * Exported rather than spelled inline at both the producer and the consumer, so
 * a safety rule can name "the workspace is not a repository" without matching on
 * a string someone may reword later.
 */
export declare const CHECKPOINT_FAILURE: {
    /** The path is not inside a Git worktree at all (`§14.1` S009). */
    readonly NOT_A_REPOSITORY: "not a git worktree";
    /** `git status` ran and failed, which is different from having no changes. */
    readonly STATUS_UNAVAILABLE: "git status unavailable";
};
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
export declare function captureCheckpoint(deps: CheckpointDeps, input: CaptureCheckpointInput): Promise<CheckpointCapture>;
//# sourceMappingURL=checkpoint.d.ts.map