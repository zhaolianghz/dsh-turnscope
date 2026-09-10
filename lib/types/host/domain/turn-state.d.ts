import type { TurnStatus } from './types.ts';
/**
 * The states a turn cannot move out of.
 *
 * Exported because the same set has to hold in two places that cannot import
 * each other's vocabulary: this predicate, and the `WHERE status NOT IN (…)`
 * clause of the one SQL statement that closes a turn. Spelling the five names
 * out in both files is how the two silently drift apart; the repository builds
 * its clause from this array instead.
 */
export declare const TERMINAL_TURN_STATUSES: readonly TurnStatus[];
/** Whether a status is final, i.e. no later event may change it. */
export declare function isTerminal(status: TurnStatus): boolean;
/**
 * Apply a status update to a turn, enforcing the transition rules of
 * `docs/PRD.md §7.1`.
 *
 * ```text
 * pending → running → completed
 *                   ↘ failed
 *                   ↘ interrupted
 *                   ↘ cancelled
 *                   ↘ output_limited
 * ```
 *
 * Total and side-effect free: a terminal turn absorbs every later transition
 * and yields `current` unchanged, so a late `completed` can never resurrect an
 * interrupted turn — the caller keeps the turn and appends the late event as an
 * activity instead.
 *
 * Deliberately permissive about the *route*: any non-terminal `current` accepts
 * any `next`. The graph above is built by the turn assembler, which emits
 * `running` on a turn start and a terminal status only on a turn end. Do not
 * expect this function to reject an illegal hop; its only job is absorption.
 */
export declare function transitionTurn(current: TurnStatus, next: TurnStatus): TurnStatus;
//# sourceMappingURL=turn-state.d.ts.map