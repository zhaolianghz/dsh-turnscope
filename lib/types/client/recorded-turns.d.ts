import type { SafetySummaryDto } from '../shared/contracts/api.ts';
import type { TurnscopeHostApi } from './host-api.ts';
/** What the view hangs off a turn number, and what to say when there is none. */
export interface RecordedTurns {
    /** Keyed by `ordinal`, which is the number the conversation also counts in. */
    readonly safety: ReadonlyMap<number, SafetySummaryDto>;
    /** Absent when the host answered. Explanatory, never technical, when it did not. */
    readonly problem?: string;
}
/**
 * Ask the host once per session, and again if the session changes.
 *
 * `undefined` while the answer is in flight, so the view renders what it already
 * knows rather than an empty frame that would then fill in — a shift from "no
 * safety information" to "safety information" is worse than a moment of neither.
 */
export declare function useRecordedTurns(host: TurnscopeHostApi, sessionId: string): RecordedTurns | undefined;
//# sourceMappingURL=recorded-turns.d.ts.map