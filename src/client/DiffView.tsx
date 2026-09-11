/**
 * One path's diff.
 *
 * The three things this can show are the three things `docs/PRD.md FR-07` asks
 * for: the comparison, the metadata of a comparison that cannot be drawn (a binary
 * file), and the reason there is no comparison at all. The last one is the one
 * that has to be rendered as a *sentence*, because a diff that cannot be produced
 * looks exactly like a diff that came back empty, and "we never saved the old
 * bytes" and "nothing changed here" are opposite claims
 * (`docs/ARCHITECTURE.md §28.3`).
 *
 * The unavailable reason's sentence is the host's, shown as written. It is written
 * where the missing bytes are known to be missing; rewording it here would be a
 * second place that has to know what retention did.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { GetDiffData } from '../shared/contracts/api.ts'
import { ATTRIBUTION_KEYS } from './keys.ts'
import type { TurnscopeKey } from './locales.ts'
import type { FileDiffState } from './file-diffs.ts'

// Read off the contract's shape rather than restated; see `keys.ts`.
type FileDiff = GetDiffData['diff']
type DiffSide = FileDiff['before']
type DiffAvailability = FileDiff['availability']
type DiffHunk = Extract<DiffAvailability, { kind: 'text' }>['hunks'][number]
type DiffLine = DiffHunk['lines'][number]
type DiffSource = DiffSide['source']
type UnavailableReason = Extract<DiffAvailability, { kind: 'unavailable' }>['reason']

const SOURCE_KEYS = {
  'recovery-blob': 'diff.source.recovery-blob',
  'git-object': 'diff.source.git-object',
  absent: 'diff.source.absent',
  unknown: 'diff.source.unknown',
} as const satisfies Record<DiffSource, TurnscopeKey>

const REASON_KEYS = {
  'no-checkpoint': 'diff.reason.no-checkpoint',
  'not-recorded': 'diff.reason.not-recorded',
  'missing-blob': 'diff.reason.missing-blob',
  'git-unavailable': 'diff.reason.git-unavailable',
} as const satisfies Record<UnavailableReason, TurnscopeKey>

/** The character that carries a line's meaning, so colour never has to. */
const MARK = { context: ' ', add: '+', remove: '-' } as const satisfies Record<DiffLine['kind'], string>

export interface DiffViewProps {
  readonly state: FileDiffState
}

export function DiffView({ state, t }: DiffViewProps & PropsLocale<'turnscope'>) {
  switch (state.kind) {
    case 'loading':
      return <p role="status" className="turnscope-diff-note">{t('diff.loading')}</p>
    // The host answered that this turn did not change this path. Reachable only
    // when the list of changes in the card is older than the host, which is worth
    // saying rather than showing as an empty comparison.
    case 'absent':
      return <p className="turnscope-diff-note">{t('diff.missing')}</p>
    case 'failed':
      return (
        <p role="note" className="turnscope-diff-note">
          {t('diff.failed', { reason: state.reason })}
        </p>
      )
    case 'value':
      return <Loaded diff={state.value} t={t} />
  }
}

function Loaded({ diff, t }: { readonly diff: FileDiff } & PropsLocale<'turnscope'>) {
  return (
    <div className="turnscope-diff">
      <div className="turnscope-diff-head">
        <span className="turnscope-path">{diff.path}</span>
        {diff.previousPath === undefined ? null : (
          <span className="turnscope-rename">{t('change.from', { path: diff.previousPath })}</span>
        )}
        {/* Whose change this is, carried beside the bytes: a diff read without its
            attribution is how a reader concludes the turn wrote a file it found
            already modified. */}
        <span className="turnscope-attribution" data-attribution={diff.attribution}>
          {t(ATTRIBUTION_KEYS[diff.attribution])}
        </span>
        <Side label={t('diff.sideLabel.before')} side={diff.before} t={t} />
        <Side label={t('diff.sideLabel.after')} side={diff.after} t={t} />
      </div>
      <Body availability={diff.availability} t={t} />
    </div>
  )
}

/**
 * What one side was, and — when it could not be read — that it could not be.
 *
 * `unknown` is the case worth the words: the side exists and its bytes are gone,
 * which a reader must not read as "the file was not there". That is the whole
 * reason `source` distinguishes `unknown` from `absent`.
 */
function Side({
  label,
  side,
  t,
}: {
  readonly label: string
  readonly side: DiffSide
} & PropsLocale<'turnscope'>) {
  return (
    <span className="turnscope-diff-side" data-source={side.source}>
      {t('diff.side', { label, source: t(SOURCE_KEYS[side.source]), lines: side.lineCount, bytes: side.byteSize })}
      {side.endsWithNewline ? null : (
        <span className="turnscope-diff-nonewline">{t('diff.noNewline')}</span>
      )}
    </span>
  )
}

function Body({ availability, t }: { readonly availability: DiffAvailability } & PropsLocale<'turnscope'>) {
  switch (availability.kind) {
    case 'text':
      return (
        <div className="turnscope-hunks">
          {availability.hunks.map(hunk => <Hunk key={hunkKey(hunk)} hunk={hunk} t={t} />)}
          {/* `truncated` is shown rather than left to be inferred from the last
              hunk's line numbers: a prefix of a comparison is a comparison that
              stops, and a reader who is not told will read it as the whole thing. */}
          {availability.truncated ? (
            <p role="note" className="turnscope-diff-note">{t('diff.truncated')}</p>
          ) : null}
        </div>
      )
    case 'binary':
      // No lines, and not because there are none: the sizes above are what can be
      // compared, and saying so is better than an empty box.
      return <p className="turnscope-diff-note">{t('diff.binary')}</p>
    case 'unavailable':
      return (
        <p role="note" className="turnscope-diff-note">
          <strong>{t('diff.unavailable')}</strong>{' '}
          <span className="turnscope-diff-reason">{t(REASON_KEYS[availability.reason])}</span>{' '}
          {availability.detail}
        </p>
      )
  }
}

const hunkKey = (hunk: DiffHunk): string => `${hunk.beforeStart}:${hunk.afterStart}`

function Hunk({ hunk, t }: { readonly hunk: DiffHunk } & PropsLocale<'turnscope'>) {
  return (
    <div className="turnscope-hunk">
      <div className="turnscope-hunk-head">
        {t('diff.hunk', {
          beforeStart: hunk.beforeStart,
          beforeCount: hunk.beforeCount,
          afterStart: hunk.afterStart,
          afterCount: hunk.afterCount,
        })}
      </div>
      <pre className="turnscope-hunk-body">
        {hunk.lines.map((line, index) => (
          // Index keys are safe here: the list is rebuilt whole from one answer and
          // a line has no identity of its own to preserve across answers.
          <span key={index} className="turnscope-diff-line" data-kind={line.kind}>
            <span className="turnscope-diff-mark">{MARK[line.kind]}</span>
            <span className="turnscope-diff-number">{line.beforeLine ?? ''}</span>
            <span className="turnscope-diff-number">{line.afterLine ?? ''}</span>
            {line.text}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  )
}
