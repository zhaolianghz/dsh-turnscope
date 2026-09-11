import type { TurnSummaryDto } from '../shared/contracts/api.ts';
import type { TurnscopeHostApi } from './host-api.ts';
/** What the host has recorded for this session, keyed by turn number. */
export interface RecordedTurns {
    /** Keyed by `ordinal`, which is the number the conversation also counts in. */
    readonly turns: ReadonlyMap<number, TurnSummaryDto>;
    /** Absent when the host answered. Explanatory, never technical, when it did not. */
    readonly problem?: string;
}
export interface RecordedTurnsFeed {
    /** Absent until the first answer for *this* session has arrived. */
    readonly state: RecordedTurns | undefined;
    /** Ask again. Cheap enough to be a button, and the only way out of `stale`. */
    readonly refresh: () => void;
}
/**
 * Ask the host once per session, and again when asked.
 *
 * The answer is stored with the session it belongs to rather than cleared when
 * the session changes. Two things fall out of that: a swap to another session
 * shows nothing until its own answer lands — the old rows are for a different
 * conversation and their turn numbers mean nothing here — while a **refresh**
 * keeps the badges that are already on screen instead of blinking them out and
 * back for a turn that did not change.
 *
 * `undefined` while the first answer is in flight, so the view renders what it
 * already knows rather than an empty frame that would then fill in — a shift from
 * "no safety information" to "safety information" is worse than a moment of
 * neither.
 */
export declare function useRecordedTurns(host: TurnscopeHostApi, sessionId: string): RecordedTurnsFeed;
//# sourceMappingURL=recorded-turns.d.ts.map