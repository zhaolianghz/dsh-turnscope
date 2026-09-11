/**
 * The recovery section of the inspector.
 *
 * Three buttons in a row above the changes the turn left behind:
 *
 *   - **Preview** — draft a plan, no worktree writes.
 *   - **Apply**   — confirm the preview, the runner writes the worktree.
 *   - **Refresh** — re-pull the unfinished-plans list (used by the boot-time
 *                   crash probe).
 *
 * The section is rendered inside the detail card, not the list row, because
 * "you can rewind this turn" is a property of the turn the reader has opened,
 * not of the session at large. Showing the controls per-row would promise
 * the user they could rewind any turn without distinguishing "this one has
 * bytes the runner can put back" from "this one is empty".
 *
 * Failures are rendered in place, not as toasts: the section is the only
 * place in the panel that surfaces them, and a toast would land elsewhere
 * on the page with no obvious source.
 */

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { RECOVERY_KEYS } from './keys.ts'
import type { RecoveryFeed } from './recovery-feeds.ts'

export interface RecoverySectionProps {
  readonly feed: RecoveryFeed
}

export function RecoverySection({ feed, t }: Omit<RecoverySectionProps, 'turnId'> & PropsLocale<'turnscope'>) {
  const plan = feed.plan
  const apply = feed.apply
  const list = feed.list

  const planResult = plan.kind === 'value' ? plan.value.plan : undefined
  const planFailure = plan.kind === 'value' ? plan.value.failureReason : plan.kind === 'failed' ? plan.reason : undefined
  const applyResult = apply.kind === 'value' ? apply.value.result : undefined
  const applyFailure = apply.kind === 'value' ? apply.value.failureReason : apply.kind === 'failed' ? apply.reason : undefined

  return (
    <section aria-label={t('recovery.section')} className="turnscope-recovery">
      <header className="turnscope-recovery-header">
        <strong>{t('recovery.title')}</strong>
      </header>
      <div className="turnscope-recovery-actions">
        <button
          type="button"
          className="turnscope-preview"
          onClick={() => feed.setPlan(`eval-${Date.now()}`)}
          disabled={plan.kind === 'loading'}
        >
          {t('recovery.preview')}
        </button>
        <button
          type="button"
          className="turnscope-apply"
          onClick={() => planResult !== undefined && feed.runApply(planResult.id)}
          disabled={planResult === undefined || apply.kind === 'loading'}
        >
          {t('recovery.apply')}
        </button>
        <button
          type="button"
          className="turnscope-refresh-list"
          onClick={feed.refreshList}
          disabled={list.kind === 'loading'}
        >
          {t('recovery.refresh')}
        </button>
      </div>
      {planFailure !== undefined ? (
        <p role="alert" className="turnscope-recovery-failure">{t(RECOVERY_KEYS.previewFailed, { reason: planFailure })}</p>
      ) : null}
      {planResult !== undefined ? (
        <ul className="turnscope-recovery-ops">
          {planResult.operations.map(op => <li key={`${op.kind}:${op.path}`}>{describe(op, t)}</li>)}
        </ul>
      ) : null}
      {applyFailure !== undefined ? (
        <p role="alert" className="turnscope-recovery-failure">{t(RECOVERY_KEYS.applyFailed, { reason: applyFailure })}</p>
      ) : null}
      {applyResult !== undefined ? (
        <p className="turnscope-recovery-result" data-status={applyResult.status}>
          {t(RECOVERY_KEYS[`applyStatus_${applyResult.status}` as keyof typeof RECOVERY_KEYS] ?? 'recovery.result', { status: applyResult.status })}
        </p>
      ) : null}
      {list.kind === 'value' && list.value.plans.length > 0 ? (
        <aside className="turnscope-recovery-list">
          <p>{t('recovery.unfinished', { count: list.value.plans.length })}</p>
        </aside>
      ) : null}
    </section>
  )
}

/**
 * One line per op, for the "what would the runner do?" list under Preview.
 *
 * Kept here rather than in the plan DTO so the labels can live with the
 * locale table; the DTO only carries the structural fields.
 */
function describe(
  op: { readonly kind: string; readonly path: string; readonly reason?: string },
  t: PropsLocale<'turnscope'>['t'],
): string {
  const labelKey =
    op.kind === 'restore' ? 'recovery.opRestore' :
    op.kind === 'delete_created_file' ? 'recovery.opDelete' :
    op.kind === 'recreate_deleted_file' ? 'recovery.opRecreate' :
    'recovery.opNoop'
  const base = t(labelKey, { path: op.path })
  return op.reason === undefined ? base : `${base} (${op.reason})`
}
