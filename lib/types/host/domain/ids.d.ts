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
/**
 * `${checkpointId}:path:${path}` — one observed path of a checkpoint.
 *
 * A checkpoint and the fixes it observes are captured in one pass, so the path
 * is part of the key: re-observing the same checkpoint rewrites its own rows
 * rather than appending a second copy of the same file.
 */
export declare function checkpointPathIdFor(checkpointId: string, path: string): string;
/**
 * `${turnId}:chg:${path}` — one attributed file change of a turn.
 *
 * Keyed by the path rather than an activity: attribution is a property of the
 * path across the whole turn, and re-running it (at turn close, then again when
 * safety re-reads CURRENT) must land on the same row instead of appending a
 * second opinion.
 */
export declare function fileChangeIdFor(turnId: string, path: string): string;
/**
 * `${turnId}:safety` — the verdict for a turn.
 *
 * One per turn, rewritten on every evaluation (`docs/ARCHITECTURE.md §16`): a
 * verdict is about the workspace *now*, so keeping yesterday's would be keeping
 * an answer to a question nobody asked.
 */
export declare function safetyVerdictIdFor(turnId: string): string;
//# sourceMappingURL=ids.d.ts.map