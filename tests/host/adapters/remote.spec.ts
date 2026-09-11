/**
 * The host's Remote face, driven through the real gateway.
 *
 * Not a mock of the transport: the real `TypertRegistry`, the real
 * `ApiGateway`, and a real index behind the query service. The only stand-in is
 * the `connection` service, because standing in for it is what "capture the
 * interceptor the gateway installs" means — the gateway only ever calls
 * `rpc.intercept` on it.
 *
 * Two things here can only be found with the real gateway in the loop, and both
 * of them are the reason this file exists rather than more unit tests on the
 * service below it:
 *
 * - **The request path is a pass-through.** The `src-json` codec validates
 *   nothing, so `apiVersion` and the field shapes are checked by our adapter or
 *   by nobody. Without these tests that check is a comment.
 * - **A reply must be JSON-representable**, and the gateway is strict about it:
 *   an own property whose value is `undefined` makes it reject the whole result
 *   as a boundary failure. That is why a lookup replies `data: null` rather than
 *   omitting the field, and it is a rule that is invisible until it is hit.
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { Context } from '@deepseek-ai/cordis'
import ApiGateway from '@deepseek-ai/dsh-api-gateway'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_VERSION, REMOTE_NAMESPACE } from '../../../src/shared/contracts/api.ts'
import { Diagnostics } from '../../../src/diagnostics.ts'
import {
  TURNSCOPE_INVOCATIONS,
  mountTurnscopeRemote,
  mountTurnscopeRemoteWhenReady,
} from '../../../src/host/adapters/dsh/remote.ts'
import { SCHEMA_VERSION } from '../../../src/host/domain/types.ts'
import type { WorkspaceRecord } from '../../../src/host/domain/types.ts'
import type { TurnInspector } from '../../../src/host/inspection/types.ts'
import { createQueryService } from '../../../src/host/query/service.ts'
import { createRepository } from '../../../src/host/storage/repository.ts'
import type { TraceRepository } from '../../../src/host/storage/repository.ts'
import { openIndex } from '../../../src/host/storage/sqlite-index.ts'
import { change, turnRecord } from '../safety/support.ts'

type RpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>

interface Interceptor {
  readonly channel: string
  readonly matches: (endpoint: string) => boolean
  readonly handler: RpcHandler
}

interface DispatchResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

const TURN = 's-1:turn:3'

/** The same parameter shape the adapter registers, for the boundary probe below. */
const PROBE_PARAMETER = { name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } } as const

const workspace = (): WorkspaceRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id: 'ws-1',
  repoRoot: '/repo',
  repoRootHash: 'a'.repeat(64),
  settingsJson: '{}',
  createdAt: 1_700_000_000_000,
})

