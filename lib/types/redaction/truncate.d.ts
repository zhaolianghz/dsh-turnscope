/** Appended to the text whenever bytes were dropped. */
export declare const TRUNCATION_MARKER = "\u2026[truncated]";
/** Outcome of one truncation. */
export interface TruncateResult {
    /** At most `maxBytes` bytes of UTF-8, never ending mid-codepoint. */
    readonly text: string;
    /** True when bytes were dropped, which is when the marker is appended. */
    readonly truncated: boolean;
    /** Size of the input in bytes, before truncation. */
    readonly originalBytes: number;
}
/**
 * Cut `input` down to at most `maxBytes` bytes of UTF-8.
 *
 * Pure, synchronous and total, like the redactor: it runs in the same write
 * path, so it must not throw and must not emit broken encoding. Byte slicing
 * can land inside a multi-byte codepoint, so the cut walks back to the nearest
 * boundary and the dropped tail is reported by the appended marker rather than
 * surviving as a replacement character. The limit counts bytes, not characters,
 * and it covers the whole result including the marker.
 */
export declare function truncateBytes(input: string, maxBytes: number): TruncateResult;
//# sourceMappingURL=truncate.d.ts.map