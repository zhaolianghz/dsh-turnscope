/**
 * The read side of the host API: what a client asks, answered from what was
 * recorded.
 *
 * Every method here is a *question*, never a side effect, with one deliberate
 * exception — `evaluateSafety`, which has to take a fresh look at the workspace
 * to be worth anything (`docs/ARCHITECTURE.md §16`). That exception is why the
 * two families are separate methods rather than two flags on one: reading the
 * detail view is cheap and can happen on every scroll, while evaluating is a
 * handful of git subprocesses and only happens when someone asks.
 *
 * Nothing here reads `node:sqlite` or touches git directly. Both cross a port on
 * the way in, which is what keeps the client from ever needing either
 * (`docs/ARCHITECTURE.md §28`) and what makes all of this testable against an
 * in-memory page of records.
 */
import { API_VERSION, TURN_PAGE_LIMIT, envelope, lookup } from '../../shared/contracts/api.ts'
import type {
  EvaluateSafetyData,
  EvaluateSafetyRequest,
  GetDiffData,
  GetDiffRequest,
  GetTurnDetailRequest,
  ListTurnsData,
  ListTurnsRequest,
  SafetySummaryDto,
  TurnDetailData,
  TurnSummaryDto,
  TurnscopeApiEnvelope,
  TurnscopeLookupReply,
} from '../../shared/contracts/api.ts'
import type { FileDiffReader } from '../diff/reader.ts'
import type { SafetyVerdict, TurnRecord } from '../domain/types.ts'
import type { TurnInspector, TurnWorkspace } from '../inspection/types.ts'
import type { TraceRepository } from '../storage/repository.ts'

/**
 * The storage reads this service performs.
 *
 * Narrower than {@link TraceRepository} so that a test can hand it a handful of
 * in-memory rows, and so that adding a write to the repository cannot quietly
 * make a read path able to write.
 */
export type QuerySink = Pick<
  TraceRepository,
  | 'listTurns'
  | 'getTurn'
  | 'getWorkspace'
  | 'listFileChanges'
  | 'countFileChanges'
  | 'countFileChangesByAttribution'
  | 'listCommands'
  | 'listTests'
  | 'getLatestVerdict'
  | 'latestVerdicts'
>

export interface QueryDeps {
  readonly sink: QuerySink
  /**
   * Used only by `evaluateSafety`. The rest of the API answers from storage.
   */
  readonly inspector: TurnInspector
  /**
   * Used only by `getDiff`.
   *
   * Injected rather than built here because it reads git and the object store,
   * and this module's whole reason for existing is that it does neither — it
   * answers from the sink (`docs/ARCHITECTURE.md §28`).
   */
  readonly diffs: FileDiffReader
}

export interface QueryService {
  listTurns(request: ListTurnsRequest): Promise<TurnscopeApiEnvelope<ListTurnsData>>
  /**
   * `data: null` when there is no such turn.
   *
   * The absence travels *inside* the reply rather than as an absent reply,
   * because the transport cannot carry `undefined` and because "no such turn"
   * and "no usable answer" are different things a UI shows differently.
   */
  getTurnDetail(request: GetTurnDetailRequest): Promise<TurnscopeLookupReply<TurnDetailData>>
  /** `data: null` when there is no such turn, or no workspace to evaluate against. */
  evaluateSafety(request: EvaluateSafetyRequest): Promise<TurnscopeLookupReply<EvaluateSafetyData>>
  /**
   * `data: null` when there is nothing to compare: no such turn, no workspace, or
   * a path this turn did not change.
   *
   * All three answer the same way because they mean the same thing to a reader —
   * "there is no such change" — and none of them is an error. The separate
   * `availability` field inside a returned diff is where "there *is* a change and
   * we cannot show it" goes, which is a different sentence and a different fix.
   */
  getDiff(request: GetDiffRequest): Promise<TurnscopeLookupReply<GetDiffData>>
}

/** Clamp a client-supplied page size into something a SQLite read can serve. */
const clampLimit = (requested: number): number => {
  if (!Number.isFinite(requested)) return TURN_PAGE_LIMIT.default
  return Math.max(1, Math.min(TURN_PAGE_LIMIT.max, Math.trunc(requested)))
}

