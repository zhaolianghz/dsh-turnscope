/** Capacity of the in-memory diagnostic ring. */
export declare const DIAGNOSTIC_RING_CAPACITY = 50;
/** Maximum number of distinct unknown event kinds tracked by name. */
export declare const IGNORED_KIND_CAPACITY = 50;
/** Placeholder count for unknown kinds seen after the bounded map is full. */
export declare const IGNORED_KIND_OVERFLOW = "<overflow>";
export interface DiagnosticEntry {
    /** Epoch milliseconds at which the entry was recorded. */
    readonly at: number;
    /** Short stable machine code, e.g. `trace.write-failed`. */
    readonly code: string;
    /** Human-readable detail. The caller redacts this before recording it. */
    readonly message: string;
}
/**
 * Bounded, never-throwing diagnostics sink for the host half.
 *
 * Recording a diagnostic is best-effort telemetry: it must never grow without
 * limit and must never be able to fail the operation that produced it. Entry
 * messages are expected to be redacted by the caller.
 */
export declare class Diagnostics {
    #private;
    /** Append one entry, evicting the oldest once the ring is full. */
    record(entry: DiagnosticEntry): void;
    /** Entries in chronological order, oldest first. */
    snapshot(): readonly DiagnosticEntry[];
    /**
     * Count one skipped event of an unrecognised kind. Distinct kinds are capped
     * at {@link IGNORED_KIND_CAPACITY}; anything past that is folded into
     * {@link IGNORED_KIND_OVERFLOW} rather than silently dropped.
     */
    recordIgnoredKind(kind: string): void;
    /** Per-kind counts of ignored events plus the `'<overflow>'` tally. */
    snapshotIgnoredKinds(): ReadonlyMap<string, number>;
}
//# sourceMappingURL=diagnostics.d.ts.map