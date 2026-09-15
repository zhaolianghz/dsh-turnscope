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
import { ACTION_KEYS, ATTRIBUTION_KEYS, EVIDENCE_KEYS, LEVEL_KEYS } from './keys.ts'
import type { TurnscopeKey } from './locales.ts'
import type { FileDiffFeed } from './file-diffs.ts'
import { diffKey } from './file-diffs.ts'
import { DiffView } from './DiffView.tsx'
import type { TurnDetailState } from './turn-details.ts'

// Each vocabulary is read off the contract's own shape rather than restated, so
// the client cannot render a value the host does not send; see `keys.ts`.
type FileChange = TurnDetailData['changes'][number]
type CommandRecord = TurnDetailData['commands'][number]
type TestRecord = TurnDetailData['tests'][number]
type SafetyVerdict = NonNullable<TurnDetailData['safety']>
type SafetyReason = SafetyVerdict['reasons'][number]
type ChangeKind = FileChange['kind']
type ValidationKind = TestRecord['kind']
type ValidationStatus = TestRecord['status']

const KIND_KEYS = {
  created: 'change.created',
  modified: 'change.modified',
  deleted: 'change.deleted',
  renamed: 'change.renamed',
  binary_changed: 'change.binary',
} as const satisfies Record<ChangeKind, TurnscopeKey>

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
  /** Where a path's diff comes from. Absent when nothing is wired to a host. */
  readonly diffs?: FileDiffFeed | undefined
}

export function TurnDetailView({
  state,
  now,
  diffs,
  t,
}: TurnDetailProps & PropsLocale<'turnscope'>) {
  switch (state.kind) {
    case 'loading':
      return <p role="status" className="turnscope-detail-note">{t('detail.loading')}</p>
    case 'absent':
      // The host answered "no such turn". Worth saying plainly: after a refresh
      // this is the only way a reader learns the record went away.
      return <p className="turnscope-detail-note">{t('detail.missing')}</p>
    case 'failed':
      return (
        <p role="note" className="turnscope-detail-note">
          {t('detail.failed', { reason: state.reason })}
        </p>
      )
    case 'value':
      return <Loaded detail={state.value} now={now} diffs={diffs} t={t} />
  }
}

function Loaded({
  detail,
  now,
  diffs,
  t,
}: {
  readonly detail: TurnDetailData
  readonly now: number
  readonly diffs: FileDiffFeed | undefined
} & PropsLocale<'turnscope'>) {
  const { summary } = detail
  // The open diff, if it is one of *these* changes. Matching against the recorded
  // list rather than trusting the key keeps a selection made in another card from
  // rendering here — the two cards would otherwise both claim the same diff.
  const open =
    diffs === undefined
      ? undefined
      : detail.changes.find(item => diffKey(item.turnId, item.path) === diffs.selected)
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
          {/* The agent's edits. Baseline-dirty paths, if any, are shown in
              their own line below, since they are inherited state rather than
              a row the agent added or modified this turn. */}
          <span className="turnscope-count">{summary.agentChangeCount}</span>
          {summary.baselineChangeCount > 0 ? (
            <>
              {' '}
              <span className="turnscope-baseline">
                {t('summary.baselineChangesShort', {
                  count: summary.baselineChangeCount,
                })}
              </span>
            </>
          ) : null}
        </h4>
        {detail.changes.length === 0 ? (
          <p className="turnscope-detail-note">{t('detail.noChanges')}</p>
        ) : (
          <>
            {/* Two groups: agent edits on top, inherited baseline-dirty paths
                beneath a labelled divider. A turn whose worktree was clean at
                session start gets only the top group; the divider is omitted
                so the layout is unchanged for the common case. The per-row
                `本轮开始时已脏` badge is unchanged — the divider is the bulk
                signal, the badge is the per-row confirmation. */}
            <ChangeList changes={detail.changes.filter(c => !c.baseline)} diffs={diffs} t={t} />
            {detail.changes.some(c => c.baseline) ? (
              <>
                <h5 className="turnscope-baseline-heading">
                  本轮开始时已脏 ({detail.changes.filter(c => c.baseline).length})
                </h5>
                <ChangeList
                  changes={detail.changes.filter(c => c.baseline)}
                  diffs={diffs}
                  t={t}
                />
              </>
            ) : null}
          </>
        )}
        {/* One comparison at a time, under the list it was opened from: the thing
            a reader compares a diff against is the verdict above it, not another
            file (`FR-07`, `docs/ARCHITECTURE.md §28.3`). */}
        {open === undefined || diffs === undefined ? null : (
          <DiffView
            t={t}
            state={diffs.states.get(diffKey(open.turnId, open.path)) ?? { kind: 'loading' }}
          />
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

function ChangeList({
  changes,
  diffs,
  t,
}: {
  readonly changes: readonly FileChange[]
  readonly diffs: FileDiffFeed | undefined
} & PropsLocale<'turnscope'>) {
  return (
    <ul className="turnscope-changes">
      {changes.map(change => (
        <Change key={change.id} change={change} diffs={diffs} t={t} />
      ))}
    </ul>
  )
}

function Change({
  change,
  diffs,
  t,
}: {
  readonly change: FileChange
  readonly diffs: FileDiffFeed | undefined
} & PropsLocale<'turnscope'>) {
  const key = diffKey(change.turnId, change.path)
  const open = diffs?.selected === key
  return (
    <li className="turnscope-change" data-kind={change.kind} data-attribution={change.attribution}>
      {diffs === undefined ? (
        <span className="turnscope-path">{change.path}</span>
      ) : (
        // The path is the only thing that selects a diff, and it selects it by the
        // *recorded* value: the request carries what the host reported, never a
        // path the browser composed.
        <button
          type="button"
          className="turnscope-path turnscope-path-button"
          aria-expanded={open}
          onClick={() => diffs.select(change.turnId, change.path)}
        >
          {change.path}
        </button>
      )}
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
      {diffs === undefined ? null : (
        <span className="turnscope-diff-toggle">{t(open ? 'diff.hide' : 'diff.show')}</span>
      )}
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
