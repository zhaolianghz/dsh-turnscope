/**
 * The Host ↔ Client wire contract.
 *
 * This is the one module both halves may import. Everything in it is a *type*
 * except {@link API_VERSION} and {@link envelope}, so importing it from the
 * browser bundle drags in no host code — the domain types below are pulled in
 * with `import type` and are erased at build time. There is deliberately no
 * runtime dependency in either direction.
 *
 * The domain types are reused rather than restated. A second copy of
 * `SafetyLevel` would be a second thing to keep in step, and the failure mode of
 * drifting copies is the worst kind: a UI that renders a level the host never
 * sends, with no error anywhere. Reuse buys compile-time agreement for free. The
 * *stability* that `docs/ARCHITECTURE.md §49` asks for is provided by the
 * envelope instead — see below.
 *
 * ## Why the envelope
 *
 * Every response is wrapped in `{ apiVersion, data }`. The point is not
 * decoration; it is that a mismatch must be a loud, typed failure rather than a
 * silent one. A plugin upgrade can leave a stale browser bundle talking to a
 * newer host, and without a version in the reply that combination would surface
 * as a field that is mysteriously `undefined` somewhere deep in the UI. With it,
 * the client rejects the response at the boundary, in one place, with the two
 * numbers in the message.
 */
import type { CommandRecord, EvidenceCompleteness, FileChange, RecoveryAction, SafetyLevel, SafetyVerdict, TestRecord, TurnStatus } from '../../host/domain/types.ts';
import type { FileDiff } from '../../host/diff/types.ts';
import type { RecoveryFileOperation, RecoveryJournalEntry, RecoveryPlan, RecoveryResult } from '../../host/recovery/types.ts';
/**
 * The contract version.
 *
 * Bumped when a change to the shapes below would make an old client misread a
 * new host or vice versa. Adding a field is not such a change; changing what an
 * existing field means is.
 *
 * The version went to 2 when `getDiff` arrived, which by that rule is only an
 * addition — a v1 bundle and a v2 host would have worked for everything but the
 * new method. It was still bumped, because the client and the host are halves of
 * *one* package: a pair that does not match is never a supported combination, and
 * failing as a pair (one sentence naming both versions) is more useful than
 * failing on the one request a user happened to click.
 */
export declare const API_VERSION = 3;
/**
 * The namespace our host methods are registered under, and therefore the prefix
 * of every endpoint name.
 *
 * Shared because both halves have to spell it and only one of them chooses it:
 * the host registers descriptors whose `service` and `namespace` are this value,
 * and the browser asks for `turnscope/listTurns` by string. A constant that
 * drifted between the two would look exactly like an endpoint that does not
 * exist.
 */
export declare const REMOTE_NAMESPACE = "turnscope";
/** The endpoint name one method is reached by, e.g. `turnscope/listTurns`. */
export declare const endpointFor: (method: string) => string;
/** One host reply, wrapped so a version mismatch cannot pass silently. */
export interface TurnscopeApiEnvelope<T> {
    readonly apiVersion: number;
    readonly data: T;
}
/** Wrap a reply. The only way a host response is constructed. */
export declare const envelope: <T>(data: T) => TurnscopeApiEnvelope<T>;
/**
 * A reply to a lookup, which may legitimately find nothing.
 *
 * `null` rather than an omitted field, and rather than an absent reply. The
 * gateway refuses to carry `undefined` across the boundary — its `assertJsonValue`
 * rejects it as not JSON-safe, and the failure surfaces as "business result
 * failed boundary validation" rather than as a missing value — so a lookup that
 * finds nothing has to *say* so.
 *
 * It is distinguishable from {@link ReplyRead}'s `unusable` on purpose, and the
 * distinction is one a UI needs: the first means the host answered and the
 * answer is "no such turn", the second means there is no usable answer at all.
 * Rendering those the same would turn a version mismatch into a
 * confidently-reported absence.
 */
export type TurnscopeLookupReply<T> = TurnscopeApiEnvelope<T | null>;
/** Wrap an optional lookup result, mapping "nothing" onto the wire's `null`. */
export declare const lookup: <T>(data: T | undefined) => TurnscopeLookupReply<T>;
/**
 * What reading a reply can produce.
 *
 * Three outcomes rather than two, because a caller has three different things to
 * say. `absent` is the host's answer — there is no such turn — and it is worth
 * saying out loud. `unusable` is not an answer at all: a transport failure, a
 * version mismatch, or a reply that is not shaped like one of ours. A UI that
 * collapsed the two would report "no turn recorded" when what actually happened
 * is "this page cannot talk to that host", which is the more alarming of the two
 * and the one a user would try to act on.
 */
