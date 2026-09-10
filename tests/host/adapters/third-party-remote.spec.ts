/**
 * Contract probe: can a *third-party* plugin expose a Remote to the DSH client?
 *
 * This is the single upstream assumption the V0.1 client half rests on, and it
 * is not obvious. Every first-party package ships two generated artifacts
 * (`lib/typert.host.js`, `lib/typert.remote-client.js`) produced by
 * `@deepseek-ai/dsh-typert-generator`, which is **not published** — so the
 * first-party recipe cannot simply be copied.
 *
 * There are exactly two published routes to registering an endpoint:
 *
 * 1. **Decorator markers.** Mark methods `@Remote('name')` and let the gateway
 *    reflect them off live services ("SRC markers"), needing no generated
 *    artifact. **Not available to us**: the marker is written by a decorator,
 *    and neither Vitest/Vite 8 nor tsdown's rolldown pipeline transforms the
 *    TC39 decorator syntax — `@Remote` is a build-time syntax error, not a
 *    runtime failure.
 * 2. **An explicit contribution.** Hand-write the `InvocationDescriptor`s and
 *    register them through the public `TypertRegistry.register()`, which is what
 *    the generated `typert.host.js` does. `TypertCodec` admits a `src-json`
 *    mode, so no generated zod schema is required either.
 *
 * The `TypertRemoteService` base class is still required either way — not for
 * its markers but because it is what assigns the `typertRemote` binding the
 * gateway's `validateBinding` reads off the live service instance. Only the
 * decorator is unusable; the base class is not.
 *
 * This file pins route 2 against the real registry and the real gateway — not a
 * mock — because that is the route the plan commits to, and because hand-written
 * descriptors are exactly the shape TECH §36's compatibility adapter layer wants.
 *
 * What the client half needs on top (`ctx.connection.rpc.call('/api', …)`) is a
 * published type but needs a browser to observe end to end; that belongs to the
 * Phase F boot smoke test.
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import ApiGateway from '@deepseek-ai/dsh-api-gateway'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'

type RpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>

/** The one interceptor the gateway installs on the shared channel. */
interface CapturedInterceptor {
  readonly channel: string
  readonly matches: (endpoint: string) => boolean
  readonly handler: RpcHandler
}

/** A plain Remote service: bound like a first-party one, but undecorated. */
class SmokeApi extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'smoke')
  }

  ping(request: { readonly echo: string }): { readonly pong: string } {
    return { pong: `pong:${request.echo}` }
  }
}

const PACKAGE = '@zhaolianghz/dsh-turnscope'

/**
 * The hand-written equivalent of `lib/typert.host.js`: one `src-json` parameter
 * in, one `src-json` result out. `src-json` is the mode the gateway synthesises
 * for marker-discovered services, so this is the same contract that route 1
 * would have produced — minus the build tooling.
 */
const PING_DESCRIPTOR: InvocationDescriptor = {
  id: `${PACKAGE}#smoke/ping`,
  service: 'smoke',
  namespace: 'smoke',
  method: 'ping',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } }],
  result: { mode: 'src-json' },
}

/** The shape the client transport hands the gateway. */
interface DispatchResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: unknown
}

const payload = (args: Readonly<Record<string, unknown>>): unknown => ({ args })

interface Bench {
  readonly ctx: Context
  readonly captured: CapturedInterceptor
  dispose(): Promise<void>
}

async function mount(): Promise<Bench> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  const captured: CapturedInterceptor[] = []

  // Stands in for the client-connection service the gateway intercepts: it only
  // records what the gateway registers on the channel.
  ctx.provide('connection', {
    rpc: {
      intercept: (
        channel: string,
        matches: (endpoint: string) => boolean,
        handler: RpcHandler,
      ): (() => Promise<void>) => {
        captured.push({ channel, matches, handler })
        return async () => {}
      },
      handle: (): (() => Promise<void>) => async () => {},
    },
  })

  fibers.push(await ctx.plugin(TypertRegistry).await())
  fibers.push(await ctx.plugin(ApiGateway).await())
  fibers.push(await ctx.plugin(SmokeApi).await())

  // Registering the contribution is what a third-party plugin does in `apply`.
  // The generated artifact does it from module scope; we do it explicitly.
  const registry = (ctx as unknown as { typert: TypertRegistry }).typert
  registry.register({
    package: PACKAGE,
    face: 'host',
    schemas: [],
    model: {
      services: [{ key: 'smoke', exportName: 'SmokeApi', members: [], types: [], tags: [] }],
      events: [],
      objects: [],
    },
    invocations: [PING_DESCRIPTOR],
  })

  const first = captured[0]
  if (first === undefined) throw new Error('the gateway installed no interceptor')
  return {
    ctx,
    captured: first,
    dispose: async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

describe('third-party Remote exposure', () => {
  it('claims a hand-registered endpoint with no generated artifact', async () => {
    const bench = await mount()
    try {
      expect(bench.captured.channel).toBe('/api')
      expect(bench.captured.matches('smoke/ping')).toBe(true)
      // The claim set is this service's own endpoints, not a wildcard.
      expect(bench.captured.matches('smoke/absent')).toBe(false)
      expect(bench.captured.matches('messageFeedback/list')).toBe(false)
    } finally {
      await bench.dispose()
    }
  })

  it('dispatches the wire payload shape the generated client sends', async () => {
    const bench = await mount()
    try {
      const signal = new AbortController().signal
      const result = (await bench.captured.handler(
        'smoke/ping',
        payload({ request: { echo: 'hi' } }),
        signal,
      )) as DispatchResult

      expect(result.ok).toBe(true)
      expect(result.value).toEqual({ pong: 'pong:hi' })
    } finally {
      await bench.dispose()
    }
  })

  it('answers a malformed payload with a failure rather than throwing', async () => {
    const bench = await mount()
    try {
      const signal = new AbortController().signal
      const result = (await bench.captured.handler('smoke/ping', {}, signal)) as DispatchResult

      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
    } finally {
      await bench.dispose()
    }
  })
})
