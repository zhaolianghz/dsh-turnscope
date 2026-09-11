/**
 * One turn, in full.
 *
 * The section order is `docs/PRD.md §14.1`'s: safety first, then what changed,
 * then how it was validated, then what could be done about it. Raw events are
 * last, and on the card rather than here, because they are the thing a reader
 * goes looking for only after the verdict has failed to explain something.
 *
 * Everything the user is asked to believe is a word. `§14.2` forbids hedging about
 * safety and `§14.4` forbids colour as the only carrier of meaning, so every chip
 * and every row below states its case in text and the stylesheet only groups them.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnDetailData } from '../shared/contracts/api.ts'
import { ageOf, type AgeUnit } from './age.ts'
import { ACTION_KEYS, EVIDENCE_KEYS, LEVEL_KEYS } from './keys.ts'
import type { TurnscopeKey } from './locales.ts'
import type { TurnDetailState } from './turn-details.ts'

// Each vocabulary is read off the contract's own shape rather than restated, so
// the client cannot render a value the host does not send; see `keys.ts`.
type FileChange = TurnDetailData['changes'][number]
type CommandRecord = TurnDetailData['commands'][number]
type TestRecord = TurnDetailData['tests'][number]
type SafetyVerdict = NonNullable<TurnDetailData['safety']>
type SafetyReason = SafetyVerdict['reasons'][number]
type ChangeKind = FileChange['kind']
type Attribution = FileChange['attribution']
type ValidationKind = TestRecord['kind']
type ValidationStatus = TestRecord['status']

const KIND_KEYS = {
  created: 'change.created',
  modified: 'change.modified',
  deleted: 'change.deleted',
  renamed: 'change.renamed',
  binary_changed: 'change.binary',
} as const satisfies Record<ChangeKind, TurnscopeKey>

const ATTRIBUTION_KEYS = {
  AGENT: 'attribution.AGENT',
  BASELINE: 'attribution.BASELINE',
  DRIFT: 'attribution.DRIFT',
  UNCERTAIN: 'attribution.UNCERTAIN',
} as const satisfies Record<Attribution, TurnscopeKey>

const VALIDATION_KEYS = {
  test: 'validation.test',
  typecheck: 'validation.typecheck',
  lint: 'validation.lint',
  build: 'validation.build',
  compile: 'validation.compile',
} as const satisfies Record<ValidationKind, TurnscopeKey>

const RESULT_KEYS = {
  passed: 'result.passed',
  failed: 'result.failed',
  unknown: 'result.unknown',
} as const satisfies Record<ValidationStatus, TurnscopeKey>

const AGE_KEYS = {
  now: 'age.now',
  seconds: 'age.seconds',
  minutes: 'age.minutes',
  hours: 'age.hours',
  days: 'age.days',
} as const satisfies Record<AgeUnit, TurnscopeKey>

export interface TurnDetailProps {
  readonly state: TurnDetailState
  /** The clock, as an input. See `age.ts` for why it is not read here. */
  readonly now: number
}

export function TurnDetailView({
  state,
  now,
  t,
}: TurnDetailProps & PropsLocale<'turnscope'>) {
  switch (state.kind) {
    case 'loading':
      return <p role="status" className="turnscope-detail-note">{t('detail.loading')}</p>
    case 'missing':
      // The host answered "no such turn". Worth saying plainly: after a refresh
      // this is the only way a reader learns the record went away.
      return <p className="turnscope-detail-note">{t('detail.missing')}</p>
    case 'failed':
      return (
        <p role="note" className="turnscope-detail-note">
          {t('detail.failed', { reason: state.reason })}
        </p>
      )
    case 'loaded':
      return <Loaded detail={state.detail} now={now} t={t} />
  }
}

function Loaded({
  detail,
  now,
  t,
}: {
  readonly detail: TurnDetailData
  readonly now: number
} & PropsLocale<'turnscope'>) {
  const { summary } = detail
  return (
    <div className="turnscope-detail">
      {detail.safety === undefined ? (
        <p className="turnscope-detail-note">{t('detail.unjudged')}</p>
      ) : (
        <Verdict verdict={detail.safety} evidence={summary.evidenceCompleteness} now={now} t={t} />
      )}

      <section className="turnscope-section" aria-label={t('detail.changes')}>
        <h4>
          {t('detail.changes')}{' '}
          {/* The count of the rows below, not the summary's `changeCount`: the two
              are the same number when the answer is consistent, and when they are
              not, the one a reader can check by counting is the better one. */}
          <span className="turnscope-count">{detail.changes.length}</span>
        </h4>
        {detail.changes.length === 0 ? (
          <p className="turnscope-detail-note">{t('detail.noChanges')}</p>
        ) : (
          <ul className="turnscope-changes">
            {detail.changes.map(change => <Change key={change.id} change={change} t={t} />)}
          </ul>
        )}
      </section>

      <section className="turnscope-section" aria-label={t('detail.tests')}>
        <h4>
          {t('detail.tests')} <span className="turnscope-count">{detail.tests.length}</span>
        </h4>
        {detail.tests.length === 0 ? (
          <p className="turnscope-detail-note">{t('detail.noTests')}</p>
        ) : (
          <ul className="turnscope-tests">
            {detail.tests.map(test => <Test key={test.id} test={test} t={t} />)}
          </ul>
        )}
      </section>

      <section className="turnscope-section" aria-label={t('detail.commands')}>
        <h4>
          {t('detail.commands')} <span className="turnscope-count">{detail.commands.length}</span>
        </h4>
        {detail.commands.length === 0 ? (
          <p className="turnscope-detail-note">{t('detail.noCommands')}</p>
        ) : (
          <ul className="turnscope-commands">
            {detail.commands.map(command => <Command key={command.id} command={command} t={t} />)}
          </ul>
        )}
      </section>

      <p className="turnscope-detail-note turnscope-recovery-note">{t('detail.noWrites')}</p>
    </div>
  )
}

