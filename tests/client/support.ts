/**
 * The seats a client test has to fill.
 *
 * The fixtures live here rather than in each spec because the view, the
 * container, and the freshness rule all describe the same two things — a
 * conversation snapshot and a host answer — and three copies of "what a host row
 * looks like" is three places to update when the contract grows a field.
 */
import type { ConversationNode, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { vi } from 'vitest'
import { createTurnscopeView, type TurnscopeView } from '../../src/client/TurnscopeView.tsx'
import type { TurnscopeHostApi } from '../../src/client/host-api.ts'
import type { RecordedTurns } from '../../src/client/recorded-turns.ts'
import { zh, type TurnscopeKey } from '../../src/client/locales.ts'
import type { ReplyRead, SafetySummaryDto, TurnSummaryDto } from '../../src/shared/contracts/api.ts'

export const node = (value: object): ConversationNode => value as unknown as ConversationNode

/**
 * A conversation snapshot.
 *
 * `sessionId` is branded upstream, so the fixture casts at the boundary: the view
 * only ever compares and forwards it, and a test that had to mint a brand would be
 * testing the brand.
 */
export const snapshot = (
  overrides: Omit<Partial<ConversationSnapshot>, 'sessionId'> & { readonly sessionId?: string } = {},
): ConversationSnapshot => ({
  openState: 'open',
  sessionId: 's-1',
  nodes: [],
  turnTimings: new Map(),
  turnEnds: new Map(),
  ...overrides,
} as unknown as ConversationSnapshot)

export const verdict = (
  level: SafetySummaryDto['level'],
  recommendedAction: SafetySummaryDto['recommendedAction'] = 'INSPECT',
): SafetySummaryDto => ({ level, recommendedAction, evaluatedAt: 0 })

/** One host row, with everything a card can render, defaulted to uninteresting. */
export const row = (ordinal: number, overrides: Partial<TurnSummaryDto> = {}): TurnSummaryDto => ({
  turnId: `t-${ordinal}`,
  sessionId: 's-1',
  ordinal,
  status: 'completed',
  startedAt: 100,
  activityCount: 0,
  errorCount: 0,
  evidenceCompleteness: 'complete',
  changeCount: 0,
  ...overrides,
})

/** What the hook hands the view, built from rows the way the hook builds it. */
export const recordedOf = (rows: readonly TurnSummaryDto[]): RecordedTurns => ({
  turns: new Map(rows.map(item => [item.ordinal, item] as const)),
})

/**
 * A stand-in for the framework's `t`, mirroring its one behaviour that matters
 * here: `{name}` placeholders are filled from the params, and a name that is not
 * in them is left as written rather than dropped. A fixture that ignored params
 * would let a view ship a message full of placeholders and still test green.
 */
export const translate = (key: TurnscopeKey, params?: Record<string, unknown>): string =>
  params === undefined
    ? zh[key]
    : zh[key].replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)

export const props = (value: ConversationSnapshot): Parameters<typeof TurnscopeView>[0] => ({
  useSession: <T,>(selector: (state: ConversationSnapshot) => T) => selector(value),
  t: translate,
} as Parameters<typeof TurnscopeView>[0])

/** The same seats, minus the one the connected view supplies itself. */
export const connectedProps = (
  value: ConversationSnapshot,
): Parameters<ReturnType<typeof createTurnscopeView>>[0] =>
  props(value) as unknown as Parameters<ReturnType<typeof createTurnscopeView>>[0]

export interface HostDouble {
  readonly host: TurnscopeHostApi
  readonly listTurns: ReturnType<typeof vi.fn>
  readonly getTurnDetail: ReturnType<typeof vi.fn>
  readonly getDiff: ReturnType<typeof vi.fn>
  readonly evaluateSafety: ReturnType<typeof vi.fn>
}

/**
 * A host API whose every method answers.
 *
 * `absent` is the default for the methods a test is not about: it is what the
 * host says about a turn it does not have, and it is the answer that makes the
 * least claim on the view.
 */
export function hostDouble(
  listReply: ReplyRead<{ readonly turns: readonly TurnSummaryDto[] }> = {
    kind: 'value',
    value: { turns: [] },
  },
): HostDouble {
  const listTurns = vi.fn(async () => listReply)
  const getTurnDetail = vi.fn(async () => ({ kind: 'absent' as const }))
  const getDiff = vi.fn(async () => ({ kind: 'absent' as const }))
  const evaluateSafety = vi.fn(async () => ({ kind: 'absent' as const }))
  return { host: { listTurns, getTurnDetail, getDiff, evaluateSafety } as TurnscopeHostApi, listTurns, getTurnDetail, getDiff, evaluateSafety }
}
