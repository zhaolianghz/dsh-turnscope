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
  GetTurnDetailRequest,
  ListTurnsData,
  ListTurnsRequest,
  SafetySummaryDto,
  TurnDetailData,
  TurnSummaryDto,
  TurnscopeApiEnvelope,
  TurnscopeLookupReply,
} from '../../shared/contracts/api.ts'
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
}

/** Clamp a client-supplied page size into something a SQLite read can serve. */
const clampLimit = (requested: number): number => {
  if (!Number.isFinite(requested)) return TURN_PAGE_LIMIT.default
  return Math.max(1, Math.min(TURN_PAGE_LIMIT.max, Math.trunc(requested)))
}

export function createQueryService(deps: QueryDeps): QueryService {
  const { sink, inspector } = deps

  const summarize = (
    turn: TurnRecord,
    changeCount: number,
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
    changeCount,
    ...(safety === undefined ? {} : { safety }),
  })

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
        sink.countFileChanges(turnIds),
        sink.latestVerdicts(turnIds),
      ])

      return envelope<ListTurnsData>({
        turns: page.turns.map(turn =>
          summarize(turn, counts.get(turn.id) ?? 0, summaryOf(verdicts.get(turn.id))),
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
        summary: summarize(turn, changes.length, summaryOf(verdict)),
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

      return lookup<EvaluateSafetyData>({
        verdict: result.verdict,
        changeCount: result.changeSet?.changes.length ?? 0,
      })
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
