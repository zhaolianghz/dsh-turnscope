/**
 * The browser's half of the turn API.
 *
 * ## The route, and why it is this one
 *
 * First-party plugins reach a host Remote through `ctx.remote.<namespace>`, a
 * typed proxy assembled by `@deepseek-ai/dsh-api-remotes` from a *generated*
 * client artifact. That assembly is a fixed list owned by the first-party
 * packages, so a third party cannot add itself to it. What a third party can do
 * is what this file does: take the generic RPC handle the client runtime already
 * provides — `connection.rpc` — and call the endpoint by name.
 *
 * That route was not assumed. It was measured end to end, in a real browser,
 * against a real host: `docs/spikes/2026-09-11-third-party-remote.md` and the
 * replayable harness beside it (`docs/spikes/client-remote-smoke/`). The
 * finding that matters here is that no generated artifact is needed on either
 * side — the host registers its own descriptors and the browser calls
 * `connection.rpc.call`.
 *
 * ## What this module refuses to do
 *
 * It never throws and it never guesses. Everything that can go wrong — a
 * transport failure, a host that answers through a newer contract, a reply that
 * is not shaped like one of ours — comes back as {@link ReplyRead}'s `unusable`
 * with a sentence for the user. The one distinction it is careful to preserve is
 * between `absent` and `unusable`: "the host has no record of that turn" and
 * "this page cannot talk to that host" are different things to be told, and only
 * one of them is about the turn.
 */
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import {
  REMOTE_NAMESPACE,
  endpointFor,
  readReply,
} from '../shared/contracts/api.ts'
import type {
  EvaluateSafetyData,
  EvaluateSafetyRequest,
  GetDiffData,
  GetDiffRequest,
  GetTurnDetailRequest,
  ListTurnsData,
  ListTurnsRequest,
  ReplyRead,
  TurnDetailData,
} from '../shared/contracts/api.ts'

/**
 * The channel the DSH gateway owns.
 *
 * Not ours to choose and not a fact about this plugin: the host registered its
 * interceptor on the shared `/api` channel, which is the channel the browser
 * transport already speaks. Naming it here is the one place the two halves of
 * the transport have to agree with something outside this repository, which is
 * why it is a constant with a paragraph rather than a literal in a call.
 */
export const API_CHANNEL = '/api'

/** The turn API as the browser sees it. Every method is total and answers. */
export interface TurnscopeHostApi {
  readonly listTurns: (request: ListTurnsRequest) => Promise<ReplyRead<ListTurnsData>>
  readonly getTurnDetail: (request: GetTurnDetailRequest) => Promise<ReplyRead<TurnDetailData>>
  readonly evaluateSafety: (request: EvaluateSafetyRequest) => Promise<ReplyRead<EvaluateSafetyData>>
  /**
   * One path's diff.
   *
   * `absent` here means the turn did not change that path — the same `absent` the
   * other lookups produce, which is what lets a caller render "no such change"
   * without a second kind of nothing to handle.
   */
  readonly getDiff: (request: GetDiffRequest) => Promise<ReplyRead<GetDiffData>>
}

/**
 * Build the API over a live connection.
 *
 * Takes the RPC handle rather than the whole `connection` service: nothing else
 * on that service is used, and a narrower argument is a narrower thing for a
 * test to have to fake.
 */
export function createHostApi(rpc: ClientConnectionRpc): TurnscopeHostApi {
  const call = async <T>(method: string, request: unknown): Promise<ReplyRead<T>> => {
    let reply: unknown
    try {
      // The envelope the host's gateway expects: `args` holds the parameter
      // names from the registered descriptor, which is why the request has to be
      // wrapped rather than passed as the payload.
      reply = await rpc.call(API_CHANNEL, endpointFor(method), { args: { request } })
    } catch (error) {
      return { kind: 'unusable', detail: describe(error) }
    }
    if (typeof reply !== 'object' || reply === null) {
      return { kind: 'unusable', detail: 'the transport returned no result' }
    }
    const result = reply as { ok?: unknown; value?: unknown; error?: unknown }
    if (result.ok !== true) {
      // A `{ ok: false }` result means the host ran the endpoint and it failed,
      // which is not the same as the endpoint not existing but is equally not an
      // answer about a turn. The gateway's own code and message are kept: they
      // are written for a developer, and this is the only place they can surface.
      const error = result.error as { code?: unknown; message?: unknown } | undefined
      return {
        kind: 'unusable',
        detail: `${String(error?.code ?? 'call-failed')}: ${String(error?.message ?? 'the host refused the call')}`,
      }
    }
    return readReply<T>(result.value)
  }

  return {
    listTurns: (request) => call<ListTurnsData>('listTurns', request),
    getTurnDetail: (request) => call<TurnDetailData>('getTurnDetail', request),
    evaluateSafety: (request) => call<EvaluateSafetyData>('evaluateSafety', request),
    getDiff: (request) => call<GetDiffData>('getDiff', request),
  }
}

const describe = (error: unknown): string =>
  `${REMOTE_NAMESPACE}: ${error instanceof Error ? error.message : String(error)}`
