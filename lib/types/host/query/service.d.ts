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
import type { EvaluateSafetyData, EvaluateSafetyRequest, GetDiffData, GetDiffRequest, GetTurnDetailRequest, ListTurnsData, ListTurnsRequest, TurnDetailData, TurnscopeApiEnvelope, TurnscopeLookupReply } from '../../shared/contracts/api.ts';
import type { FileDiffReader } from '../diff/reader.ts';
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
export interface QueryDeps {
    readonly sink: QuerySink;
    /**
     * Used only by `evaluateSafety`. The rest of the API answers from storage.
     */
    readonly inspector: TurnInspector;
    /**
     * Used only by `getDiff`.
     *
     * Injected rather than built here because it reads git and the object store,
     * and this module's whole reason for existing is that it does neither — it
     * answers from the sink (`docs/ARCHITECTURE.md §28`).
     */
    readonly diffs: FileDiffReader;
}
export interface QueryService {
    listTurns(request: ListTurnsRequest): Promise<TurnscopeApiEnvelope<ListTurnsData>>;
    /**
     * `data: null` when there is no such turn.
     *
     * The absence travels *inside* the reply rather than as an absent reply,
     * because the transport cannot carry `undefined` and because "no such turn"
     * and "no usable answer" are different things a UI shows differently.
     */
    getTurnDetail(request: GetTurnDetailRequest): Promise<TurnscopeLookupReply<TurnDetailData>>;
    /** `data: null` when there is no such turn, or no workspace to evaluate against. */
    evaluateSafety(request: EvaluateSafetyRequest): Promise<TurnscopeLookupReply<EvaluateSafetyData>>;
    /**
     * `data: null` when there is nothing to compare: no such turn, no workspace, or
     * a path this turn did not change.
     *
     * All three answer the same way because they mean the same thing to a reader —
     * "there is no such change" — and none of them is an error. The separate
     * `availability` field inside a returned diff is where "there *is* a change and
     * we cannot show it" goes, which is a different sentence and a different fix.
     */
    getDiff(request: GetDiffRequest): Promise<TurnscopeLookupReply<GetDiffData>>;
}
export declare function createQueryService(deps: QueryDeps): QueryService;
/** Re-exported so a caller can check the version it is talking to. */
export { API_VERSION };
//# sourceMappingURL=service.d.ts.map