/**
 * The model's vocabulary, keyed by the model's own values.
 *
 * These maps exist so that a label is a *total* function of a value: `satisfies
 * Record<Union, TurnscopeKey>` makes a missing case a compile error, and there is
 * no default branch where an unknown value would silently render as nothing. The
 * unions are read off the contract's shapes rather than restated (see
 * `TurnscopeView.tsx`), so adding a level or an action on the host side breaks the
 * client build instead of shipping a blank chip.
 */
import type { TurnSummaryDto } from '../shared/contracts/api.ts';
import type { TurnscopeKey } from './locales.ts';
export declare const STATUS_KEYS: {
    readonly running: "status.running";
    readonly completed: "status.completed";
    readonly failed: "status.failed";
    readonly 'max-tokens': "status.maxTokens";
};
export declare const LEVEL_KEYS: {
    readonly SAFE: "safety.SAFE";
    readonly CAUTION: "safety.CAUTION";
    readonly FORK_ONLY: "safety.FORK_ONLY";
    readonly UNPROTECTED: "safety.UNPROTECTED";
};
export declare const ACTION_KEYS: {
    readonly INSPECT: "action.INSPECT";
    readonly PREVIEW_REWIND: "action.PREVIEW_REWIND";
    readonly REWIND: "action.REWIND";
    readonly FORK: "action.FORK";
    readonly NONE: "action.NONE";
};
export declare const ATTRIBUTION_KEYS: {
    readonly AGENT: "attribution.AGENT";
    readonly BASELINE: "attribution.BASELINE";
    readonly DRIFT: "attribution.DRIFT";
    readonly UNCERTAIN: "attribution.UNCERTAIN";
};
export declare const EVIDENCE_KEYS: {
    readonly complete: "evidence.complete";
    readonly partial: "evidence.partial";
    readonly missing: "evidence.missing";
};
type HostTurnStatus = TurnSummaryDto['status'];
/**
 * The host's status words, for the states the timeline cannot express.
 *
 * The card's own status line is the conversation's — it is the thing the user is
 * looking at, and it is the same numbering and the same turns. But the host knows
 * end states the conversation does not derive: a turn that never started, one
 * cancelled before it ran, one the host marked interrupted. Those are shown as a
 * second chip rather than allowed to overwrite the first, because they are two
 * claims and only one of them is about the timeline. A host status the timeline
 * *can* express is left out — repeating it as "host recorded: running" next to
 * "Running" would be noise pretending to be evidence.
 */
export declare const HOST_ONLY_STATUS_KEYS: Partial<Record<HostTurnStatus, TurnscopeKey>>;
export declare const FRESHNESS_KEYS: {
    readonly loading: "freshness.loading";
    readonly error: "freshness.error";
    readonly stale: "freshness.stale";
    readonly live: "freshness.live";
    readonly stable: "freshness.stable";
};
export {};
//# sourceMappingURL=keys.d.ts.map