export function createQueryService(deps: QueryDeps): QueryService {
  const { sink, inspector, diffs } = deps

  const summarizeCounts = (
    changes: readonly { readonly kind: string; readonly baseline: boolean }[],
  ): { readonly agent: number; readonly baseline: number } => {
    let agent = 0
    let baseline = 0
    for (const change of changes) {
      if (change.kind === 'noop') continue
      if (change.baseline) baseline += 1
      else agent += 1
    }
    return { agent, baseline }
  }

  const summarize = (
    turn: TurnRecord,
    counts: { readonly agent: number; readonly baseline: number },
    safety: SafetySummaryDto | undefined,
  ): TurnSummaryDto => ({
    turnId: turn.id,
    sessionId: turn.sessionId,
    ordinal: turn.ordinal,
    status: turn.status,
    startedAt: turn.startedAt,
    ...(turn.endedAt === undefined ? {} : { endedAt: turn.endedAt }),
    activityCount: turn.activityCount,
    errorCount: turn.errorCount,
    evidenceCompleteness: turn.evidenceCompleteness,
    changeCount: counts.agent + counts.baseline,
    agentChangeCount: counts.agent,
    baselineChangeCount: counts.baseline,
    ...(safety === undefined ? {} : { safety }),
  })

  const zeroCounts = { agent: 0, baseline: 0 }

  return {
    listTurns: async request => {
      const page = await sink.listTurns(request.sessionId, {
        limit: clampLimit(request.limit),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      })
      const turnIds = page.turns.map(turn => turn.id)

      // Two grouped reads instead of two per row. The list refreshes while a
      // turn runs, so a per-row lookup here would put 2N statements on the path
      // a user watches (`docs/ARCHITECTURE.md §44.3`).
      const [counts, verdicts] = await Promise.all([
        sink.countFileChangesByAttribution(turnIds),
        sink.latestVerdicts(turnIds),
      ])

      return envelope<ListTurnsData>({
        turns: page.turns.map(turn =>
          summarize(turn, counts.get(turn.id) ?? zeroCounts, summaryOf(verdicts.get(turn.id))),
        ),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      })
    },

    getTurnDetail: async request => {
      const turn = await sink.getTurn(request.turnId)
      if (turn === undefined) return lookup<TurnDetailData>(undefined)

      // The four reads are independent, so they are issued together rather than
      // awaited in sequence: the detail view is opened on click, and four
      // round trips of latency are visible where one is not.
      const [changes, commands, tests, verdict] = await Promise.all([
        sink.listFileChanges(turn.id),
        sink.listCommands(turn.id),
        sink.listTests(turn.id),
        sink.getLatestVerdict(turn.id),
      ])

      return lookup<TurnDetailData>({
        summary: summarize(turn, summarizeCounts(changes), summaryOf(verdict)),
        changes,
        commands,
        tests,
        ...(verdict === undefined ? {} : { safety: verdict }),
      })
    },

    evaluateSafety: async request => {
      const turn = await sink.getTurn(request.turnId)
      if (turn === undefined) return lookup<EvaluateSafetyData>(undefined)

      // The workspace is looked up rather than remembered because a refresh can
      // arrive long after the turn, in a different process lifetime. Without a
      // repository root there is no workspace to observe, and inventing one
      // would mean judging against the wrong tree; the honest answer is that we
      // cannot answer.
      const workspace = await sink.getWorkspace(turn.workspaceId)
      if (workspace === undefined) return lookup<EvaluateSafetyData>(undefined)

      const result = await inspector.refresh(turn, toTurnWorkspace(workspace))

      const counts = summarizeCounts(result.changeSet?.changes ?? [])
      return lookup<EvaluateSafetyData>({
        verdict: result.verdict,
        changeCount: counts.agent + counts.baseline,
        agentChangeCount: counts.agent,
        baselineChangeCount: counts.baseline,
      })
    },

    getDiff: async request => {
      const turn = await sink.getTurn(request.turnId)
      if (turn === undefined) return lookup<GetDiffData>(undefined)

      // Like `evaluateSafety`, the workspace is looked up rather than remembered.
      // It is only needed for the *before* side of a file that was clean when the
      // turn began, but the reader decides that, so it is passed the root to use
      // or not use.
      const workspace = await sink.getWorkspace(turn.workspaceId)
      if (workspace === undefined) return lookup<GetDiffData>(undefined)

      const diff = await diffs.read(turn, toTurnWorkspace(workspace), request.path)
      return lookup<GetDiffData>(diff === undefined ? undefined : { diff })
    },
  }
}

/** The workspace identity the inspector needs, from the stored record. */
const toTurnWorkspace = (workspace: {
  readonly id: string
  readonly repoRoot: string
}): TurnWorkspace => ({ workspaceId: workspace.id, repoRoot: workspace.repoRoot })

/**
 * Reduce a stored verdict to the three fields a list row shows.
 *
 * The full reasons are dropped here on purpose: they are the expensive part of
 * a verdict and the list does not render them, so a page of thirty turns would
 * carry thirty reason sets across the bridge to display two words each.
 */
const summaryOf = (verdict: SafetyVerdict | undefined): SafetySummaryDto | undefined =>
  verdict === undefined
    ? undefined
    : {
        level: verdict.level,
        recommendedAction: verdict.recommendedAction,
        evaluatedAt: verdict.evaluatedAt,
      }

/** Re-exported so a caller can check the version it is talking to. */
export { API_VERSION }
