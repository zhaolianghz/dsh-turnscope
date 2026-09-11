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
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { API_VERSION, REMOTE_NAMESPACE } from '../../../shared/contracts/api.ts'
import type {
  EvaluateSafetyRequest,
  GetDiffRequest,
  GetTurnDetailRequest,
  ListTurnsRequest,
} from '../../../shared/contracts/api.ts'
import type { Diagnostics } from '../../../diagnostics.ts'
import type { QueryService } from '../../query/service.ts'

/** The package the descriptors are attributed to, as generated artifacts do. */
export const REMOTE_PACKAGE = '@zhaolianghz/dsh-turnscope'

/** One request parameter in, one JSON result out — the same shape markers produce. */
const REQUEST_PARAMETER = { name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } } as const

const descriptor = (method: string): InvocationDescriptor => ({
  id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${method}`,
  service: REMOTE_NAMESPACE,
  namespace: REMOTE_NAMESPACE,
  method,
  invocation: { kind: 'direct' },
  parameters: [REQUEST_PARAMETER],
  result: { mode: 'src-json' },
})

/**
 * The four endpoints of `docs/ARCHITECTURE.md §28`, in the order the gateway will
 * see them.
 *
 * A descriptor is a claim that the endpoint answers, so this list is the whole
 * statement of what this host exposes — an entry without a method behind it would
 * be an endpoint that 500s, and the smoke harness in
 * `docs/spikes/client-remote-smoke/` calls one of these against a real gateway.
 */
export const TURNSCOPE_INVOCATIONS: readonly InvocationDescriptor[] = [
  descriptor('listTurns'),
  descriptor('getTurnDetail'),
  descriptor('getDiff'),
  descriptor('evaluateSafety'),
]

/** The contribution handed to the registry; the descriptors plus their owner. */
export const TURNSCOPE_CONTRIBUTION: TypertContribution = {
  package: REMOTE_PACKAGE,
  face: 'host',
  // No generated Zod schemas: `src-json` is the codec mode that does not need
  // them, and an empty array is what "this package generated no schemas" means.
  schemas: [],
  model: {
    services: [
      { key: REMOTE_NAMESPACE, exportName: 'TurnscopeRemoteService', members: [], types: [], tags: [] },
    ],
    events: [],
    objects: [],
  },
  invocations: TURNSCOPE_INVOCATIONS,
}

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
export class TurnscopeRemoteService extends TypertRemoteService {
  /** The read side, injected rather than built here so a test can stand in for it. */
  readonly query: QueryService

  constructor(ctx: Context, query: QueryService) {
    super(ctx, REMOTE_NAMESPACE)
    this.query = query
  }

  listTurns(request: ListTurnsRequest) {
    return this.query.listTurns(requireListTurnsRequest(request))
  }

  getTurnDetail(request: GetTurnDetailRequest) {
    return this.query.getTurnDetail(requireTurnRequest<GetTurnDetailRequest>(request))
  }

  evaluateSafety(request: EvaluateSafetyRequest) {
    return this.query.evaluateSafety(requireTurnRequest<EvaluateSafetyRequest>(request))
  }

  getDiff(request: GetDiffRequest) {
    return this.query.getDiff(requireGetDiffRequest(request))
  }
}

/**
 * Reject a request the codec above would have passed through.
 *
 * Throwing rather than returning a business failure is deliberate: none of these
 * are things a user did. They are a client and a host disagreeing about their
 * own contract, and the gateway reports an unexpected throw as an `internal`
 * error whose message reaches the developer. Modelling them as outcomes would
 * put a discriminator on every reply so that one caller could render "your
 * bundle is stale" — which the client can already see from `API_VERSION`.
 */
function requireRequest(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${REMOTE_NAMESPACE}: request must be an object`)
  }
  const request = value as Record<string, unknown>
  if (request['apiVersion'] !== API_VERSION) {
    throw new Error(
      `${REMOTE_NAMESPACE}: client apiVersion ${String(request['apiVersion'])} does not match host ${API_VERSION}`,
    )
  }
  for (const field of fields) {
    const held = request[field]
    if (typeof held !== 'string' || held.length === 0) {
      throw new Error(`${REMOTE_NAMESPACE}: request field ${JSON.stringify(field)} must be a non-empty string`)
    }
  }
  return request
}

function requireListTurnsRequest(value: unknown): ListTurnsRequest {
  const request = requireRequest(value, ['sessionId'])
  const cursor = request['cursor']
  if (cursor !== undefined && typeof cursor !== 'number') {
    throw new Error(`${REMOTE_NAMESPACE}: request field "cursor" must be a number`)
  }
  return request as unknown as ListTurnsRequest
}

function requireTurnRequest<T>(value: unknown): T {
  return requireRequest(value, ['turnId']) as unknown as T
}

function requireGetDiffRequest(value: unknown): GetDiffRequest {
  // The path is checked to be a non-empty string and nothing more. Whether it
  // names a change of this turn is a *question the query answers*, not a
  // validation: rejecting it here would need this layer to read the database.
  return requireRequest(value, ['turnId', 'path']) as unknown as GetDiffRequest
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
export function mountTurnscopeRemoteWhenReady(
  ctx: Context,
  query: QueryService,
  diagnostics: Diagnostics,
): () => void {
  const fiber = ctx.inject(['typert'], scoped => {
    const unmount = mountTurnscopeRemote(scoped, query, diagnostics)
    scoped.effect(() => unmount, 'turnscope remote face')
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    // Disposal is asynchronous and happens during shutdown, after the recorder
    // has already been flushed and the index closed. An unhandled rejection here
    // would be reported against an unrelated part of the process, so a failure
    // to take the face away cleanly is a diagnostic like every other cleanup
    // failure in this file — and, like them, never fatal.
    void Promise.resolve(fiber.dispose()).catch((error: unknown) => {
      diagnostics.record({
        at: Date.now(),
        code: 'trace.remote-withdraw-failed',
        message: describe(error),
      })
    })
  }
}

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
export function mountTurnscopeRemote(
  ctx: Context,
  query: QueryService,
  diagnostics: Diagnostics,
): () => void {
  try {
    // `ctx.typert` is typed non-optional, but the type is a declaration of
    // intent rather than a runtime fact: accessing an unprovided service key on
    // a Cordis context yields `undefined`. This check is the part that is true.
    const registry: typeof ctx.typert | undefined = ctx.typert
    if (registry === undefined || typeof registry.register !== 'function') {
      // Not an error: the plugin is allowed to load into a host that has no
      // client-facing surface at all.
      diagnostics.record({
        at: Date.now(),
        code: 'trace.remote-unavailable',
        message: 'no typert registry on this host; the turn API is not exposed',
      })
      return () => {}
    }

    // Constructing the service is what provides it: the `Service` base registers
    // it on the current fiber, so it is released when the plugin unloads. It has
    // to exist before the descriptors are registered, or a request arriving
    // between the two would find a descriptor pointing at nothing.
    new TurnscopeRemoteService(ctx, query)
    const withdraw = registry.register(TURNSCOPE_CONTRIBUTION)

    let mounted = true
    return () => {
      if (!mounted) return
      mounted = false
      try {
        withdraw()
      } catch (error) {
        diagnostics.record({
          at: Date.now(),
          code: 'trace.remote-withdraw-failed',
          message: describe(error),
        })
      }
    }
  } catch (error) {
    diagnostics.record({
      at: Date.now(),
      code: 'trace.remote-mount-failed',
      message: describe(error),
    })
    return () => {}
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
