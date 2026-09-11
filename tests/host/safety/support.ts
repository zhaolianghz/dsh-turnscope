/**
 * Builders for the safety tests.
 *
 * The engine is pure, so these are the whole world a test has to construct: a
 * turn, some checkpoints, some changes. Keeping them in one file is what lets
 * each rule's spec say what it means in a line or two instead of restating the
 * record shape twelve times.
 */
import type { ObservedCheckpoint } from '../../../src/host/attribution/types.ts'
import { SCHEMA_VERSION } from '../../../src/host/domain/types.ts'
import type {
  CheckpointCompleteness,
  CheckpointPhase,
  CheckpointRecord,
  FileChange,
  TurnRecord,
} from '../../../src/host/domain/types.ts'
import type { SafetyInput } from '../../../src/host/safety/types.ts'

export const TURN_ID = 's-1:turn:3'

/**
 * A patch that may explicitly clear an optional field.
 *
 * `exactOptionalPropertyTypes` means `Partial<T>` will not accept `{ headOid:
 * undefined }`, but several rules are precisely about a field being absent —
 * "neither side could read a HEAD" is a test case, not an accident.
 */
type Patch<T> = { [K in keyof T]?: T[K] | undefined }

export function turnRecord(patch: Patch<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: TURN_ID,
    sessionId: 's-1',
    workspaceId: 'ws-1',
    ordinal: 3,
    status: 'completed',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_010_000,
    activityCount: 4,
    errorCount: 0,
    evidenceCompleteness: 'complete',
    ...patch,
  } as TurnRecord
}

export function checkpoint(
  phase: CheckpointPhase,
  patch: Patch<CheckpointRecord> = {},
  paths: ObservedCheckpoint['paths'] = [],
): ObservedCheckpoint {
  const id = `${TURN_ID}:cp:${phase}`
  return {
    record: {
      schemaVersion: SCHEMA_VERSION,
      id,
      workspaceId: 'ws-1',
      turnId: TURN_ID,
      phase,
      headOid: 'a'.repeat(40),
      branch: 'main',
      cleanStart: true,
      mergeInProgress: false,
      rebaseInProgress: false,
      cherryPickInProgress: false,
      completeness: 'complete',
      restorable: true,
      createdAt: 1_700_000_000_000,
      ...patch,
    } as CheckpointRecord,
    paths: paths.map(state => ({ ...state, checkpointId: id, id: `${id}:path:${state.path}` })),
  }
}

export function change(patch: Partial<FileChange> = {}): FileChange {
  const path = patch.path ?? 'src/auth.ts'
  return {
    schemaVersion: SCHEMA_VERSION,
    id: `${TURN_ID}:chg:${path}`,
    turnId: TURN_ID,
    path,
    kind: 'modified' as const,
    attribution: 'AGENT' as const,
    confidence: 'high',
    baseline: false,
    evidenceRefs: [],
    ...patch,
  }
}

/**
 * A safe turn by default, so a test only has to say what is wrong with it.
 *
 * The default includes PRE, POST, and a change set, because that is the minimum
 * a turn needs before any verdict other than `UNPROTECTED` is even meaningful.
 */
export function safetyInput(patch: Partial<SafetyInput> = {}): SafetyInput {
  return {
    turn: turnRecord(),
    pre: checkpoint('pre'),
    post: checkpoint('post'),
    current: checkpoint('recovery_before'),
    changeSet: { turnId: TURN_ID, changes: [], summary: { total: 0, agent: 0, baseline: 0, drift: 0, uncertain: 0 } },
    now: 1_700_000_020_000,
    ...patch,
  }
}

/** A complete checkpoint is the default; this makes a partial one terse. */
export function incompleteness(completeness: CheckpointCompleteness): Patch<CheckpointRecord> {
  return { completeness, restorable: completeness === 'complete' }
}
