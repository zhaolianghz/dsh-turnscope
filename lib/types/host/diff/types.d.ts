/**
 * What a file diff is, as data.
 *
 * A diff is the one part of this product whose *availability* is as interesting
 * as its content (`docs/PRD.md FR-07`, `docs/ARCHITECTURE.md §28.3`). We can only
 * compare two sides when both were recorded, and a checkpoint deliberately does
 * not copy every byte it observes — a large file is fingerprinted and not saved
 * (`§12.1`), a binary file has no lines to compare, and retention can take a blob
 * away after the fact. Each of those has to arrive at the UI as a *reason*, not
 * as an empty diff, or a reader would conclude "nothing changed here" from a
 * comparison that never happened.
 *
 * So the shape is one of three things and never a bare list of hunks: the
 * comparison, the metadata of a comparison that cannot be rendered, or the
 * explanation of why there is no comparison.
 */
import type { Attribution, AttributionConfidence, FileChangeKind, PathStatus } from '../domain/types.ts';
/** What one line is in the comparison. */
export type DiffLineKind = 'context' | 'add' | 'remove';
export interface DiffLine {
    readonly kind: DiffLineKind;
    /** Without its line terminator; see `splitLines` for the CRLF note. */
    readonly text: string;
    /** 1-based line number in the before side; absent on an added line. */
    readonly beforeLine?: number;
    /** 1-based line number in the after side; absent on a removed line. */
    readonly afterLine?: number;
}
/**
 * One run of changes with its surrounding context.
 *
 * The header fields are unified diff's `@@ -beforeStart,beforeCount
 * +afterStart,afterCount @@`, already resolved rather than left as a string for
 * someone to re-parse.
 */
export interface DiffHunk {
    readonly beforeStart: number;
    readonly beforeCount: number;
    readonly afterStart: number;
    readonly afterCount: number;
    readonly lines: readonly DiffLine[];
}
/** Where the bytes on one side of a comparison came from. */
export type DiffSource = 
/** Copied into the object store by the checkpoint that observed it. */
'recovery-blob'
/**
 * Read from the repository's object database, at the commit the turn started
 * from. Only used for a path that was *clean* when the turn began, where the
 * committed content **is** the before state — see `reader.ts`.
 */
 | 'git-object'
/** The file did not exist on this side (it was created, or deleted). */
 | 'absent'
/**
 * The side exists, but its bytes could not be read, so even its size is
 * unknown. Distinct from `absent`: a reader must not conclude "the file was
 * not there" from a side we failed to load.
 */
 | 'unknown';
/** What one side of a comparison was. */
export interface DiffSide {
    readonly source: DiffSource;
    /** Bytes compared; zero for an absent side. */
    readonly byteSize: number;
    /** Lines compared; zero for an absent side or a binary one. */
    readonly lineCount: number;
    /** The recorded digest, when there is one; the evidence the diff rests on. */
    readonly contentHash?: string;
    /**
     * True when this side exists but has no final line terminator.
     *
     * Carried at the side rather than the line so that a reader can be told
     * "the file no longer ends with a newline" — a real change that is otherwise
     * invisible when a renderer appends terminators of its own.
     */
    readonly endsWithNewline: boolean;
}
/**
 * Why a comparison could not be made.
 *
 * Distinguishing these is the point: "we never saved the old bytes" is a
 * property of the capture policy and would be fixed by capturing more, while
 * "the blob we saved is gone" is retention or corruption, and "we could not ask
 * git" is an environment problem. A single `unavailable` would make all three
 * look like the same thing and therefore unsupportable.
 */
export type DiffUnavailableReason = 
/** `PRE` or `POST` is missing, so there is no pair to compare. */
'no-checkpoint'
/** The side existed but its bytes were not copied (over the size limit). */
 | 'not-recorded'
/** A blob was recorded and is no longer in the object store. */
 | 'missing-blob'
/** The clean-at-`PRE` fallback needed the repository and did not get it. */
 | 'git-unavailable';
/** The comparison, or the reason there is none. */
export type DiffAvailability = {
    readonly kind: 'text';
    readonly hunks: readonly DiffHunk[];
    /** True when the hunks are a prefix of the comparison, not all of it. */
    readonly truncated: boolean;
}
/** At least one side is not text; sizes and hashes are still offered. */
 | {
    readonly kind: 'binary';
} | {
    readonly kind: 'unavailable';
    readonly reason: DiffUnavailableReason;
    /** One sentence for the user, written to be shown as-is. */
    readonly detail: string;
};
/** One changed path, with everything the UI needs to render it or explain it. */
export interface FileDiff {
    readonly path: string;
    /** Set when the change is a rename; the before side was read from here. */
    readonly previousPath?: string;
    readonly kind: FileChangeKind;
    /**
     * What the checkpoint called the path after the turn.
     *
     * Optional rather than `| undefined`: this value crosses the host boundary,
     * and the gateway rejects an own property whose value is `undefined` as not
     * JSON-safe. An unknown status has to be *absent*, not present-and-undefined.
     */
    readonly status?: PathStatus;
    /** Whose change this is, carried over so the diff is never read without it. */
    readonly attribution: Attribution;
    readonly confidence: AttributionConfidence;
    /** True when the path was already dirty before the turn began. */
    readonly baseline: boolean;
    readonly before: DiffSide;
    readonly after: DiffSide;
    readonly availability: DiffAvailability;
}
//# sourceMappingURL=types.d.ts.map