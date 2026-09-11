/**
 * Derive a forward and reverse unified diff from two raw byte buffers.
 *
 * Per `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §5.2`
 * ("lazy diff"): V0.2 never persists a patch — the bytes live in
 * `checkpoint_paths.blob_ref` (one ref for the pre side, one for the post),
 * and the patch is re-derived on demand by this function. That keeps the
 * apply path simple: `applyPatch` validates against the current worktree
 * state, but the bytes the user actually wants back are read straight from
 * the object store, never re-encoded through a unified diff format.
 *
 * The forward direction is what the UI shows the user ("here is what changed
 * during the turn"); the reverse direction is what the apply path uses as a
 * sanity check ("the worktree still looks like what we expected — apply this
 * reversal to verify"). They are computed symmetrically.
 */
import type { DiffHunk } from '../../diff/types.ts';
/** Input to {@link reverseDerive}. Exactly one of `beforeBytes` / `afterBytes` may be `null`. */
export interface ReverseDeriveInput {
    readonly path: string;
    /** Bytes of the file before the turn; `null` when the turn created the file. */
    readonly beforeBytes: Uint8Array | null;
    /** Bytes of the file after the turn; `null` when the turn deleted the file. */
    readonly afterBytes: Uint8Array | null;
}
/** Output of {@link reverseDerive}, both texts rendered for direct display / apply. */
export interface ReverseDeriveOutput {
    /** Unified diff PRE → POST (what the turn did). Empty when the bytes are identical. */
    readonly forwardText: string;
    /** Unified diff POST → PRE (the inverse; what apply uses to validate a clean worktree). */
    readonly reverseText: string;
    /** Number of hunks in the forward diff. `0` for no-op cases. */
    readonly forwardHunkCount: number;
    /** The forward hunks themselves, structured; the UI can render these without re-parsing text. */
    readonly forwardHunks: readonly DiffHunk[];
}
export declare function reverseDerive(input: ReverseDeriveInput): ReverseDeriveOutput;
//# sourceMappingURL=reverse-derive.d.ts.map