import type { TurnStatus } from './types.ts';
/**
 * Apply a status update to a turn, enforcing the transition rules of
 * `docs/ARCHITECTURE.md §3.3`.
 *
 * ```text
 * pending → running → completed
 *                   ↘ failed
 *                   ↘ interrupted
 * ```
 *
 * Total and side-effect free: a terminal turn absorbs every later transition
 * and yields `current` unchanged, so a late `completed` can never resurrect an
 * interrupted turn — the caller keeps the turn and appends the late event as an
 * activity instead.
 */
export declare function transitionTurn(current: TurnStatus, next: TurnStatus): TurnStatus;
//# sourceMappingURL=turn-state.d.ts.map