/**
 * The apply runner, per
 * `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §5.5`–§5.7`.
 *
 * The runner is the only component that touches the worktree. It does so
 * with three rules that together form a hard guarantee: either every
 * `restore` and `recreate_deleted_file` op has landed and the result has
 * been verified, or the workspace has been rolled back to its pre-apply
 * state. There is no in-between, because the journal either says "applied"
 * for every op or it does not.
 *
 * The atomicity comes from `rename`, which is the POSIX renameat(2) call:
 * the kernel guarantees that a successful rename is visible to every
 * concurrent reader as either the old file or the new file, never neither.
 * `fsync` on the directory makes that visibility durable across a crash.
 *
 * The runner refuses to call git. There is no `git apply`, no
 * `git checkout`, no `git reset --hard`. The plan comes from
 * `stateHash`-guarded evidence, and the runner writes the bytes straight from
 * the object store; if the user wants a `git` operation they can do one
 * after the apply has returned.
 */
import type { ObjectStore } from '../../storage/object-store.ts';
import type { RecoveryFileOperation, RecoveryPlan, RecoveryResult } from '../types.ts';
/** Counter used to give every journal entry a stable, monotonic `seq`. */
export interface ApplyClock {
    nextSeq(): number;
    nowMs(): number;
}
/** What the runner needs from the live world. */
export interface ApplyLiveContext {
    /**
     * Hash the bytes that are *currently* on disk at `path`. `null` means the
     * file does not exist (deleted). Used for the drift guard before each
     * `restore` op.
     */
    readonly hashCurrent: (path: string) => Promise<string | null>;
    /**
     * Read the bytes currently on disk at `path`. Used for the `applyPatch`
     * structural check that runs after `restore` writes the bytes.
     */
    readonly readCurrent: (path: string) => Promise<Uint8Array | null>;
}
/** Result of a single op within the apply. */
export type ApplyOpResult = {
    kind: 'applied';
    op: RecoveryFileOperation;
} | {
    kind: 'rolled_back';
    op: RecoveryFileOperation;
    reason: string;
} | {
    kind: 'failed';
    op: RecoveryFileOperation;
    reason: string;
};
export interface ApplyRunInput {
    readonly plan: RecoveryPlan;
    readonly worktreeRoot: string;
    /** Data root of the recovery store — the journal lives under this. */
    readonly homeDir: string;
    readonly objectStore: ObjectStore;
    readonly live: ApplyLiveContext;
    readonly clock: ApplyClock;
}
/**
 * Run the apply. Every op is journaled at three checkpoints:
 *
 * - `applied` once the bytes are on disk in the worktree.
 * - `verified` once the post-apply reverse-apply (using `applyPatch` on the
 *   pre bytes) confirms the file's content hash matches the pre bytes.
 * - `rolled_back` if verification fails and we restored the original file
 *   from a backup.
 *
 * The journal is the only place a crashed apply is recorded; on next boot
 * the host reads it and surfaces the partial apply to the user.
 */
export declare function runApply(input: ApplyRunInput): Promise<RecoveryResult>;
//# sourceMappingURL=apply.d.ts.map