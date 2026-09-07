import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnscopeKey } from './locales.ts'
import { deriveTurnModels, type TurnStatus } from './turn-model.ts'

const STATUS_KEYS = {
  running: 'status.running',
  completed: 'status.completed',
  failed: 'status.failed',
  'max-tokens': 'status.maxTokens',
} as const satisfies Record<TurnStatus, TurnscopeKey>

export function TurnscopeView({ useSession, t }: ConvViewProps & PropsLocale<'turnscope'>) {
  const openState = useSession(snapshot => snapshot.openState)
  const turns = useSession(deriveTurnModels)

  if (openState === 'loading') return <div role="status">{t('state.loading')}</div>
  if (turns.length === 0) return <div>{t('state.empty')}</div>

  return (
    <section aria-label={t('view.title')} className="turnscope-root">
      {turns.map(turn => (
        <article
          key={turn.turn}
          aria-label={`Turn ${turn.turn}`}
          className="turnscope-card"
          data-status={turn.status}
        >
          <header className="turnscope-header">
            <strong>Turn {turn.turn}</strong>
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
      ))}
    </section>
  )
}
