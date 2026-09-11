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
import type { SafetySummaryDto, TurnSummaryDto } from '../shared/contracts/api.ts'
import type { TurnscopeKey } from './locales.ts'
import type { TurnStatus } from './turn-model.ts'
import type { Freshness } from './freshness.ts'

type SafetyLevel = SafetySummaryDto['level']
type RecoveryAction = SafetySummaryDto['recommendedAction']
type EvidenceCompleteness = TurnSummaryDto['evidenceCompleteness']

export const STATUS_KEYS = {
  running: 'status.running',
  completed: 'status.completed',
  failed: 'status.failed',
  'max-tokens': 'status.maxTokens',
} as const satisfies Record<TurnStatus, TurnscopeKey>

export const LEVEL_KEYS = {
  SAFE: 'safety.SAFE',
  CAUTION: 'safety.CAUTION',
  FORK_ONLY: 'safety.FORK_ONLY',
  UNPROTECTED: 'safety.UNPROTECTED',
} as const satisfies Record<SafetyLevel, TurnscopeKey>

export const ACTION_KEYS = {
  INSPECT: 'action.INSPECT',
  PREVIEW_REWIND: 'action.PREVIEW_REWIND',
  REWIND: 'action.REWIND',
  FORK: 'action.FORK',
  NONE: 'action.NONE',
} as const satisfies Record<RecoveryAction, TurnscopeKey>

export const EVIDENCE_KEYS = {
  complete: 'evidence.complete',
  partial: 'evidence.partial',
  missing: 'evidence.missing',
} as const satisfies Record<EvidenceCompleteness, TurnscopeKey>

type HostTurnStatus = TurnSummaryDto['status']

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
export const HOST_ONLY_STATUS_KEYS: Partial<Record<HostTurnStatus, TurnscopeKey>> = {
  pending: 'status.pending',
  interrupted: 'status.interrupted',
  cancelled: 'status.cancelled',
}

export const FRESHNESS_KEYS = {
  loading: 'freshness.loading',
  error: 'freshness.error',
  stale: 'freshness.stale',
  live: 'freshness.live',
  stable: 'freshness.stable',
} as const satisfies Record<Freshness, TurnscopeKey>
