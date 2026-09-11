import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useState } from 'react'
import { TurnDetailView } from './TurnDetail.tsx'
import { RecoverySection } from './RecoverySection.tsx'
import { useRecoveryFeed } from './recovery-feeds.ts'
import { ACTION_KEYS, EVIDENCE_KEYS, FRESHNESS_KEYS, HOST_ONLY_STATUS_KEYS, LEVEL_KEYS, STATUS_KEYS } from './keys.ts'
import { useFileDiffs, type FileDiffFeed } from './file-diffs.ts'
import { freshnessOf } from './freshness.ts'
import type { TurnscopeHostApi } from './host-api.ts'
import { useRecordedTurns, type RecordedTurns } from './recorded-turns.ts'
import { useTurnDetails, type TurnDetailFeed } from './turn-details.ts'
import { deriveTurnModels } from './turn-model.ts'

/** Everything a card needs to open a turn, and a path inside it. */
export interface TurnDetailWiring {
  readonly feed: TurnDetailFeed
  /** Where a clicked path's diff comes from. */
  readonly diffs: FileDiffFeed
  /** The clock for the detail's "evaluated …" label; see `age.ts`. */
  readonly now: number
  /**
   * The recovery side of the panel. Absent on renders that are not wired to
   * a host (the V0.1 mock renders do not see the new endpoints).
   */
  readonly recovery?: RecoveryWiring | undefined
}

/**
 * The wiring the recovery section needs from the connected view.
 *
 * One generation counter shared with the list feed: a refresh is the reader
 * saying "what you saw may be older than the host", and that is as true of an
 * opened rewind preview as it is of the turn list. Two counters would let
 * them disagree on what "now" means.
 */
export interface RecoveryWiring {
  readonly host: TurnscopeHostApi
  readonly generation: number
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
  /**
   * Where a card's detail comes from, when there is a host to ask.
   *
   * Absent means the cards have no way in: a card that cannot be opened is honest,
   * whereas an expander that opens onto nothing is not.
   */
  readonly detail?: TurnDetailWiring | undefined
}

export function TurnscopeView({
  useSession,
  t,
  recorded,
  onRefresh,
  detail,
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
        const open = summary !== undefined && detail?.feed.expanded.has(summary.turnId) === true
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
            {/* The raw events above are the timeline the reader already has; the
                detail is the *recorded* account of them, which is why it is worth
                a round trip and why it is only asked for on request
                (`docs/ARCHITECTURE.md §44.2`). */}
            {summary === undefined || detail === undefined ? null : (
              <button
                type="button"
                className="turnscope-expand"
                aria-expanded={open}
                onClick={() => detail.feed.toggle(summary.turnId)}
              >
                {t(open ? 'detail.hide' : 'detail.show')}
              </button>
            )}
            {open && summary !== undefined && detail !== undefined ? (
              <>
                <TurnDetailView
                  t={t}
                  now={detail.now}
                  diffs={detail.diffs}
                  state={detail.feed.states.get(summary.turnId) ?? { kind: 'loading' }}
                />
                {detail.recovery !== undefined ? (
                  <RecoverySectionConnected
                    t={t as unknown as (key: string, vars?: Record<string, unknown>) => string}
                    turnId={summary.turnId}
                    wiring={detail.recovery}
                  />
                ) : null}
              </>
            ) : null}
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
    // One counter for both feeds: a refresh is the reader saying the answers on
    // screen may be older than the host, and that is as true of an opened detail
    // as it is of the list. Two counters would let the two disagree.
    const [generation, setGeneration] = useState(0)
    const recorded = useRecordedTurns(host, sessionId, generation)
    const details = useTurnDetails(host, generation)
    const diffs = useFileDiffs(host, generation)
    const refresh = useCallback(() => setGeneration(current => current + 1), [])
    return (
      <TurnscopeView
        {...props}
        recorded={recorded.state}
        onRefresh={refresh}
        detail={{
          feed: details,
          diffs,
          now: Date.now(),
          recovery: { host, generation },
        }}
      />
    )
  }
}

/**
 * Thin wrapper so the recovery section can call `useRecoveryFeed`.
 *
 * Rules of hooks demand the hook lives in a component, not in the parent
 * that maps over `turns`; this component is the only place the hook is
 * called, once per open card.
 */
function RecoverySectionConnected({
  t,
  turnId,
  wiring,
}: {
  readonly t: (key: string, vars?: Record<string, unknown>) => string
  readonly turnId: string
  readonly wiring: RecoveryWiring
}) {
  const feed = useRecoveryFeed(wiring.host, turnId)
  useEffect(() => {
    // A generation bump means the parent's view changed; the cached previews
    // were asked under the previous workspace hash, so they cannot be trusted
    // any longer. Drop them so the user has to press Preview again rather
    // than Apply.
    feed.reset()
    // `feed` is recreated on every render of the parent; depending on it
    // would re-run the effect on every parent update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wiring.generation])
  return <RecoverySection t={t as unknown as (key: string, vars?: Record<string, unknown>) => string} feed={feed} />
}
