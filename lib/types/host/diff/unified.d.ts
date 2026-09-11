/**
 * A unified diff, computed from two lists of lines.
 *
 * Pure by construction: no IO, no clock, no workspace. The bytes are somebody
 * else's problem (`reader.ts` fetches them, and has to explain itself when it
 * cannot), which is what makes this file testable as prose — every case below is
 * a table row rather than a fixture repository.
 *
 * ## What this is for, and what it is not
 *
 * It renders a diff for a human. It is **not** the source of a patch: V0.1 does
 * not write to the workspace, and V0.2's inverse patch will be built from the
 * recorded bytes, not from rendered text. That distinction buys a real
 * simplification here — line endings are normalized for comparison (see
 * {@link splitLines}), because a worktree with CRLF line endings and a git blob
 * with LF are the *same change* to a reader and a whole-file rewrite to a
 * byte-comparing differ.
 *
 * ## Why the caps exist
 *
 * A diff is the one output whose size is not bounded by its input: a one-line
 * change to a large file is small, but a rewritten large file produces every
 * line twice. The reply crosses a process boundary into a browser, so it needs a
 * ceiling, and the ceiling has to be *visible* rather than silent — a diff that
 * stopped early without saying so would be a lie about the turn.
 */
import type { DiffHunk } from './types.ts';
/** How many unchanged lines surround a change, per unified diff convention. */
export declare const DIFF_CONTEXT_LINES = 3;
/**
 * Ceiling on the number of diff lines in one reply.
 *
 * Large enough for a real edit in a large file, small enough that a rewritten
 * vendored bundle does not cross the API boundary. When it bites, the reply says
 * so (`truncated`) instead of quietly ending.
 */
export declare const DIFF_MAX_LINES = 2000;
/**
 * How far the two sides may be apart before the minimal script is abandoned.
 *
 * The search is Myers' `O(ND)`, where `D` is the number of lines that differ,
 * and the backtracking trace costs `D²`. A normal edit is single-digit `D`
 * however large the file is — changing one line in a fifty-thousand line file is
 * `D = 2`, because the common prefix and suffix are trimmed first. Only a
 * rewrite reaches this, and the right answer then is one replace hunk and a
 * `truncated` flag rather than a trace that would not fit in memory.
 */
export declare const DIFF_MAX_EDITS = 1024;
/** One side of a comparison: its lines, and whether it ended with a newline. */
export interface DiffText {
    readonly lines: readonly string[];
    /**
     * False when the last line has no line terminator.
     *
     * Worth carrying separately rather than folding into the line list: "the file
     * ends without a newline" is a real change a reader wants to see (a diff tool
     * prints `\ No newline at end of file`) and it is invisible if the splitter
     * appends one to make the shapes uniform.
     */
    readonly endsWithNewline: boolean;
}
export interface UnifiedDiffOptions {
    readonly contextLines: number;
    readonly maxLines: number;
    readonly maxEdits: number;
}
/** Defaults for {@link unifiedDiff}, exposed so a caller can deviate knowingly. */
export declare const DEFAULT_DIFF_OPTIONS: UnifiedDiffOptions;
export interface UnifiedDiff {
    readonly hunks: readonly DiffHunk[];
    /** True when {@link UnifiedDiff.hunks} is not the whole story. */
    readonly truncated: boolean;
}
/**
 * Split raw bytes into lines, or report that they are not text.
 *
 * `undefined` means binary, using git's own heuristic — a NUL byte in the first
 * part of the file — because the alternative (an encoding guess) would show a
 * reader mojibake and call it a diff.
 *
 * A trailing `\r` is stripped from every line. That is deliberate and is the one
 * lossy step in this module: `git cat-file` returns LF for a file that the
 * worktree holds as CRLF under `core.autocrlf`, so without it a one-line edit
 * would render as a whole-file rewrite. The cost is that the rendered diff
 * cannot distinguish a line-ending change from no change at all; the safety
 * engine never sees a diff, so nothing downstream inherits the imprecision.
 */
export declare function splitLines(bytes: Uint8Array): DiffText | undefined;
/**
 * Compare two line lists and return unified hunks.
 *
 * The common prefix and suffix are trimmed first, which is what makes the cost
 * proportional to the *change* rather than to the file: the search below only
 * ever sees the lines between the first and last difference.
 */
export declare function unifiedDiff(before: DiffText, after: DiffText, options?: UnifiedDiffOptions): UnifiedDiff;
//# sourceMappingURL=unified.d.ts.map