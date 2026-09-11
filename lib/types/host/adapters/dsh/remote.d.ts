/**
 * The host's Remote face: how a browser asks about a turn.
 *
 * ## Why this is hand-written
 *
 * First-party DSH packages ship two generated artifacts — `lib/typert.host.js`
 * and `lib/typert.remote-client.js` — produced by `@deepseek-ai/dsh-typert-generator`,
 * which is not published. The other published route is decorators, and the TC39
 * decorator syntax is a build-time error in both of this repository's bundler
 * chains. What is left is the third route, which is the one this file takes and
 * which the generated artifact takes internally: describe each invocation by
 * hand and hand it to the public `TypertRegistry.register()`.
 *
 * The proof that this works against the real registry and the real gateway,
 * rather than against a reading of the contract, is
 * `tests/host/adapters/third-party-remote.spec.ts`; that probe is kept as a
 * resident contract test because this whole file rests on it
 * (`docs/ARCHITECTURE.md §36`).
 *
 * ## What crosses the wire, and what does not
 *
 * The gateway's `src-json` codec is a **pass-through**: it asserts that the
 * value is JSON-representable and returns it unchanged. It validates nothing
 * about the request's shape. So this layer is where a request from a
 * stale-or-hostile client is checked, and it is the last place that can: below
 * it, a `sessionId` that arrived as `undefined` becomes a SQLite bind error with
 * a message about parameter types.
 *
 * The check that matters most is `apiVersion`. A browser bundle can outlive a
 * host upgrade, and without this the mismatch would surface as a page of
 * `undefined` fields rather than as one sentence naming both versions.
 */
import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import type { ApplyRewindRequest, EvaluateSafetyRequest, GetDiffRequest, GetTurnDetailRequest, ListRecoveryPlansRequest, ListTurnsRequest, PreviewRewindRequest } from '../../../shared/contracts/api.ts';
import type { Diagnostics } from '../../../diagnostics.ts';
import type { QueryService } from '../../query/service.ts';
import type { RecoveryService } from '../../recovery/service.ts';
/** The package the descriptors are attributed to, as generated artifacts do. */
export declare const REMOTE_PACKAGE = "@zhaolianghz/dsh-turnscope";
/**
 * The four endpoints of `docs/ARCHITECTURE.md §28`, in the order the gateway will
 * see them.
 *
 * A descriptor is a claim that the endpoint answers, so this list is the whole
 * statement of what this host exposes — an entry without a method behind it would
 * be an endpoint that 500s, and the smoke harness in
 * `docs/spikes/client-remote-smoke/` calls one of these against a real gateway.
 */
export declare const TURNSCOPE_INVOCATIONS: readonly InvocationDescriptor[];
/** The contribution handed to the registry; the descriptors plus their owner. */
export declare const TURNSCOPE_CONTRIBUTION: TypertContribution;
/**
 * The service the gateway dispatches into.
 *
 * It extends {@link TypertRemoteService} not for the markers — there are none,
 * and the decorator syntax it comes with is unusable here — but because the base
 * constructor is what assigns the `typertRemote` binding that the gateway's
 * `validateBinding` reads off the live instance. Without it, dispatch fails with
 * `Service "turnscope" has no visible typertRemote binding`.
 *
 * The dependency is a plain field rather than a `#private` one on purpose: the
 * gateway reaches the service through `ctx.get()`, which wraps it in a traceable
 * `Proxy`, and `this` inside a dispatched method is that proxy. Ordinary
 * properties are forwarded through it; a private field would throw
 * `Cannot read private member`, because the proxy is not the object that
 * declared it. The class methods also take exactly one non-destructured
 * parameter each, which is what the gateway's argument parser requires.
 */
export declare class TurnscopeRemoteService extends TypertRemoteService {
    /** The read side, injected rather than built here so a test can stand in for it. */
    readonly query: QueryService;
    /** The recovery side; side-effecting by design. */
    readonly recovery: RecoveryService;
    constructor(ctx: Context, query: QueryService, recovery: RecoveryService);
    listTurns(request: ListTurnsRequest): Promise<import("../../../shared/contracts/api.ts").TurnscopeApiEnvelope<import("../../../shared/contracts/api.ts").ListTurnsData>>;
    getTurnDetail(request: GetTurnDetailRequest): Promise<import("../../../shared/contracts/api.ts").TurnscopeLookupReply<import("../../../shared/contracts/api.ts").TurnDetailData>>;
    evaluateSafety(request: EvaluateSafetyRequest): Promise<import("../../../shared/contracts/api.ts").TurnscopeLookupReply<import("../../../shared/contracts/api.ts").EvaluateSafetyData>>;
    getDiff(request: GetDiffRequest): Promise<import("../../../shared/contracts/api.ts").TurnscopeLookupReply<import("../../../shared/contracts/api.ts").GetDiffData>>;
    previewRewind(request: PreviewRewindRequest): Promise<import("../../../shared/contracts/api.ts").TurnscopeApiEnvelope<import("../../../shared/contracts/api.ts").PreviewRewindData>>;
    applyRewind(request: ApplyRewindRequest): Promise<import("../../../shared/contracts/api.ts").TurnscopeApiEnvelope<import("../../../shared/contracts/api.ts").ApplyRewindData>>;
    listRecoveryPlans(request: ListRecoveryPlansRequest): Promise<import("../../../shared/contracts/api.ts").TurnscopeApiEnvelope<import("../../../shared/contracts/api.ts").ListRecoveryPlansData>>;
}
/**
 * Mount the Remote face once the Typert registry exists.
 *
 * The registry is a sibling plugin and plugin start order is not ours to choose:
 * on a real web profile the gateway is provided *after* this plugin has already
 * applied, so reading `ctx.typert` at that moment legitimately finds nothing.
 * That is measured, not assumed — the smoke run in
 * `docs/spikes/client-remote-smoke/` answered `HTTP 404` for our endpoint until
 * this deferral existed, while the first-party endpoint on the same channel was
 * being dispatched by the same gateway.
 *
 * `ctx.inject` is Cordis's own answer: the callback runs when the service
 * appears, and again if it is replaced. The mount's disposer is registered as an
 * effect of the callback's fiber, so a re-run withdraws the old descriptors
 * before the new ones are claimed.
 *
 * A host that never provides a registry simply never mounts, which is the same
 * outcome as {@link mountTurnscopeRemote}'s no-op — and the reason there is
 * nothing to record here: a profile with no gateway has no API to lose.
 *
 * @returns a disposer that cancels the wait, safe to call twice.
 */
export declare function mountTurnscopeRemoteWhenReady(ctx: Context, query: QueryService, recovery: RecoveryService, diagnostics: Diagnostics): () => void;
/**
 * Mount the Remote face on a live host context.
 *
 * Best-effort by construction. A host without the Typert gateway — an isolated
 * profile carrying only the base bundle, or a future DSH that moves the registry
 * — must lose the API and keep recording, because recording is the part that
 * cannot be recovered later. So every failure here is a diagnostic and a no-op
 * disposer rather than an exception.
 *
 * @returns a disposer that withdraws the descriptors, safe to call twice.
 */
export declare function mountTurnscopeRemote(ctx: Context, query: QueryService, recovery: RecoveryService, diagnostics: Diagnostics): () => void;
//# sourceMappingURL=remote.d.ts.map