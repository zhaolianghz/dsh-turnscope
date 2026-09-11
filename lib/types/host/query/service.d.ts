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
import { API_VERSION } from '../../shared/contracts/api.ts';
import type { EvaluateSafetyData, EvaluateSafetyRequest, GetTurnDetailRequest, ListTurnsData, ListTurnsRequest, TurnDetailData, TurnscopeApiEnvelope } from '../../shared/contracts/api.ts';
import type { TurnInspector } from '../inspection/types.ts';
import type { TraceRepository } from '../storage/repository.ts';
/**
 * The storage reads this service performs.
 *
 * Narrower than {@link TraceRepository} so that a test can hand it a handful of
 * in-memory rows, and so that adding a write to the repository cannot quietly
 * make a read path able to write.
 */
export type QuerySink = Pick<TraceRepository, 'listTurns' | 'getTurn' | 'getWorkspace' | 'listFileChanges' | 'countFileChanges' | 'listCommands' | 'listTests' | 'getLatestVerdict' | 'latestVerdicts'>;
/**
 * How many turns one page may hold.
 *
 * Clamped rather than trusted. The limit arrives from a browser, so it is user
 * input, and a page of a hundred thousand rows would be a self-inflicted denial
 * of service that no validation layer above this would catch — the request is
 * perfectly well-formed.
 */
export declare const TURN_PAGE_LIMIT: Readonly<{
    default: 30;
    max: 200;
}>;
export interface QueryDeps {
    readonly sink: QuerySink;
    /**
     * Used only by `evaluateSafety`. The rest of the API answers from storage.
     */
    readonly inspector: TurnInspector;
}
export interface QueryService {
    listTurns(request: ListTurnsRequest): Promise<TurnscopeApiEnvelope<ListTurnsData>>;
    /** `undefined` when there is no such turn. */
    getTurnDetail(request: GetTurnDetailRequest): Promise<TurnscopeApiEnvelope<TurnDetailData> | undefined>;
    /** `undefined` when there is no such turn, or no workspace to evaluate against. */
    evaluateSafety(request: EvaluateSafetyRequest): Promise<TurnscopeApiEnvelope<EvaluateSafetyData> | undefined>;
}
export declare function createQueryService(deps: QueryDeps): QueryService;
/** Re-exported so a caller can check the version it is talking to. */
export { API_VERSION };
//# sourceMappingURL=service.d.ts.map