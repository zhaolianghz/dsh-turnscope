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
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import type { EvaluateSafetyData, EvaluateSafetyRequest, GetDiffData, GetDiffRequest, GetTurnDetailRequest, ListTurnsData, ListTurnsRequest, ReplyRead, TurnDetailData } from '../shared/contracts/api.ts';
/**
 * The channel the DSH gateway owns.
 *
 * Not ours to choose and not a fact about this plugin: the host registered its
 * interceptor on the shared `/api` channel, which is the channel the browser
 * transport already speaks. Naming it here is the one place the two halves of
 * the transport have to agree with something outside this repository, which is
 * why it is a constant with a paragraph rather than a literal in a call.
 */
export declare const API_CHANNEL = "/api";
/** The turn API as the browser sees it. Every method is total and answers. */
export interface TurnscopeHostApi {
    readonly listTurns: (request: ListTurnsRequest) => Promise<ReplyRead<ListTurnsData>>;
    readonly getTurnDetail: (request: GetTurnDetailRequest) => Promise<ReplyRead<TurnDetailData>>;
    readonly evaluateSafety: (request: EvaluateSafetyRequest) => Promise<ReplyRead<EvaluateSafetyData>>;
    /**
     * One path's diff.
     *
     * `absent` here means the turn did not change that path — the same `absent` the
     * other lookups produce, which is what lets a caller render "no such change"
     * without a second kind of nothing to handle.
     */
    readonly getDiff: (request: GetDiffRequest) => Promise<ReplyRead<GetDiffData>>;
}
/**
 * Build the API over a live connection.
 *
 * Takes the RPC handle rather than the whole `connection` service: nothing else
 * on that service is used, and a narrower argument is a narrower thing for a
 * test to have to fake.
 */
export declare function createHostApi(rpc: ClientConnectionRpc): TurnscopeHostApi;
//# sourceMappingURL=host-api.d.ts.map