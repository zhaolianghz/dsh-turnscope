import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SafetySummaryDto, TurnSummaryDto } from '../shared/contracts/api.ts'
import { freshnessOf, type Freshness } from './freshness.ts'
import type { TurnscopeHostApi } from './host-api.ts'
import type { TurnscopeKey } from './locales.ts'
import { useRecordedTurns, type RecordedTurns } from './recorded-turns.ts'
import { deriveTurnModels, type TurnStatus } from './turn-model.ts'

// Every vocabulary below is read off the contract's own shapes rather than
// restated beside them: a second copy of a union is a second thing to keep in
// step, and the failure mode of a drifted copy is a label for a value the host
// never sends, with nothing to catch it.

/** The level a verdict carries. */
type SafetyLevel = SafetySummaryDto['level']

/** The action the host recommends. */
type RecoveryAction = SafetySummaryDto['recommendedAction']

/** How much of a turn's evidence exists, as the host reports it. */
type EvidenceCompleteness = TurnSummaryDto['evidenceCompleteness']

/** A turn's stored status, which is a slightly larger set than the timeline's. */
type HostTurnStatus = TurnSummaryDto['status']

const STATUS_KEYS = {
  running: 'status.running',
  completed: 'status.completed',
  failed: 'status.failed',
  'max-tokens': 'status.maxTokens',
} as const satisfies Record<TurnStatus, TurnscopeKey>

const LEVEL_KEYS = {
  SAFE: 'safety.SAFE',
  CAUTION: 'safety.CAUTION',
  FORK_ONLY: 'safety.FORK_ONLY',
  UNPROTECTED: 'safety.UNPROTECTED',
} as const satisfies Record<SafetyLevel, TurnscopeKey>

const ACTION_KEYS = {
  INSPECT: 'action.INSPECT',
  PREVIEW_REWIND: 'action.PREVIEW_REWIND',
  REWIND: 'action.REWIND',
  FORK: 'action.FORK',
  NONE: 'action.NONE',
} as const satisfies Record<RecoveryAction, TurnscopeKey>

const EVIDENCE_KEYS = {
  complete: 'evidence.complete',
  partial: 'evidence.partial',
  missing: 'evidence.missing',
} as const satisfies Record<EvidenceCompleteness, TurnscopeKey>

const FRESHNESS_KEYS = {
  loading: 'freshness.loading',
  error: 'freshness.error',
  stale: 'freshness.stale',
  live: 'freshness.live',
  stable: 'freshness.stable',
} as const satisfies Record<Freshness, TurnscopeKey>

/**
 * The host's status words, for the states the timeline cannot express.
 *
 * The card's own status line is the conversation's — it is the thing the user is
 * looking at, and it is the same numbering and the same turns. But the host knows
 * two end states the conversation does not derive: a turn cancelled before it ran,
 * and a turn the host marked interrupted. Those are shown as a second chip rather
 * than allowed to overwrite the first, because they are two claims and only one of
 * them is about the timeline. A host status the timeline *can* express (`running`,
 * `completed`, `failed`, `output_limited`) is left out — repeating it as "host
 * recorded: running" next to "Running" would be noise pretending to be evidence.
 */
const HOST_ONLY_STATUS_KEYS: Partial<Record<HostTurnStatus, TurnscopeKey>> = {
  pending: 'status.pending',
  interrupted: 'status.interrupted',
  cancelled: 'status.cancelled',
}

/** The props the view needs beyond what the slot framework hands it. */
export interface TurnscopeViewProps {
  /**
   * The host's rows for this session, absent while the first answer is in flight.
   *
   * A prop rather than a fetch inside the view so that the pure rendering can be
   * tested — and read — without a connection, a timer, or a resolved promise.
   */
  readonly recorded?: RecordedTurns | undefined
  /** Ask the host again. Absent in renders that are not wired to a host. */
  readonly onRefresh?: (() => void) | undefined
}

