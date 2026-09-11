// @vitest-environment jsdom
/**
 * The browser half of the turn API, exercised against a fake transport.
 *
 * The fake is deliberately a *transport* and not a host: it answers with raw
 * `RpcResult` values and knows nothing about turns. What is under test is the
 * shape this module puts on the wire and the shapes it is willing to read back —
 * the two places where a browser bundle and a host can disagree without either
 * of them being wrong.
 */
import type { ClientConnectionRpc, RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { Mock } from 'vitest'
import { describe, expect, it, vi } from 'vitest'
import { API_CHANNEL, createHostApi } from '../../src/client/host-api.ts'
import { API_VERSION } from '../../src/shared/contracts/api.ts'

const listing = { apiVersion: API_VERSION, data: { turns: [] } }

const rpcOf = (result: RpcResult<unknown> | Error): { rpc: ClientConnectionRpc; call: Mock } => {
  const call = vi.fn(async () => {
    if (result instanceof Error) throw result
    return result
  })
  return { rpc: { call } as unknown as ClientConnectionRpc, call }
}

const request = { apiVersion: API_VERSION, sessionId: 's-1', limit: 30 }

describe('createHostApi', () => {
  it('calls the endpoint the host claimed, on the channel the gateway owns', async () => {
    const { rpc, call } = rpcOf({ ok: true, value: listing })

    await createHostApi(rpc).listTurns(request)

    // The endpoint name is the one the host registered (`turnscope/listTurns`),
    // and the request travels under the parameter name its descriptor declares.
    // Both are wire facts proven against a real gateway in
    // `docs/spikes/2026-09-11-third-party-remote.md`; this test is the guard that
    // keeps them from drifting.
    expect(call).toHaveBeenCalledWith(API_CHANNEL, 'turnscope/listTurns', {
      args: { request },
    })
  })

  it('reads a well-formed answer as a value', async () => {
    const { rpc } = rpcOf({ ok: true, value: listing })

    await expect(createHostApi(rpc).listTurns(request)).resolves.toEqual({
      kind: 'value',
      value: { turns: [] },
    })
  })

  it('reads "the host has no such turn" as an answer, not as a failure', async () => {
    const { rpc } = rpcOf({ ok: true, value: { apiVersion: API_VERSION, data: null } })

    await expect(createHostApi(rpc).getTurnDetail({ apiVersion: API_VERSION, turnId: 's-1:turn:0' }))
      .resolves.toEqual({ kind: 'absent' })
  })

  it('refuses an answer from a host speaking a contract it does not know', async () => {
    const { rpc } = rpcOf({ ok: true, value: { apiVersion: API_VERSION + 1, data: { turns: [] } } })

    const answer = await createHostApi(rpc).listTurns(request)

    // Not an exception and not an empty list: the shapes may well still line up,
    // which is exactly why this has to be stated rather than assumed. The detail
    // names the version so a user report can say which side is old.
    expect(answer.kind).toBe('unusable')
    expect(answer.kind === 'unusable' && answer.detail).toContain(String(API_VERSION + 1))
  })

  it('turns a refused call into a reason rather than a rejection', async () => {
    const { rpc } = rpcOf({
      ok: false,
      error: { code: 'internal', message: 'turnscope: gateway exploded' },
    } as unknown as RpcResult<unknown>)

    const answer = await createHostApi(rpc).evaluateSafety({ apiVersion: API_VERSION, turnId: 't' })

    expect(answer).toEqual({
      kind: 'unusable',
      detail: 'internal: turnscope: gateway exploded',
    })
  })

  it('turns a transport failure into a reason rather than a rejection', async () => {
    const { rpc } = rpcOf(new Error('network down'))

    const answer = await createHostApi(rpc).listTurns(request)

    // A view renders whichever of these it gets; a rejected promise would be an
    // unhandled one, and this module exists so that no caller has to know that.
    expect(answer).toEqual({ kind: 'unusable', detail: 'turnscope: network down' })
  })

  it('refuses a success with nothing in it', async () => {
    const { rpc } = rpcOf({ ok: true, value: undefined } as unknown as RpcResult<unknown>)

    const answer = await createHostApi(rpc).listTurns(request)

    // `undefined` cannot cross this gateway at all — the host side asserts that
    // as its own test — so seeing one means something between the two ends is
    // not what it claims to be.
    expect(answer.kind).toBe('unusable')
  })

  it('reads a diff, including one the host could not produce', async () => {
    const diff = {
      path: 'src/a.ts',
      kind: 'modified',
      attribution: 'AGENT',
      confidence: 'medium',
      baseline: false,
      before: { source: 'git-object', byteSize: 4, lineCount: 1, endsWithNewline: true },
      after: { source: 'recovery-blob', byteSize: 4, lineCount: 1, endsWithNewline: true },
      availability: { kind: 'unavailable', reason: 'missing-blob', detail: 'gone' },
    }
    const { rpc, call } = rpcOf({ ok: true, value: { apiVersion: API_VERSION, data: { diff } } })

    await expect(
      createHostApi(rpc).getDiff({ apiVersion: API_VERSION, turnId: 't', path: 'src/a.ts' }),
    ).resolves.toEqual({ kind: 'value', value: { diff } })

    // The path travels inside the request and nowhere else: the client never
    // names a filesystem path to the host, it names a path the host already
    // recorded (`docs/ARCHITECTURE.md §12.3`).
    expect(call).toHaveBeenCalledWith(API_CHANNEL, 'turnscope/getDiff', {
      args: { request: { apiVersion: API_VERSION, turnId: 't', path: 'src/a.ts' } },
    })
  })

  it('reads "no diff for that path" as an answer, not as a failure', async () => {
    const { rpc } = rpcOf({ ok: true, value: { apiVersion: API_VERSION, data: null } })

    await expect(
      createHostApi(rpc).getDiff({ apiVersion: API_VERSION, turnId: 't', path: 'src/none.ts' }),
    ).resolves.toEqual({ kind: 'absent' })
  })

  it('calls each endpoint by its own name', async () => {
    const { rpc, call } = rpcOf({ ok: true, value: listing })
    const api = createHostApi(rpc)

    await api.getTurnDetail({ apiVersion: API_VERSION, turnId: 't' })
    await api.getDiff({ apiVersion: API_VERSION, turnId: 't', path: 'src/a.ts' })
    await api.evaluateSafety({ apiVersion: API_VERSION, turnId: 't' })

    expect(call.mock.calls.map(([, endpoint]) => endpoint)).toEqual([
      'turnscope/getTurnDetail',
      'turnscope/getDiff',
      'turnscope/evaluateSafety',
    ])
  })
})
