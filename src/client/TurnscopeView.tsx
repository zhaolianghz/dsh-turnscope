import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SafetySummaryDto } from '../shared/contracts/api.ts'
import type { TurnscopeHostApi } from './host-api.ts'
import type { TurnscopeKey } from './locales.ts'
import { useRecordedTurns, type RecordedTurns } from './recorded-turns.ts'
import { deriveTurnModels, type TurnStatus } from './turn-model.ts'

/** The level a verdict carries, taken from the contract rather than restated. */
type SafetyLevel = SafetySummaryDto['level']

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

/** The props the view needs beyond what the slot framework hands it. */
export interface TurnscopeViewProps {
  /**
   * The host's verdicts for this session, absent while the answer is in flight.
   *
   * A prop rather than a fetch inside the view so that the pure rendering can be
   * tested — and read — without a connection, a timer, or a resolved promise.
   */
  readonly recorded?: RecordedTurns | undefined
}

export function TurnscopeView({
  useSession,
  t,
  recorded,
}: ConvViewProps & PropsLocale<'turnscope'> & TurnscopeViewProps) {
  const openState = useSession(snapshot => snapshot.openState)
  const turns = useSession(deriveTurnModels)

  if (openState === 'loading') return <div role="status">{t('state.loading')}</div>
  if (turns.length === 0) return <div>{t('state.empty')}</div>

  // The failure to reach the host is reported above the turns rather than in
  // place of them: which turns happened is local knowledge the view already has,
  // and losing it because a remote call failed would be a regression on the
  // timeline this panel exists to show.
  const problem = recorded?.problem

  return (
    <section aria-label={t('view.title')} className="turnscope-root">
      {problem === undefined ? null : (
        <p role="note" className="turnscope-note">
          {t('safety.unavailable', { reason: problem })}
        </p>
      )}
      {turns.map(turn => {
        const safety = recorded?.safety.get(turn.turn)
        return (
          <article
            key={turn.turn}
            aria-label={`Turn ${turn.turn}`}
            className="turnscope-card"
            data-status={turn.status}
          >
            <header className="turnscope-header">
              <strong>Turn {turn.turn}</strong>
              {safety === undefined ? null : (
                <span className="turnscope-safety" data-level={safety.level}>
                  {t(LEVEL_KEYS[safety.level])}
                </span>
              )}
              <span className="turnscope-status">{t(STATUS_KEYS[turn.status])}</span>
            </header>
            <dl className="turnscope-summary">
              <div><dt>{t('summary.tools')}</dt><dd>{turn.toolCount}</dd></div>
              <div><dt>{t('summary.errors')}</dt><dd>{turn.errorCount}</dd></div>
              {turn.durationMs === undefined ? null : (
                <div><dt>{t('summary.duration')}</dt><dd>{turn.durationMs} ms</dd></div>
              )}
            </dl>
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
    const recorded = useRecordedTurns(host, sessionId)
    return <TurnscopeView {...props} recorded={recorded} />
  }
}
