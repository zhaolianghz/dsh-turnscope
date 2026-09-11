/**
 * Apply a unified-diff text to a byte buffer and report the result.
 *
 * The function is a pure validator: it does no IO, no clock, no workspace
 * touches. Its job is the "still consistent with the recorded evidence?"
 * question the dry-run asks before a rewind goes live — a `conflict` result
 * means the worktree has drifted since the checkpoint, and a blind overwrite
 * would lose the user's work.
 *
 * The function is also deliberately not the production apply path. The real
 * apply writes bytes straight from the object store after a `stateHash` guard
 * has confirmed the worktree still matches what the planner saw. `applyPatch`
 * exists to catch the case where the planner was right at preview time but
 * something changed before apply — a smaller window, but the cost of being
 * wrong is rewriting the user's edits, so we check.
 */
import type { RecoveryFileOperation } from '../types.ts';
/** Reason a patch could not be applied. */
export type ApplyConflictReason = 'hunk-offset' | 'context-mismatch' | 'binary';
/** Result of attempting to apply a unified-diff text to current bytes. */
export type ApplyPatchResult = {
    kind: 'ok';
    resultBytes: Uint8Array;
} | {
    kind: 'conflict';
    path: string;
    reason: ApplyConflictReason;
};
export interface ApplyPatchInput {
    readonly patch: string;
    readonly currentBytes: Uint8Array;
    readonly path: string;
}
export declare function applyPatch(input: ApplyPatchInput): ApplyPatchResult;
export type { RecoveryFileOperation };
//# sourceMappingURL=apply.d.ts.map