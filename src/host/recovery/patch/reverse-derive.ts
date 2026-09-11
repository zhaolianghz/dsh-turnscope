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

import type { DiffHunk } from '../../diff/types.ts'
import { splitLines, unifiedDiff, DEFAULT_DIFF_OPTIONS } from '../../diff/unified.ts'

/** Input to {@link reverseDerive}. Exactly one of `beforeBytes` / `afterBytes` may be `null`. */
export interface ReverseDeriveInput {
  readonly path: string
  /** Bytes of the file before the turn; `null` when the turn created the file. */
  readonly beforeBytes: Uint8Array | null
  /** Bytes of the file after the turn; `null` when the turn deleted the file. */
  readonly afterBytes: Uint8Array | null
}

/** Output of {@link reverseDerive}, both texts rendered for direct display / apply. */
export interface ReverseDeriveOutput {
  /** Unified diff PRE → POST (what the turn did). Empty when the bytes are identical. */
  readonly forwardText: string
  /** Unified diff POST → PRE (the inverse; what apply uses to validate a clean worktree). */
  readonly reverseText: string
  /** Number of hunks in the forward diff. `0` for no-op cases. */
  readonly forwardHunkCount: number
  /** The forward hunks themselves, structured; the UI can render these without re-parsing text. */
  readonly forwardHunks: readonly DiffHunk[]
}

/**
 * Build a unified-diff text from a header and structured hunks.
 *
 * The V0.1 engine already produces hunks with the correct line counts; this
 * helper turns them into the textual wire format `applyPatch` parses, and that
 * the user sees in the file diff view.
 */
function renderUnified(path: string, hunks: readonly DiffHunk[], reverse: boolean): string {
  if (hunks.length === 0) return ''
  // Reverse hunks swap `beforeStart`/`afterStart` because the direction is
  // reversed (the POST side is now the "old" side).
  const out: string[] = [`--- ${path}`, `+++ ${path}`]
  for (const h of hunks) {
    const beforeStart = reverse ? h.afterStart : h.beforeStart
    const beforeCount = reverse ? h.afterCount : h.beforeCount
    const afterStart = reverse ? h.beforeStart : h.afterStart
    const afterCount = reverse ? h.beforeCount : h.afterCount
    out.push(`@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`)
    for (const line of h.lines) {
      const prefix =
        line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
      out.push(prefix + line.text)
    }
  }
  return out.join('\n') + '\n'
}

/**
 * Project hunks from the forward direction (PRE → POST) onto the reverse
 * direction (POST → PRE). The mapping is the same as `applyPatch` parsing in
 * reverse: a line `add`ed by the turn is `remove`d by the rewind, and vice
 * versa; `beforeStart` / `afterStart` swap places.
 */
function reverseProjection(hunks: readonly DiffHunk[]): readonly DiffHunk[] {
  return hunks.map(h => ({
    beforeStart: h.afterStart,
    beforeCount: h.afterCount,
    afterStart: h.beforeStart,
    afterCount: h.beforeCount,
    lines: h.lines.map(l => {
      if (l.kind === 'add') return { kind: 'remove' as const, text: l.text }
      if (l.kind === 'remove') return { kind: 'add' as const, text: l.text }
      return l
    }),
  }))
}

export function reverseDerive(input: ReverseDeriveInput): ReverseDeriveOutput {
  const { path, beforeBytes, afterBytes } = input

  // The four cases the engine can produce:
  // - both present: a normal PRE → POST diff.
  // - before null: file created by the turn — forward adds every line, reverse
  //   removes every line.
  // - after null: file deleted by the turn — forward removes every line,
  //   reverse adds every line.
  // - both null: impossible (the caller should never ask).
  if (beforeBytes === null && afterBytes === null) {
    return { forwardText: '', reverseText: '', forwardHunkCount: 0, forwardHunks: [] }
  }

  if (beforeBytes === null) {
    // File created. Forward adds everything; reverse removes everything.
    const afterText = splitLines(afterBytes!) ?? { lines: [], endsWithNewline: true }
    const forwardHunks: DiffHunk[] =
      afterText.lines.length === 0
        ? []
        : [
            {
              beforeStart: 0,
              beforeCount: 0,
              afterStart: 1,
              afterCount: afterText.lines.length,
              lines: afterText.lines.map(t => ({ kind: 'add' as const, text: t, afterLine: 1 })),
            },
          ]
    const reverseHunks = reverseProjection(forwardHunks)
    return {
      forwardText: renderUnified(path, forwardHunks, false),
      reverseText: renderUnified(path, reverseHunks, false),
      forwardHunkCount: forwardHunks.length,
      forwardHunks,
    }
  }

  if (afterBytes === null) {
    // File deleted. Forward removes everything; reverse adds everything.
    const beforeText = splitLines(beforeBytes) ?? { lines: [], endsWithNewline: true }
    const forwardHunks: DiffHunk[] =
      beforeText.lines.length === 0
        ? []
        : [
            {
              beforeStart: 1,
              beforeCount: beforeText.lines.length,
              afterStart: 0,
              afterCount: 0,
              lines: beforeText.lines.map(t => ({
                kind: 'remove' as const,
                text: t,
                beforeLine: 1,
              })),
            },
          ]
    const reverseHunks = reverseProjection(forwardHunks)
    return {
      forwardText: renderUnified(path, forwardHunks, false),
      reverseText: renderUnified(path, reverseHunks, false),
      forwardHunkCount: forwardHunks.length,
      forwardHunks,
    }
  }

  // Both bytes present — the normal case.
  const before = splitLines(beforeBytes)
  const after = splitLines(afterBytes)
  if (before === undefined || after === undefined) {
    // Binary on one side. Treat the whole file as replaced: forward hunks say
    // "remove all / add all", reverse the inverse. This is honest — a diff
    // viewer will show the user "binary changed" and `applyPatch` will refuse.
    const totalLines = after?.lines.length ?? before?.lines.length ?? 0
    const lines = after?.lines ?? before?.lines ?? []
    const forwardHunks: DiffHunk[] =
      totalLines === 0
        ? []
        : [
            {
              beforeStart: 1,
              beforeCount: before?.lines.length ?? 0,
              afterStart: 1,
              afterCount: after?.lines.length ?? 0,
              lines: lines.map(t => ({ kind: 'remove' as const, text: t })),
            },
          ]
    const reverseHunks = reverseProjection(forwardHunks)
    return {
      forwardText: renderUnified(path, forwardHunks, false),
      reverseText: renderUnified(path, reverseHunks, false),
      forwardHunkCount: forwardHunks.length,
      forwardHunks,
    }
  }

  const forward = unifiedDiff(before, after, DEFAULT_DIFF_OPTIONS)
  const reverseHunks = reverseProjection(forward.hunks)
  return {
    forwardText: renderUnified(path, forward.hunks, false),
    reverseText: renderUnified(path, reverseHunks, false),
    forwardHunkCount: forward.hunks.length,
    forwardHunks: forward.hunks,
  }
}