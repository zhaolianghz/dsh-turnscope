import type { CheckpointPhase } from './types.ts'

/**
 * Deterministic identifier derivation.
 *
 * Every id is a pure function of values the harness already guarantees to be
 * stable, so replaying an event produces the same string and the storage layer's
 * upserts deduplicate for free. DSH's `seq` is unique and monotonic per session,
 * which is what makes the activity id sound as a key.
 */

/** `${sessionId}:turn:${turn}` — one turn within a session. */
export function turnIdFor(sessionId: string, turn: number): string {
  return `${sessionId}:turn:${turn}`
}

/** `${sessionId}:act:${seq}` — one activity within a session. */
export function activityIdFor(sessionId: string, seq: number): string {
  return `${sessionId}:act:${seq}`
}

/**
 * `${turnId}:cp:${phase}` — one checkpoint of a turn.
 *
 * Derived from the turn id rather than the session, so a pre and a post
 * checkpoint of the same turn cannot collide.
 */
export function checkpointIdFor(turnId: string, phase: CheckpointPhase): string {
  return `${turnId}:cp:${phase}`
}

/**
 * `${checkpointId}:path:${path}` — one observed path of a checkpoint.
 *
 * A checkpoint and the fixes it observes are captured in one pass, so the path
 * is part of the key: re-observing the same checkpoint rewrites its own rows
 * rather than appending a second copy of the same file.
 */
export function checkpointPathIdFor(checkpointId: string, path: string): string {
  return `${checkpointId}:path:${path}`
}
