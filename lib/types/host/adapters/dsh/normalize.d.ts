import type { TurnscopeConfig } from '../../../config.ts';
import type { NormalizedEvent } from '../../domain/types.ts';
/**
 * The upstream SessionEvent envelope, as broadly as the adapter needs it.
 *
 * Deliberately structural rather than the harness's own union: a merge-extensible
 * `SessionEventMap` means a *newer* harness (or another plugin) can publish event
 * types this build has never seen, and the adapter's whole contract is that an
 * unrecognised type degrades to an ignored event rather than a compile or
 * runtime failure. `data` is `unknown` on purpose — every field is narrowed
 * here, never trusted.
 */
export interface RawSessionEvent {
    readonly type: string;
    readonly seq: number;
    readonly time: number;
    readonly data: unknown;
}
/**
 * Turn ordinal standing in for "the harness did not attribute this event to a
 * turn". Only `turnIdFor` ever sees it, and no real turn can collide with it:
 * a turn-bearing event must carry a non-negative ordinal to be normalized at
 * all, so the sentinel can never name a turn that exists.
 */
export declare const UNATTRIBUTED_TURN = -1;
/** The sentinel turn id an unattributed event carries until the assembler places it. */
export declare const unattributedTurnId: (sessionId: string) => string;
/** What redaction, truncation and content addressing produced for one payload. */
export interface PreparedPayload {
    /** True when `truncateBytes` dropped bytes; the only honest truncation signal. */
    readonly truncated: boolean;
    /** Size in bytes *before* truncation, measured after redaction. */
    readonly originalBytes: number;
    /** Size in bytes of the text that would be stored. */
    readonly byteSize: number;
    /** Bare hex digest, for the `objects` row. */
    readonly sha256: string;
}
/**
 * One normalized event, plus the facts the versioned {@link NormalizedEvent}
 * seam deliberately does not carry.
 *
 * `seq`, `label` and the payload are all derivable only here, and none of them
 * belongs in the seam: `seq` is upstream bookkeeping, `label` is presentation,
 * and the payload is bytes no consumer of the seam should have to hold.
 */
export interface NormalizedActivity extends NormalizedEvent {
    /** Upstream sequence number; the activity table is ordered by it. */
    readonly seq: number;
    /** Upstream turn ordinal, when the event named one. */
    readonly turn: number | undefined;
    /** Identifier-only summary for the timeline; never contains payload text. */
    readonly label: string;
    /** Redacted, truncated bytes ready to write; absent when the event carries no text. */
    readonly payloadBytes?: Uint8Array;
    /** Metadata for {@link payloadBytes}; present exactly when those bytes are. */
    readonly payload?: PreparedPayload;
}
/**
 * Map one upstream event onto the domain seam, or `undefined` when it is not
 * recognisable.
 *
 * Total by construction: every field is narrowed before use, `data` may be
 * missing, `null` or any other shape, and nothing here can throw. An event the
 * adapter cannot place is an ignored event plus a diagnostic the caller
 * records — never an error into the harness, and never a blocked session.
 */
export declare function normalizeEvent(sessionId: string, workspaceId: string, event: RawSessionEvent, config: TurnscopeConfig): NormalizedActivity | undefined;
/**
 * Short user-facing text for one activity.
 *
 * Reads only names and identifiers — a tool name, a call id, a step index, the
 * event's own kind and phase — so a label cannot leak a secret even if the
 * redactor were bypassed entirely. The optional raw event supplies those
 * identifiers; without it the label degrades to the kind and phase alone.
 */
export declare function describeLabel(normalized: NormalizedEvent, event?: RawSessionEvent): string;
//# sourceMappingURL=normalize.d.ts.map