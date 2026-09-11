/**
 * The safety engine's inputs and its rule interface, from
 * `docs/ARCHITECTURE.md §13`.
 *
 * `now` is an input rather than a call to `Date.now()`. The engine is specified
 * as pure — same input, same output (`docs/ARCHITECTURE.md §6.2`) — and a
 * function that reads the clock cannot be replayed, cannot be tested at a fixed
 * instant, and cannot be compared with a verdict computed a second earlier. Time
 * is evidence like any other, so it comes in through the door.
 */
import type { RecoveryAction, SafetyLevel, SafetyReason, TurnRecord } from '../domain/types.ts';
import type { ObservedCheckpoint, TurnChangeSet } from '../attribution/types.ts';
/** Bumped when a rule change could alter a verdict for unchanged input (`§13.2`). */
export declare const SAFETY_ENGINE_VERSION = 1;
/**
 * The severity order `docs/ARCHITECTURE.md §15` uses to collapse reasons.
 *
 * `UNPROTECTED` above `FORK_ONLY` is a statement about *evidence*, not about
 * danger: `FORK_ONLY` has a usable historical baseline and `FORK_ONLY` is what
 * you use it for, while `UNPROTECTED` may not have a reliable starting point at
 * all. That is why `allowedActions` is computed separately instead of being
 * derived from this order.
 */
export declare const SEVERITY_ORDER: readonly SafetyLevel[];
/** The result of dry-running a reverse patch, when `§14.1` S008 can ask for one. */
export interface PatchCheckResult {
    readonly clean: boolean;
    /** Paths the patch would not apply to cleanly. */
    readonly conflicts: readonly string[];
}
/**
 * A hint that a turn reached outside the repository, per `§14.1` S012.
 *
 * Never a blocker: rolling back files cannot un-deploy anything, so the honest
 * answer is the warning, not a refusal the plugin cannot back up.
 */
export interface ExternalEffectEvidence {
    readonly kind: 'network' | 'deploy' | 'publish' | 'unknown';
    readonly detail: string;
    readonly activityId?: string;
}
/** Everything a rule is allowed to look at (`§13.1`). */
export interface SafetyInput {
    readonly turn: TurnRecord;
    readonly pre?: ObservedCheckpoint | undefined;
    readonly post?: ObservedCheckpoint | undefined;
    readonly current?: ObservedCheckpoint | undefined;
    readonly changeSet?: TurnChangeSet | undefined;
    readonly reversePatchCheck?: PatchCheckResult | undefined;
    readonly externalEffects?: readonly ExternalEffectEvidence[] | undefined;
    /** Epoch milliseconds. Passed in so the engine stays pure. */
    readonly now: number;
}
/**
 * One rule (`§14`).
 *
 * A rule returns the reasons it found and nothing else: it does not decide the
 * verdict, and it cannot see what another rule concluded. That keeps each rule
 * independently testable — "does S005 fire here" is a question with an answer
 * that does not depend on the rest of the table.
 */
export interface SafetyRule {
    readonly id: string;
    evaluate(input: SafetyInput): readonly SafetyReason[];
}
/** What the engine returns, before it is stored as a `SafetyVerdict`. */
export interface SafetyEvaluation {
    readonly level: SafetyLevel;
    readonly reasons: readonly SafetyReason[];
    readonly allowedActions: readonly RecoveryAction[];
    readonly recommendedAction: RecoveryAction;
    readonly engineVersion: number;
    readonly currentStateHash: string | undefined;
}
//# sourceMappingURL=types.d.ts.map