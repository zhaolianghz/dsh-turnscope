import type { TurnStatus } from './types.ts'

/** States a turn can still move out of. Everything else is absorbing. */
const TERMINAL: ReadonlySet<TurnStatus> = new Set<TurnStatus>([
  'completed',
  'failed',
  'interrupted',
])

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
export function transitionTurn(current: TurnStatus, next: TurnStatus): TurnStatus {
  return TERMINAL.has(current) ? current : next
}