describe('the Remote face', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  /**
   * A host with the real gateway in front of a real index.
   *
   * The inspector is the one fake. What it is being asked is whether the
   * *call* arrives intact, and a real one would only add git subprocesses to a
   * test that is not about attribution.
   */
  const mount = async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'turnscope-remote-'))
    cleanups.push(async () => rm(dataRoot, { recursive: true, force: true }))
    const handle = await openIndex(join(dataRoot, 'index.sqlite3'))
    const repo: TraceRepository = createRepository(handle)
    cleanups.push(async () => repo.close())

    const refreshed: string[] = []
    const inspector: TurnInspector = {
      observe: async () => undefined,
      inspect: async () => undefined,
      refresh: async turn => {
        refreshed.push(turn.id)
        return {
          turnId: turn.id,
          changeSet: undefined,
          verdict: {
            schemaVersion: SCHEMA_VERSION,
            id: `${turn.id}:safety`,
            turnId: turn.id,
            level: 'SAFE',
            reasons: [],
            allowedActions: ['INSPECT', 'REWIND', 'FORK'],
            recommendedAction: 'REWIND',
            evaluatedAt: 1_700_000_099_000,
            engineVersion: 1,
          },
          current: undefined as never,
          pre: undefined,
          post: undefined,
        }
      },
      latestVerdict: async () => undefined,
    }

    await repo.upsertWorkspace(workspace())
    await repo.upsertTurn(turnRecord({ id: TURN }))

    const ctx = new Context()
    const captured: Interceptor[] = []
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
    const diagnostics = new Diagnostics()
    const fibers = [await ctx.plugin(TypertRegistry).await(), await ctx.plugin(ApiGateway).await()]
    cleanups.push(async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    })

    mountTurnscopeRemote(ctx, createQueryService({ sink: repo, inspector }), diagnostics)

    const target = captured[0]
    if (target === undefined) throw new Error('the gateway installed no interceptor')
    return {
      repo,
      diagnostics,
      refreshed,
      channel: target.channel,
      claims: (endpoint: string) => target.matches(endpoint),
      /** One call exactly as the browser transport makes it. */
      call: (endpoint: string, request: unknown): Promise<DispatchResult> =>
        target.handler(endpoint, { args: { request } }, new AbortController().signal) as Promise<DispatchResult>,
    }
  }

  it('claims its own three endpoints and nothing else', async () => {
    const host = await mount()

    expect(host.channel).toBe('/api')
    expect(TURNSCOPE_INVOCATIONS.map(descriptor => descriptor.method)).toEqual([
      'listTurns',
      'getTurnDetail',
      'evaluateSafety',
    ])
    for (const method of ['listTurns', 'getTurnDetail', 'evaluateSafety']) {
      expect(host.claims(`${REMOTE_NAMESPACE}/${method}`)).toBe(true)
    }
    // The claim is a set of endpoints, not a namespace wildcard and not a
    // catch-all: a request for something we did not register has to fall
    // through to whoever does own it, including the first-party services.
    expect(host.claims(`${REMOTE_NAMESPACE}/getDiff`)).toBe(false)
    expect(host.claims('messageFeedback/list')).toBe(false)
    expect(host.claims(REMOTE_NAMESPACE)).toBe(false)
  })

  it('answers the turn list through the registered descriptor', async () => {
    const host = await mount()
    await host.repo.putFileChange(change({ turnId: TURN, id: `${TURN}:chg:src/a.ts`, path: 'src/a.ts' }))

    const result = await host.call(`${REMOTE_NAMESPACE}/listTurns`, {
      apiVersion: API_VERSION,
      sessionId: 's-1',
      limit: 10,
    })

    expect(result.ok).toBe(true)
    expect(result.value).toEqual({
      apiVersion: API_VERSION,
      data: {
        turns: [
          expect.objectContaining({
            turnId: TURN,
            sessionId: 's-1',
            ordinal: 3,
            changeCount: 1,
          }),
        ],
      },
    })
  })

  it('carries a recorded turn detail across the boundary unaltered', async () => {
    const host = await mount()
    await host.repo.putFileChange(
      change({
        turnId: TURN,
        id: `${TURN}:chg:src/a.ts`,
        path: 'src/a.ts',
        beforeHash: 'sha256:v1',
        afterHash: 'sha256:v2',
        currentHash: 'sha256:v2',
        evidenceRefs: [`${TURN}:cp:post`],
      }),
    )

    const result = await host.call(`${REMOTE_NAMESPACE}/getTurnDetail`, {
      apiVersion: API_VERSION,
      turnId: TURN,
    })

    expect(result.ok).toBe(true)
    // The gateway refuses a result holding an own `undefined` property. The
    // stored change has three optional fields, two of them absent, so this is
    // the assertion that the row shapes are JSON-clean rather than merely
    // type-correct — and it is the one a browser would otherwise discover.
    expect(result.value).toEqual({
      apiVersion: API_VERSION,
      data: {
        summary: expect.objectContaining({ turnId: TURN }),
        changes: [
          {
            schemaVersion: SCHEMA_VERSION,
            id: `${TURN}:chg:src/a.ts`,
            turnId: TURN,
            path: 'src/a.ts',
            kind: 'modified',
            attribution: 'AGENT',
            confidence: 'high',
            baseline: false,
            evidenceRefs: [`${TURN}:cp:post`],
            beforeHash: 'sha256:v1',
            afterHash: 'sha256:v2',
            currentHash: 'sha256:v2',
          },
        ],
        commands: [],
        tests: [],
      },
    })
  })

  it('reports a missing turn as an answer rather than as a failure', async () => {
    const host = await mount()

    const result = await host.call(`${REMOTE_NAMESPACE}/getTurnDetail`, {
      apiVersion: API_VERSION,
      turnId: 's-1:turn:999',
    })

    expect(result.ok).toBe(true)
    // `null` and not an absent field: the transport cannot carry `undefined`,
    // and "there is no such turn" is the host's answer, not a transport fault.
    expect(result.value).toEqual({ apiVersion: API_VERSION, data: null })
  })

  it('re-evaluates through the service that takes a fresh observation', async () => {
    const host = await mount()

    const result = await host.call(`${REMOTE_NAMESPACE}/evaluateSafety`, {
      apiVersion: API_VERSION,
      turnId: TURN,
    })

    // The workspace is resolved on the host from the record, so this also shows
    // that the path from a request to a real observation is unbroken.
    expect(host.refreshed).toEqual([TURN])
    expect(result.value).toEqual({
      apiVersion: API_VERSION,
      data: { verdict: expect.objectContaining({ level: 'SAFE' }), changeCount: 0 },
    })
  })

  it('refuses a request from a client built against another contract version', async () => {
    const host = await mount()

    const result = await host.call(`${REMOTE_NAMESPACE}/listTurns`, {
      apiVersion: API_VERSION + 1,
      sessionId: 's-1',
      limit: 10,
    })

    expect(result.ok).toBe(false)
    // The codec above this is a pass-through, so if this check were not here a
    // stale bundle would be answered with a page of `undefined` fields and no
    // indication of why.
    expect(result.error?.message).toContain('apiVersion')
    expect(result.error?.message).toContain(String(API_VERSION))
  })

  it('refuses a request that is missing what it needs', async () => {
    const host = await mount()

    const malformed = [
      { apiVersion: API_VERSION },
      { apiVersion: API_VERSION, sessionId: '' },
      { apiVersion: API_VERSION, sessionId: 42 },
      null,
      'listTurns',
    ]
    for (const request of malformed) {
      const result = await host.call(`${REMOTE_NAMESPACE}/listTurns`, request)
      expect(result.ok).toBe(false)
    }

    // A bad cursor is the one field that is allowed to be absent, so it has to
    // be rejected when it is present and wrong rather than coerced.
    const cursor = await host.call(`${REMOTE_NAMESPACE}/listTurns`, {
      apiVersion: API_VERSION,
      sessionId: 's-1',
      limit: 10,
      cursor: 'next',
    })
    expect(cursor.ok).toBe(false)
  })

  it('shows why a lookup answers `null`, by observing what the boundary does to `undefined`', async () => {
    // The contract's `data: null` rests on a claim about the gateway. Rather
    // than assert that claim in a comment, this registers a service that breaks
    // it and watches the boundary reject the reply. If a future gateway stops
    // refusing `undefined`, this test fails and the `null` in `lookup` becomes a
    // style choice that nobody re-examined.
    const dataRoot = await mkdtemp(join(tmpdir(), 'turnscope-remote-probe-'))
    cleanups.push(async () => rm(dataRoot, { recursive: true, force: true }))
    const handle = await openIndex(join(dataRoot, 'index.sqlite3'))
    const repo = createRepository(handle)
    cleanups.push(async () => repo.close())

    class LeakyService extends TypertRemoteService {
      constructor(ctx: Context) {
        super(ctx, 'turnscope-probe')
      }
      leaky() {
        return { apiVersion: API_VERSION, data: undefined }
      }
    }

    const ctx = new Context()
    const captured: Interceptor[] = []
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
    const fibers = [await ctx.plugin(TypertRegistry).await(), await ctx.plugin(ApiGateway).await()]
    cleanups.push(async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    })
    new LeakyService(ctx)
    ctx.typert.register({
      package: 'turnscope-probe',
      face: 'host',
      schemas: [],
      model: { services: [{ key: 'turnscope-probe', exportName: 'LeakyService', members: [], types: [], tags: [] }], events: [], objects: [] },
      invocations: [
        {
          id: 'turnscope-probe#turnscope-probe/leaky',
          service: 'turnscope-probe',
          namespace: 'turnscope-probe',
          method: 'leaky',
          invocation: { kind: 'direct' },
          parameters: [PROBE_PARAMETER],
          result: { mode: 'src-json' },
        } satisfies InvocationDescriptor,
      ],
    } satisfies TypertContribution)

    const result = (await captured[0]!.handler(
      'turnscope-probe/leaky',
      { args: { request: { any: 'thing' } } },
      new AbortController().signal,
    )) as DispatchResult

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('boundary validation')
  })

  it('waits for the gateway instead of giving up when it arrives late', async () => {
    // The real order on a web profile: this plugin applies first, the gateway is
    // provided afterwards. Mounting synchronously loses the API on every real
    // host, which is exactly what the smoke run found (HTTP 404 for our endpoint
    // while a first-party endpoint on the same channel answered).
    const ctx = new Context()
    const captured: Interceptor[] = []
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
    const diagnostics = new Diagnostics()
    const unmount = mountTurnscopeRemoteWhenReady(
      ctx,
      createQueryService({ sink: {} as never, inspector: {} as never }),
      diagnostics,
    )

    // Nothing is claimed yet, and waiting is not a failure: there is nothing to
    // report about a gateway that has not loaded.
    expect(captured).toHaveLength(0)
    expect(diagnostics.snapshot()).toEqual([])

    await ctx.plugin(TypertRegistry).await()
    await ctx.plugin(ApiGateway).await()

    await vi.waitFor(() => {
      expect(captured[0]?.channel).toBe('/api')
      expect(captured[0]?.matches(`${REMOTE_NAMESPACE}/listTurns`)).toBe(true)
    })
    expect(diagnostics.snapshot()).toEqual([])
    unmount()
  })

  it('stays out of the way on a host that has no gateway', async () => {
    // An isolated profile carrying only the base bundle, or a future DSH that
    // moves the registry. Recording is the part that cannot be recovered later,
    // so losing the API must not be fatal.
    const ctx = new Context()
    const diagnostics = new Diagnostics()

    const unmount = mountTurnscopeRemote(
      ctx,
      createQueryService({ sink: {} as never, inspector: {} as never }),
      diagnostics,
    )

    expect(() => unmount()).not.toThrow()
    expect(diagnostics.snapshot().map(entry => entry.code)).toEqual(['trace.remote-unavailable'])
  })
})
