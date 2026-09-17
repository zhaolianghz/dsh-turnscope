/**
 * The seats a client test has to fill.
 *
 * The fixtures live here rather than in each spec because the view, the
 * container, and the freshness rule all describe the same two things — a
 * conversation snapshot and a host answer — and three copies of "what a host row
 * looks like" is three places to update when the contract grows a field.
 */
import type { ChatSnapshot, ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import { vi } from 'vitest'
import { createTurnscopeView, type TurnscopeView } from '../../src/client/TurnscopeView.tsx'
import type { TurnscopeHostApi } from '../../src/client/host-api.ts'
import type { RecordedTurns } from '../../src/client/recorded-turns.ts'
import { zh, type TurnscopeKey } from '../../src/client/locales.ts'
import type { GetDiffData, TurnDetailData } from '../../src/shared/contracts/api.ts'
import type { ReplyRead, SafetySummaryDto, TurnSummaryDto } from '../../src/shared/contracts/api.ts'
import { TurnDetailView } from '../../src/client/TurnDetail.tsx'
import type { FileDiffFeed, FileDiffState } from '../../src/client/file-diffs.ts'
import type { TurnDetailFeed, TurnDetailState } from '../../src/client/turn-details.ts'
import type { TurnDetailWiring } from '../../src/client/TurnscopeView.tsx'

export const node = (value: object): ConversationNode => value as unknown as ConversationNode

/**
 * The minimal `ChatSnapshot` a renderer-level test needs.
 *
 * Only the fields `deriveTurnModels` actually reads (`legacy.nodes`,
 * `legacy.turnTimings`, `legacy.turnEnds`) are populated; the rest is the
 * slot framework's stable identity (`order` is an empty list, `nodes` /
 * `locations` / `timeline` / `navigation` are stubbed to satisfy the
 * interface without influencing the assertions). The session-snapshot
 * analogue (`sessionId`, `openState`, etc.) lives on `useSession`; this
 * helper only covers chat data.
 */
export const chatSnapshot = (overrides: {
  readonly nodes?: readonly ConversationNode[]
  readonly turnTimings?: ChatSnapshot['legacy']['turnTimings']
  readonly turnEnds?: ChatSnapshot['legacy']['turnEnds']
} = {}): ChatSnapshot => {
  const legacy = {
    nodes: overrides.nodes ?? [],
    turnTimings: overrides.turnTimings ?? new Map(),
    turnEnds: overrides.turnEnds ?? new Map(),
    partial: null,
    runningCalls: [],
  }
  return {
    order: [],
    nodes: {
      get: () => undefined,
      source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
      processSource: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
      values: () => [],
    } as unknown as ChatSnapshot['nodes'],
    locations: {
      getTurn: () => [],
      getStep: () => [],
    },
    timeline: { turnOrder: [], turns: new Map() },
    legacy,
  }
}

/**
 * A conversation session snapshot (the metadata slice `useSession` exposes).
 *
 * `sessionId` is branded upstream, so the fixture casts at the boundary: the view
 * only ever compares and forwards it, and a test that had to mint a brand would be
 * testing the brand.
 */
export type SessionSnapshotFixture = {
  openState: 'cold' | 'loading' | 'open' | 'error'
  sessionId: string
  queue: readonly unknown[]
  pendingSubmissions: readonly unknown[]
  running: boolean
  subagent: null
  removed: boolean
  openError: null
  hasMore: boolean
  loadingOlder: boolean
  promptError: null
  blank: boolean
  lastAgentError: null
  promptAttempted: boolean
  awaitingFirstTurn: boolean
}

export const sessionSnapshot = (
  overrides: Partial<SessionSnapshotFixture> = {},
): SessionSnapshotFixture => ({
  openState: 'open',
  sessionId: 's-1',
  queue: [],
  pendingSubmissions: [],
  running: false,
  subagent: null,
  removed: false,
  openError: null,
  hasMore: false,
  loadingOlder: false,
  promptError: null,
  blank: false,
  lastAgentError: null,
  promptAttempted: false,
  awaitingFirstTurn: false,
  ...overrides,
})

/** Back-compat alias: callers still asking for the old "snapshot" name. */
export const snapshot = (
  overrides: Partial<SessionSnapshotFixture> & LegacySnapshotOverrides = {},
): SessionSnapshotFixture & LegacySnapshotOverrides => sessionSnapshot(overrides) as SessionSnapshotFixture & LegacySnapshotOverrides

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
  agentChangeCount: 0,
  baselineChangeCount: 0,
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

/** The seats a test renders the view with. */
export interface ViewRenderProps {
  readonly session?: SessionSnapshotFixture
  readonly chat?: ChatSnapshot
}

/**
 * The keys the old `ConversationSnapshot` form exposed (turnTimings, turnEnds,
 * nodes). The renderer now reads chat data from a `ChatSnapshot` instead of a
 * `ConversationSnapshot`, but a long list of existing tests still pass these
 * fields as session-level overrides. `props()` accepts them here and routes
 * them into a built `ChatSnapshot` for the render harness.
 */
interface LegacySnapshotOverrides {
  readonly turnTimings?: ChatSnapshot['legacy']['turnTimings']
  readonly turnEnds?: ChatSnapshot['legacy']['turnEnds']
  readonly nodes?: readonly ConversationNode[]
}

const isLegacyOverrides = (value: unknown): value is LegacySnapshotOverrides =>
  typeof value === 'object' && value !== null
  && ('turnTimings' in value || 'turnEnds' in value || 'nodes' in value)

export const props = (
  sessionOrOverrides: SessionSnapshotFixture | ChatSnapshot | LegacySnapshotOverrides | ViewRenderProps,
  chat?: ChatSnapshot,
): Parameters<typeof TurnscopeView>[0] => {
  let sessionArg: SessionSnapshotFixture
  let chatArg: ChatSnapshot | undefined
  const value = sessionOrOverrides as Record<string, unknown>
  if (value !== null && typeof value === 'object' && 'legacy' in value) {
    // A full ChatSnapshot.
    sessionArg = sessionSnapshot()
    chatArg = value as unknown as ChatSnapshot
  } else if (isLegacyOverrides(value)) {
    // The old `snapshot({turnTimings, turnEnds, nodes})` shape. Build a session
    // from the rest and a chat snapshot from the legacy overrides.
    const { turnTimings, turnEnds, nodes, ...rest } = value as LegacySnapshotOverrides & Record<string, unknown>
    sessionArg = sessionSnapshot(rest as Partial<SessionSnapshotFixture>)
    chatArg = chatSnapshot({
      ...(turnTimings !== undefined ? { turnTimings } : {}),
      ...(turnEnds !== undefined ? { turnEnds } : {}),
      ...(nodes !== undefined ? { nodes } : {}),
    })
  } else if ('openState' in value) {
    sessionArg = value as unknown as SessionSnapshotFixture
    chatArg = chat
  } else {
    const arg = sessionOrOverrides as ViewRenderProps
    sessionArg = arg.session ?? sessionSnapshot()
    chatArg = arg.chat
  }
  const sessionValue = sessionArg
  const chatValue = chatArg
  return {
    useSession: <T,>(selector: (state: SessionSnapshotFixture) => T) => selector(sessionValue),
    useChat: () => chatValue,
    t: translate,
  } as Parameters<typeof TurnscopeView>[0]
}

/**
 * The seats `TurnDetailView` needs.
 *
 * The cast is the same one `props` makes: the framework types `t` against the
 * locale registry, which maps a namespace to `string` keys, while the panel's own
 * `t` is keyed by the union its dictionaries define. The fixture's `t` is the
 * latter on purpose — it is the one that would catch a key the panel forgot to
 * translate.
 */
export const detailProps = (
  state: TurnDetailState,
  now = 0,
): Parameters<typeof TurnDetailView>[0] =>
  ({ state, now, t: translate } as unknown as Parameters<typeof TurnDetailView>[0])

/** The same seats, minus the one the connected view supplies itself. */
export const connectedProps = (
  sessionOrOverrides: SessionSnapshotFixture | ChatSnapshot | LegacySnapshotOverrides | ViewRenderProps,
  chat?: ChatSnapshot,
): Parameters<ReturnType<typeof createTurnscopeView>>[0] =>
  props(sessionOrOverrides, chat) as unknown as Parameters<ReturnType<typeof createTurnscopeView>>[0]

/** One recorded file change, with the attribution that makes it interesting. */
export const change = (
  path: string,
  overrides: Partial<TurnDetailData['changes'][number]> = {},
): TurnDetailData['changes'][number] => ({
  schemaVersion: 3,
  id: `c-${path}`,
  turnId: 't-1',
  path,
  kind: 'modified',
  attribution: 'AGENT',
  confidence: 'high',
  baseline: false,
  evidenceRefs: [],
  ...overrides,
})

type SafetyReason = NonNullable<TurnDetailData['safety']>['reasons'][number]

/** One reason a verdict gives, as the rule that produced it wrote it. */
export const reason = (code: string, overrides: Partial<SafetyReason> = {}): SafetyReason => ({
  code,
  title: `${code} title`,
  detail: `${code} detail`,
  severity: 'CAUTION',
  evidenceRefs: [],
  ...overrides,
})

/** The full verdict, as stored — `verdict()` above is only the summary's part. */
export const fullVerdict = (
  level: SafetySummaryDto['level'],
  overrides: Partial<NonNullable<TurnDetailData['safety']>> = {},
): NonNullable<TurnDetailData['safety']> => ({
  schemaVersion: 3,
  id: 'v-1',
  turnId: 't-1',
  level,
  reasons: [],
  allowedActions: [overrides.recommendedAction ?? 'INSPECT'],
  recommendedAction: 'INSPECT',
  evaluatedAt: 0,
  engineVersion: 1,
  ...overrides,
})

export const command = (
  command_: string,
  overrides: Partial<TurnDetailData['commands'][number]> = {},
): TurnDetailData['commands'][number] => ({
  schemaVersion: 3,
  id: `cmd-${command_}`,
  turnId: 't-1',
  command: command_,
  ...overrides,
})

export const test = (
  overrides: Partial<TurnDetailData['tests'][number]> = {},
): TurnDetailData['tests'][number] => ({
  schemaVersion: 3,
  id: 'test-1',
  turnId: 't-1',
  kind: 'test',
  status: 'passed',
  summary: '3 passed',
  ...overrides,
})

/** A turn's recorded detail: the row's counts, and nothing recorded under them. */
export const detail = (overrides: Partial<TurnDetailData> = {}): TurnDetailData => ({
  summary: row(1),
  changes: [],
  commands: [],
  tests: [],
  ...overrides,
})

/** One side of a comparison, present unless a test says otherwise. */
export const side = (
  overrides: Partial<GetDiffData['diff']['before']> = {},
): GetDiffData['diff']['before'] => ({
  source: 'recovery-blob',
  byteSize: 10,
  lineCount: 1,
  endsWithNewline: true,
  ...overrides,
})

type DiffAvailability = GetDiffData['diff']['availability']
type DiffHunk = Extract<DiffAvailability, { kind: 'text' }>['hunks'][number]
type DiffLine = DiffHunk['lines'][number]

/** One line of a comparison. */
export const line = (
  kind: DiffLine['kind'],
  text: string,
  beforeLine?: number,
  afterLine?: number,
): DiffLine => ({
  kind,
  text,
  ...(beforeLine === undefined ? {} : { beforeLine }),
  ...(afterLine === undefined ? {} : { afterLine }),
})

/** One run of changes, with the four numbers unified diff's header carries. */
export const hunk = (overrides: Partial<DiffHunk> = {}): DiffHunk => ({
  beforeStart: 1,
  beforeCount: 1,
  afterStart: 1,
  afterCount: 1,
  lines: [],
  ...overrides,
})

/** A path's diff, available and textual unless a test says otherwise. */
export const fileDiff = (
  path: string,
  overrides: Partial<GetDiffData['diff']> = {},
): GetDiffData['diff'] => ({
  path,
  kind: 'modified',
  attribution: 'AGENT',
  confidence: 'high',
  baseline: false,
  before: side(),
  after: side(),
  availability: { kind: 'text', hunks: [], truncated: false },
  ...overrides,
})

/** A detail feed in whatever state a test needs, without a host or a promise. */
export const detailWiring = (options: {
  readonly states?: ReadonlyMap<string, TurnDetailState>
  readonly expanded?: Iterable<string>
  readonly now?: number
  readonly diffs?: FileDiffFeed
} = {}): TurnDetailWiring => {
  const feed: TurnDetailFeed = {
    states: options.states ?? new Map(),
    expanded: new Set(options.expanded ?? []),
    toggle: vi.fn(),
  }
  return { feed, now: options.now ?? 0, diffs: options.diffs ?? diffFeed() }
}

/** A diff feed in whatever state a test needs, without a host or a promise. */
export const diffFeed = (
  states: ReadonlyMap<string, FileDiffState> = new Map(),
  selected?: string,
): FileDiffFeed => ({ states, selected, select: vi.fn() })

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
  detailReply: ReplyRead<TurnDetailData> = { kind: 'absent' },
  diffReply: ReplyRead<GetDiffData> = { kind: 'absent' },
): HostDouble {
  const listTurns = vi.fn(async () => listReply)
  const getTurnDetail = vi.fn(async () => detailReply)
  const getDiff = vi.fn(async () => diffReply)
  const evaluateSafety = vi.fn(async () => ({ kind: 'absent' as const }))
  return {
    host: { listTurns, getTurnDetail, getDiff, evaluateSafety } as unknown as TurnscopeHostApi,
    listTurns,
    getTurnDetail,
    getDiff,
    evaluateSafety,
  }
}