export type ReplyRead<T> = {
    readonly kind: 'value';
    readonly value: T;
} | {
    readonly kind: 'absent';
} | {
    readonly kind: 'unusable';
    readonly detail: string;
};
/**
 * Read a reply, or explain why it is not one.
 *
 * Never throws, because every caller of this is a UI renderer, and the useful
 * behaviour on a version mismatch is to show nothing with an explanation rather
 * than to take down the panel the user is reading.
 *
 * Only the envelope is validated, not the payload. Checking fields here would
 * mean writing a validator per reply shape and keeping it in step with the types
 * it is supposed to be checking — with the failure mode that the checks silently
 * stop covering a field someone added. What *is* checked is the one fact a type
 * cannot carry at runtime: which version of the shapes these are.
 *
 * `data === null` is read as `absent` and a missing `data` as `unusable`, and
 * the difference matters: the first is a thing the host decided to say, the
 * second is a reply that came apart somewhere.
 */
export declare function readReply<T>(reply: unknown): ReplyRead<T>;
/**
 * How many turns one page may hold.
 *
 * Shared rather than host-only because both ends have to agree on it: the host
 * clamps to the ceiling, and the client asks for the default. It lives here for
 * the same reason the version does — a client that asked for its own idea of a
 * page size would be making a request the host silently rewrites.
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
/** What every request carries, so a host can reject a stale client up front. */
export interface TurnscopeRequestBase {
    readonly apiVersion: number;
}
export interface ListTurnsRequest extends TurnscopeRequestBase {
    readonly sessionId: string;
    /** Server-clamped; a client asking for a million rows gets the ceiling. */
    readonly limit: number;
    /** Opaque continuation token from a previous page. */
    readonly cursor?: number;
}
/**
 * One row of the turn list.
 *
 * Counts and the latest verdict are denormalized into the summary on purpose.
 * The list is the screen a user opens first and it updates as a turn runs, so
 * requiring a `getTurnDetail` per row to render a badge would turn one query
 * into 1 + N on the hot path (`docs/ARCHITECTURE.md §44.3`).
 */
export interface TurnSummaryDto {
    readonly turnId: string;
    readonly sessionId: string;
    /** Position within the session, oldest first, as the harness numbered them. */
    readonly ordinal: number;
    readonly status: TurnStatus;
    /** Epoch milliseconds, as stored. */
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly activityCount: number;
    readonly errorCount: number;
    /**
     * How much of this turn's evidence actually exists. Carried into the list
     * because it is the one field that changes how much the verdict is worth, and
     * a badge shown without it can be read as more confident than it is.
     */
    readonly evidenceCompleteness: EvidenceCompleteness;
    readonly changeCount: number;
    /** Absent when no verdict has been computed, which is not the same as `SAFE`. */
    readonly safety?: SafetySummaryDto;
}
/**
 * The verdict as a list row needs it: a level, what to do about it, and when it
 * was decided.
 *
 * `evaluatedAt` is epoch milliseconds, matching the rest of the stored schema.
 * `docs/ARCHITECTURE.md §13.2` sketches it as a string; the implementation uses
 * numbers everywhere so that ordering and arithmetic do not depend on parse
 * behaviour, and this is that decision carried out to the wire.
 */
export interface SafetySummaryDto {
    readonly level: SafetyLevel;
    readonly recommendedAction: RecoveryAction;
    readonly evaluatedAt: number;
}
export interface ListTurnsData {
    readonly turns: readonly TurnSummaryDto[];
    /** Absent means the session is exhausted — not that a page happened to end. */
    readonly nextCursor?: number;
}
export interface GetTurnDetailRequest extends TurnscopeRequestBase {
    readonly turnId: string;
}
/**
 * Everything known about one turn.
 *
 * `summary` is the same shape the list returns, so a detail view opened from a
 * row can render immediately and fill in the rest when the reply lands.
 *
 * Diffs are absent by construction (`docs/ARCHITECTURE.md §44.2`): a change
 * carries the hashes and the refs, and the bytes are fetched per path only when
 * the user asks to see them.
 */