/**
 * The verdict, its reasons, and what the host says could be done.
 *
 * The reason text is the host's, in the language the rule was written in, and it
 * is not translated here: a reason is a specific claim derived from a specific
 * rule, and rewording it in the client would be a second place where safety
 * sentences are authored — with nothing keeping the two in step. What the client
 * *does* add is the structure (`§14.2`: the level is a statement, not a hedge) and
 * the codes, so a reader can cite what they are looking at.
 */
function Verdict({
  verdict,
  evidence,
  now,
  t,
}: {
  readonly verdict: SafetyVerdict
  readonly evidence: TurnDetailData['summary']['evidenceCompleteness']
  readonly now: number
} & PropsLocale<'turnscope'>) {
  const age = ageOf(verdict.evaluatedAt, now)
  return (
    <section className="turnscope-section" aria-label={t('detail.safety')}>
      <h4 className="turnscope-verdict">
        <span className="turnscope-safety" data-level={verdict.level}>
          {t(LEVEL_KEYS[verdict.level])}
        </span>
        {/* The verdict and the completeness of the evidence it rests on belong in
            the same breath: a level on its own reads as more certain than it is. */}
        {evidence === 'complete' ? null : (
          <span className="turnscope-evidence" data-evidence={evidence}>
            {t(EVIDENCE_KEYS[evidence])}
          </span>
        )}
        <span className="turnscope-action">
          {t('action.recommended')} {t(ACTION_KEYS[verdict.recommendedAction])}
        </span>
        <span className="turnscope-evaluated">
          {t('safety.evaluatedAt', { age: t(AGE_KEYS[age.unit], { count: age.count }) })}
        </span>
      </h4>
      {verdict.reasons.length === 0 ? (
        <p className="turnscope-detail-note">{t('detail.noReasons')}</p>
      ) : (
        <ul className="turnscope-reasons">
          {verdict.reasons.map(reason => <Reason key={reason.code + (reason.path ?? '')} reason={reason} t={t} />)}
        </ul>
      )}
      <p className="turnscope-allowed">
        <span className="turnscope-action-label">{t('detail.allowed')}</span>{' '}
        {verdict.allowedActions.length === 0
          ? t('detail.allowedNone')
          : verdict.allowedActions.map(action => t(ACTION_KEYS[action])).join(' · ')}
      </p>
    </section>
  )
}

function Reason({ reason, t }: { readonly reason: SafetyReason } & PropsLocale<'turnscope'>) {
  return (
    <li className="turnscope-reason" data-severity={reason.severity}>
      <div className="turnscope-reason-head">
        <span className="turnscope-reason-code">{reason.code}</span>
        <strong className="turnscope-reason-title">{reason.title}</strong>
      </div>
      <p className="turnscope-reason-detail">{reason.detail}</p>
      {reason.path === undefined ? null : (
        <code className="turnscope-reason-path">{reason.path}</code>
      )}
      <span className="turnscope-reason-evidence">
        {t('detail.evidenceCount', { count: reason.evidenceRefs.length })}
      </span>
    </li>
  )
}

function Change({ change, t }: { readonly change: FileChange } & PropsLocale<'turnscope'>) {
  return (
    <li className="turnscope-change" data-kind={change.kind} data-attribution={change.attribution}>
      <span className="turnscope-path">{change.path}</span>
      {change.previousPath === undefined ? null : (
        <span className="turnscope-rename">{t('change.from', { path: change.previousPath })}</span>
      )}
      <span className="turnscope-kind">{t(KIND_KEYS[change.kind])}</span>
      <span className="turnscope-attribution" data-attribution={change.attribution}>
        {t(ATTRIBUTION_KEYS[change.attribution])}
      </span>
      {change.baseline ? (
        <span className="turnscope-baseline">{t('attribution.baseline')}</span>
      ) : null}
      {/* A low-confidence answer is not a weaker kind of certainty, it is a
          different thing to say, so it is labelled rather than styled. */}
      {change.confidence === 'low' ? (
        <span className="turnscope-confidence">{t('attribution.lowConfidence')}</span>
      ) : null}
    </li>
  )
}

function Test({ test, t }: { readonly test: TestRecord } & PropsLocale<'turnscope'>) {
  return (
    <li className="turnscope-test" data-result={test.status}>
      <span className="turnscope-validation-kind">{t(VALIDATION_KEYS[test.kind])}</span>
      <span className="turnscope-result">{t(RESULT_KEYS[test.status])}</span>
      {/* The host's summary is shown as written: `FR-08` asks for command, exit
          status, duration and result, not for a root cause, and V0.1 has none. */}
      <span className="turnscope-test-summary">{test.summary}</span>
    </li>
  )
}

function Command({ command, t }: { readonly command: CommandRecord } & PropsLocale<'turnscope'>) {
  return (
    <li className="turnscope-command">
      <code className="turnscope-command-text">{command.command}</code>
      <span className="turnscope-exit" data-exit={command.exitCode === 0 ? 'ok' : 'bad'}>
        {command.exitCode === undefined
          ? t('detail.exitUnknown')
          : t('detail.exit', { code: command.exitCode })}
      </span>
      {command.durationMs === undefined ? null : (
        <span className="turnscope-duration">{command.durationMs} ms</span>
      )}
    </li>
  )
}
