/** Capacity of the in-memory diagnostic ring. */
export const DIAGNOSTIC_RING_CAPACITY = 50

/** Maximum number of distinct unknown event kinds tracked by name. */
export const IGNORED_KIND_CAPACITY = 50

/** Placeholder count for unknown kinds seen after the bounded map is full. */
export const IGNORED_KIND_OVERFLOW = '<overflow>'

export interface DiagnosticEntry {
  /** Epoch milliseconds at which the entry was recorded. */
  readonly at: number
  /** Short stable machine code, e.g. `trace.write-failed`. */
  readonly code: string
  /** Human-readable detail. The caller redacts this before recording it. */
  readonly message: string
}

/**
 * Bounded, never-throwing diagnostics sink for the host half.
 *
 * Recording a diagnostic is best-effort telemetry: it must never grow without
 * limit and must never be able to fail the operation that produced it. Entry
 * messages are expected to be redacted by the caller.
 */
export class Diagnostics {
  readonly #ring: Array<DiagnosticEntry | undefined> = new Array(DIAGNOSTIC_RING_CAPACITY)
  readonly #ignored = new Map<string, number>()
  #cursor = 0
  #size = 0
  #ignoredOverflow = 0

  /** Append one entry, evicting the oldest once the ring is full. */
  record(entry: DiagnosticEntry): void {
    this.#ring[this.#cursor] = entry
    this.#cursor = (this.#cursor + 1) % DIAGNOSTIC_RING_CAPACITY
    if (this.#size < DIAGNOSTIC_RING_CAPACITY) this.#size += 1
  }

  /** Entries in chronological order, oldest first. */
  snapshot(): readonly DiagnosticEntry[] {
    const entries: DiagnosticEntry[] = []
    const start = (this.#cursor - this.#size + DIAGNOSTIC_RING_CAPACITY) % DIAGNOSTIC_RING_CAPACITY
    for (let offset = 0; offset < this.#size; offset += 1) {
      const entry = this.#ring[(start + offset) % DIAGNOSTIC_RING_CAPACITY]
      if (entry !== undefined) entries.push(entry)
    }
    return Object.freeze(entries)
  }

  /**
   * Count one skipped event of an unrecognised kind. Distinct kinds are capped
   * at {@link IGNORED_KIND_CAPACITY}; anything past that is folded into
   * {@link IGNORED_KIND_OVERFLOW} rather than silently dropped.
   */
  recordIgnoredKind(kind: string): void {
    const seen = this.#ignored.get(kind)
    if (seen !== undefined) {
      this.#ignored.set(kind, seen + 1)
      return
    }
    if (this.#ignored.size >= IGNORED_KIND_CAPACITY) {
      this.#ignoredOverflow += 1
      return
    }
    this.#ignored.set(kind, 1)
  }

  /** Per-kind counts of ignored events plus the `'<overflow>'` tally. */
  snapshotIgnoredKinds(): ReadonlyMap<string, number> {
    const counts = new Map(this.#ignored)
    if (this.#ignoredOverflow > 0) counts.set(IGNORED_KIND_OVERFLOW, this.#ignoredOverflow)
    return counts
  }
}