export interface TurnDetailData {
    readonly summary: TurnSummaryDto;
    readonly changes: readonly FileChange[];
    readonly commands: readonly CommandRecord[];
    readonly tests: readonly TestRecord[];
    /** The freshest verdict on record. Never recomputed here — see `evaluateSafety`. */
    readonly safety?: SafetyVerdict;
}
export interface GetDiffRequest extends TurnscopeRequestBase {
    readonly turnId: string;
    /**
     * The path to compare, exactly as `getTurnDetail` reported it.
     *
     * It may only *select* a recorded change — the reader looks it up among the
     * turn's changes and refuses anything else — so a path that arrived from a
     * browser never becomes a filesystem or git path on its own.
     */
    readonly path: string;
}
/**
 * One path's diff.
 *
 * The diff is not a field that can be missing: `getDiff` answers `data: null`
 * when the turn did not change the path, so a returned diff is always *about*
 * something. Whether it can be *shown* is `availability`, which is a discriminated
 * shape rather than a possibly-empty hunk list — see `host/diff/types.ts` for why
 * "there is nothing to compare" must not be renderable as "nothing changed".
 *
 * Fetched per path and never bundled into `getTurnDetail` (`docs/ARCHITECTURE.md
 * §44.2`): the bytes of every change in a turn would be the largest thing this
 * API could send and the least often read.
 */
export interface GetDiffData {
    readonly diff: FileDiff;
}
export interface EvaluateSafetyRequest extends TurnscopeRequestBase {
    readonly turnId: string;
}
/**
 * The answer to "may I rewind this *now*".
 *
 * Returned from an explicit call rather than folded into `getTurnDetail`,
 * because the two questions have different costs and different truths: reading
 * the detail is a database read, while evaluating takes a fresh observation of
 * the workspace (`docs/ARCHITECTURE.md §16`). A UI that wants to show the newest
 * verdict asks for it; a UI that is scrolling asks for the recorded one.
 */
export interface EvaluateSafetyData {
    readonly verdict: SafetyVerdict;
    /** How many changes the judgement was made against, for a "3 changed" label. */
    readonly changeCount: number;
}
/**
 * What the client sends to ask "may I rewind this turn, and what would that
 * look like".
 *
 * `evaluationId` is supplied by the client because the verdict the preview
 * runs against may have been computed minutes ago — the client picks an id
 * so the host can answer deterministically when the same preview is re-asked
 * during a refresh.
 */
export interface PreviewRewindRequest extends TurnscopeRequestBase {
    readonly turnId: string;
    readonly evaluationId: string;
    /**
     * How long the preview stays valid before apply is refused (default 60s).
     *
     * Clamped server-side so a client cannot pin a worker thread open by
     * asking for a million-millisecond preview.
     */
    readonly ttlMs?: number;
}
/**
 * The reply: either a `RecoveryPlan` to confirm in the UI, or a `failureReason`
 * explaining why the preview cannot run.
 *
 * `plan: undefined` carries inside the envelope — not as an absent reply —
 * because "no plan" and "no usable answer" are different things a UI shows
 * differently (a "Drift conflict" toast is not a "Failed to load" spinner).
 */
export interface PreviewRewindData {
    readonly plan?: RecoveryPlan;
    readonly failureReason?: string;
}
export interface ApplyRewindRequest extends TurnscopeRequestBase {
    readonly planId: string;
}
export interface ApplyRewindData {
    readonly result?: RecoveryResult;
    readonly failureReason?: string;
}
/**
 * The summary of one plan that has not reached a terminal state.
 *
 * Returned at boot so a UI can surface "yesterday's apply crashed" without
 * having to re-derive it. The full plan is on disk in `recovery_plans`
 * (`docs/ARCHITECTURE.md §5.6`) but only the unfinished ones are useful in
 * the surface this list powers.
 */
export interface ListRecoveryPlansRequest extends TurnscopeRequestBase {
    /**
     * When false (the default), only plans whose latest status is `applying`
     * or whose `previewed` window has elapsed are returned — the same set
     * that needs a user decision. When true, completed and cancelled plans
     * are included for debugging views.
     */
    readonly includeFinished?: boolean;
}
export interface ListRecoveryPlansData {
    readonly plans: readonly RecoveryPlan[];
}
/**
 * Re-exported for the client so callers do not need to know which side of the
 * port the type lives on. The types are plain interfaces that travel as JSON
 * over the gateway, so reusing the host's types is safe and prevents the two
 * halves from drifting.
 */
export type { RecoveryFileOperation, RecoveryJournalEntry, RecoveryPlan, RecoveryResult };
//# sourceMappingURL=api.d.ts.map