export function TurnscopeView({
  useSession,
  t,
  recorded,
  onRefresh,
}: ConvViewProps & PropsLocale<'turnscope'> & TurnscopeViewProps) {
  const openState = useSession(snapshot => snapshot.openState)
  const turns = useSession(deriveTurnModels)

  if (openState === 'loading') return <div role="status">{t('state.loading')}</div>
  if (turns.length === 0) return <div>{t('state.empty')}</div>

  const freshness = freshnessOf(turns, recorded)

  // The failure to reach the host is reported above the turns rather than in
  // place of them: which turns happened is local knowledge the view already has,
  // and losing it because a remote call failed would be a regression on the
  // timeline this panel exists to show.
  const problem = recorded?.problem

  return (
    <section aria-label={t('view.title')} className="turnscope-root" data-freshness={freshness}>
      <div className="turnscope-toolbar">
        <span className="turnscope-freshness" data-freshness={freshness}>
          {t(FRESHNESS_KEYS[freshness])}
        </span>
        {onRefresh === undefined ? null : (
          <button
            type="button"
            className="turnscope-refresh"
            onClick={onRefresh}
            // Disabled only while the first answer is outstanding: a refresh
            // during a refresh is harmless, but a button that appears to do
            // nothing is worse than one that says it cannot be used yet.
            disabled={freshness === 'loading'}
          >
            {t('action.refresh')}
          </button>
        )}
      </div>
      {problem === undefined ? null : (
        <p role="note" className="turnscope-note">
          {t('safety.unavailable', { reason: problem })}
        </p>
      )}
      {turns.map(turn => {
        const summary = recorded?.turns.get(turn.turn)
        const hostOnly = summary === undefined ? undefined : HOST_ONLY_STATUS_KEYS[summary.status]
        return (
          <article
            key={turn.turn}
            aria-label={`Turn ${turn.turn}`}
            className="turnscope-card"
            data-status={turn.status}
          >
            <header className="turnscope-header">
              <strong>Turn {turn.turn}</strong>
              <span className="turnscope-status">{t(STATUS_KEYS[turn.status])}</span>
              {hostOnly === undefined ? null : (
                <span className="turnscope-host-status">
                  {t('status.hostSays', { status: t(hostOnly) })}
                </span>
              )}
              {summary === undefined ? null : summary.safety === undefined ? (
                <span className="turnscope-safety" data-level="none">
                  {t('safety.unjudged')}
                </span>
              ) : (
                <>
                  <span className="turnscope-safety" data-level={summary.safety.level}>
                    {t(LEVEL_KEYS[summary.safety.level])}
                  </span>
                  {summary.evidenceCompleteness === 'complete' ? null : (
                    <span className="turnscope-evidence" data-evidence={summary.evidenceCompleteness}>
                      {t(EVIDENCE_KEYS[summary.evidenceCompleteness])}
                    </span>
                  )}
                </>
              )}
            </header>
            <dl className="turnscope-summary">
              {/* Changed files come from the host, so they are absent until it
                  answers. Nothing is shown in their place: a count invented from
                  the timeline would be a different number about a different set
                  of paths (the timeline knows tool calls, not file changes). */}
              {summary === undefined ? null : (
                <div><dt>{t('summary.changes')}</dt><dd>{summary.changeCount}</dd></div>
              )}
              <div><dt>{t('summary.tools')}</dt><dd>{turn.toolCount}</dd></div>
              <div><dt>{t('summary.errors')}</dt><dd>{turn.errorCount}</dd></div>
              {turn.durationMs === undefined ? null : (
                <div><dt>{t('summary.duration')}</dt><dd>{turn.durationMs} ms</dd></div>
              )}
            </dl>
            {summary?.safety === undefined ? null : (
              <p className="turnscope-action">
                <span className="turnscope-action-label">{t('action.recommended')}</span>{' '}
                {t(ACTION_KEYS[summary.safety.recommendedAction])}
              </p>
            )}
            <ol className="turnscope-activities">
              {turn.activities.map(activity => <li key={activity.id}>{activity.label}</li>)}
            </ol>
          </article>
        )
      })}
    </section>
  )
}

/**
 * Bind the view to a live host.
 *
 * A factory rather than a component with a `host` prop, because the host is a
 * property of *this installation* and not of any render: it is created once when
 * the plugin applies, from the connection the platform handed us, and never
 * changes while the page is open. Threading it through props would put a value
 * that cannot vary into a position where it looks like it can.
 */
export function createTurnscopeView(host: TurnscopeHostApi) {
  return function TurnscopeViewConnected(props: ConvViewProps & PropsLocale<'turnscope'>) {
    const sessionId = props.useSession(snapshot => snapshot.sessionId)
    const feed = useRecordedTurns(host, sessionId)
    return <TurnscopeView {...props} recorded={feed.state} onRefresh={feed.refresh} />
  }
}
