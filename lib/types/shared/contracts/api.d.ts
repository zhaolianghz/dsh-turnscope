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
/**
 * The contract version.
 *
 * Bumped when a change to the shapes below would make an old client misread a
 * new host or vice versa. Adding a field is not such a change; changing what an
 * existing field means is.
 */
export declare const API_VERSION = 1;
/** One host reply, wrapped so a version mismatch cannot pass silently. */
export interface TurnscopeApiEnvelope<T> {
    readonly apiVersion: number;
    readonly data: T;
}
/** Wrap a reply. The only way a host response is constructed. */
export declare const envelope: <T>(data: T) => TurnscopeApiEnvelope<T>;
/**
 * Read a reply, or refuse it.
 *
 * Returns `undefined` rather than throwing because every caller of this is a UI
 * renderer, and the useful behaviour on a version mismatch is to show nothing
 * with an explanation rather than to take down the panel the user is reading.
 * The caller has to decide to handle `undefined`; that is the point.
 */
export declare function unwrap<T>(reply: unknown): TurnscopeApiEnvelope<T> | undefined;
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
//# sourceMappingURL=api.d.ts.map