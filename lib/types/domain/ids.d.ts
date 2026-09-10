import type { CheckpointPhase } from './types.ts';
/**
 * Deterministic identifier derivation.
 *
 * Every id is a pure function of values the harness already guarantees to be
 * stable, so replaying an event produces the same string and the storage layer's
 * upserts deduplicate for free. DSH's `seq` is unique and monotonic per session,
 * which is what makes the activity id sound as a key.
 */
/** `${sessionId}:turn:${turn}` — one turn within a session. */
export declare function turnIdFor(sessionId: string, turn: number): string;
/** `${sessionId}:act:${seq}` — one activity within a session. */
export declare function activityIdFor(sessionId: string, seq: number): string;
/**
 * `${turnId}:cp:${phase}` — one checkpoint of a turn.
 *
 * Derived from the turn id rather than the session, so a pre and a post
 * checkpoint of the same turn cannot collide.
 */
export declare function checkpointIdFor(turnId: string, phase: CheckpointPhase): string;
//# sourceMappingURL=ids.d.ts.map