import type { ActivityRecord, TurnRecord } from '../../domain/types.ts';
import type { NormalizedActivity } from './normalize.ts';
/**
 * How many not-yet-placeable events the assembler holds.
 *
 * Bounded because the buffer is only ever a hand-off delay for events whose
 * `turn/start` is a few milliseconds behind them. An unbounded buffer would
 * turn a session whose turns never open — a plugin that publishes events under
 * an unknown turn number, a malformed upstream — into a memory leak, and a
 * leak in the recorder is a leak in the harness process.
 */
export declare const BUFFER_CEILING = 256;
/** The records one ingested event asks the caller to persist. */
export interface AssemblerOutput {
    /** Turns whose row changed; at most one per event, plus none for a buffered one. */
    readonly turns: readonly TurnRecord[];
    /** Activities to append, in the order they were observed. */
    readonly activities: readonly ActivityRecord[];
    /** True when the event contributed nothing and could not be deferred either. */
    readonly ignored: boolean;
    /** Events shed by this call because the buffer was full. */
    readonly dropped: number;
}
export interface TurnAssembler {
    /**
     * Fold one normalized event into the turn state and hand back the records to
     * persist. `undefined` — an upstream type this build does not recognise —
     * is an ignored event, not an error.
     */
    ingest(event: NormalizedActivity | undefined): AssemblerOutput;
    /** How many events are held for a turn that has not opened yet. */
    pendingCount(): number;
}
/**
 * Build a turn assembler: the state machine that turns a stream of normalized
 * events into turn and activity records.
 *
 * Holds only in-memory state and performs no I/O — nothing here awaits, reads
 * or writes — which is what makes the whole state machine testable without a
 * database, and what keeps a slow disk off the harness's synchronous emit path.
 *
 * It is also the layer that *owns* the transition graph rather than merely
 * absorbing post-terminal updates: `transitionTurn` is deliberately permissive
 * (`pending → failed` is allowed there), so this is where the diagram of
 * `docs/ARCHITECTURE.md §3.3` is actually decided. It emits `running` only for
 * a `turn/start` and a terminal status only for a `turn/end`, and never
 * downgrades a turn it has already finished — the same guard `TraceRepository`
 * cannot apply in SQL without discarding the count fields this layer updates.
 */
export declare function createTurnAssembler(): TurnAssembler;
//# sourceMappingURL=assembler.d.ts.map