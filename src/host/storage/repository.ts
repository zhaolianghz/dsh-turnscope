import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'
import { SCHEMA_VERSION } from '../domain/types.ts'
import type {
  ActivityRecord,
  CheckpointRecord,
  CheckpointPhase,
  EventKind,
  EventPhase,
  ObjectRecord,
  SessionRecord,
  TurnRecord,
  TurnStatus,
  WorkspaceRecord,
} from '../domain/types.ts'
import type { IndexHandle } from './sqlite-index.ts'

/**
 * The read side of the trace store: the port every other module consumes.
 *
 * It is the seam that keeps `node:sqlite` inside `src/storage`. It is also the
 * seam that would let a future backend (a remote store, a different engine) be
 * swapped in without touching the recorder, which is why every method is
 * `async` even though the current driver is synchronous.
 */
export interface TraceRepository {
  upsertWorkspace(record: WorkspaceRecord): Promise<void>
  upsertSession(record: SessionRecord): Promise<void>
  upsertTurn(record: TurnRecord): Promise<void>
  /** Move a turn to a terminal status, unless it already reached one. */
  closeTurn(turnId: string, status: TurnStatus, endedAt: number): Promise<void>
  /** The turns of a session, newest ordinal first. */
  listTurns(sessionId: string, limit: number): Promise<readonly TurnRecord[]>
  getTurn(turnId: string): Promise<TurnRecord | undefined>
  appendActivity(record: ActivityRecord): Promise<void>
  /** The activities of a turn, in upstream `seq` order. */
  getActivities(turnId: string): Promise<readonly ActivityRecord[]>
  putCheckpoint(record: CheckpointRecord): Promise<void>
  getCheckpoint(id: string): Promise<CheckpointRecord | undefined>
  listCheckpoints(turnId: string): Promise<readonly CheckpointRecord[]>
  putObjectRecord(record: ObjectRecord): Promise<void>
  statObject(ref: string): Promise<ObjectRecord | undefined>
  /** Every object ref still held by a record, sorted; retention pins these. */
  referencedRefs(): Promise<readonly string[]>
  storageUsage(): Promise<{ readonly objectBytes: number; readonly objectCount: number }>
  close(): Promise<void>
}

/** A row as the driver yields it: column name to SQLite value. */
type Row = Record<string, unknown>

/**
 * Read one column, refusing anything the schema does not promise.
 *
 * The schema is `STRICT` and every statement below lists its columns, so a
 * mismatch means on-disk corruption or a schema this build does not understand.
 * Failing loudly with the column name beats coercing a wrong value into a record
 * that then flows into a report.
 */
function text(row: Row, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') {
    throw new Error(`column ${column}: expected TEXT, read ${String(value)}`)
  }
  return value
}

function integer(row: Row, column: string): number {
  const value = row[column]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`column ${column}: expected INTEGER, read ${String(value)}`)
  }
  return value
}

/** A `0`/`1` column as the boolean the record declares. */
function flag(row: Row, column: string): boolean {
  return integer(row, column) !== 0
}

function optionalText(row: Row, column: string): string | undefined {
  const value = row[column]
  if (value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`column ${column}: expected TEXT or NULL, read ${String(value)}`)
  }
  return value
}

function optionalInteger(row: Row, column: string): number | undefined {
  const value = row[column]
  if (value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`column ${column}: expected INTEGER or NULL, read ${String(value)}`)
  }
  return value
}

/** `file_digests` holds a JSON object of path to digest, or nothing. */
function optionalDigestMap(
  row: Row,
  column: string,
): Readonly<Record<string, string>> | undefined {
  const raw = optionalText(row, column)
  if (raw === undefined) return undefined

  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`column ${column}: expected a JSON object, read ${raw}`)
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`column ${column}: entry ${key} is not a string`)
    }
  }
  return parsed as Readonly<Record<string, string>>
}

/**
 * A record's optional field has no representation in SQL — the column is simply
 * NULL — so the field is mapped back as *absent* rather than present-and-
 * undefined. Under `exactOptionalPropertyTypes` the two are different types, and
 * a record that reads back with `field: undefined` would fail an equality check
 * against the record that was written.
 */
const absent = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>)

/** The inverse: an absent optional is written as SQL NULL. */
const nullable = <T extends string | number>(value: T | undefined): SQLInputValue =>
  value === undefined ? null : value

const toSqlFlag = (value: boolean): number => (value ? 1 : 0)

const toTurn = (row: Row): TurnRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id: text(row, 'id'),
  sessionId: text(row, 'session_id'),
  ordinal: integer(row, 'ordinal'),
  // Status, kind and phase are closed sets owned by the domain; the schema
  // cannot constrain them without duplicating those sets in DDL.
  status: text(row, 'status') as TurnStatus,
  startedAt: integer(row, 'started_at'),
  // `endedAt` is declared `number | undefined`, so NULL must become an explicit
  // `undefined` — not `null`, which the record type does not admit.
  endedAt: optionalInteger(row, 'ended_at'),
  activityCount: integer(row, 'activity_count'),
  errorCount: integer(row, 'error_count'),
  ...absent('preCheckpointId', optionalText(row, 'pre_checkpoint_id')),
  ...absent('postCheckpointId', optionalText(row, 'post_checkpoint_id')),
})

const toActivity = (row: Row): ActivityRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id: text(row, 'id'),
  turnId: text(row, 'turn_id'),
  sessionId: text(row, 'session_id'),
  ...absent('parentId', optionalText(row, 'parent_id')),
  kind: text(row, 'kind') as EventKind,
  phase: text(row, 'phase') as EventPhase,
  seq: integer(row, 'seq'),
  label: text(row, 'label'),
  occurredAt: integer(row, 'occurred_at'),
  ...absent('payloadRef', optionalText(row, 'payload_ref')),
  // The column is NOT NULL 0/1 while the record's field is an optional boolean
  // whose absence already means "not truncated", so 0 reads back as absent.
  ...(flag(row, 'truncated') ? { truncated: true } : {}),
})

const toCheckpoint = (row: Row): CheckpointRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id: text(row, 'id'),
  workspaceId: text(row, 'workspace_id'),
  turnId: text(row, 'turn_id'),
  phase: text(row, 'phase') as CheckpointPhase,
  ...absent('headOid', optionalText(row, 'head_oid')),
  ...absent('branch', optionalText(row, 'branch')),
  cleanStart: flag(row, 'clean_start'),
  ...absent('indexDigest', optionalText(row, 'index_digest')),
  ...absent('worktreeDigest', optionalText(row, 'worktree_digest')),
  ...absent('fileDigests', optionalDigestMap(row, 'file_digests')),
  restorable: flag(row, 'restorable'),
  createdAt: integer(row, 'created_at'),
  ...absent('failureReason', optionalText(row, 'failure_reason')),
})

const toObjectRecord = (row: Row): ObjectRecord => ({
  schemaVersion: SCHEMA_VERSION,
  ref: text(row, 'ref'),
  kind: text(row, 'kind'),
  byteSize: integer(row, 'byte_size'),
  sha256: text(row, 'sha256'),
  createdAt: integer(row, 'created_at'),
})

const TURN_COLUMNS =
  'id, session_id, ordinal, status, started_at, ended_at, activity_count, error_count, pre_checkpoint_id, post_checkpoint_id'

const ACTIVITY_COLUMNS =
  'id, turn_id, session_id, parent_id, kind, phase, seq, label, occurred_at, payload_ref, truncated'

const CHECKPOINT_COLUMNS =
  'id, workspace_id, turn_id, phase, head_oid, branch, clean_start, index_digest, worktree_digest, file_digests, restorable, created_at, failure_reason'

/**
 * Open a {@link TraceRepository} over an already-migrated index.
 *
 * The driver is synchronous and so is every statement below; the methods are
 * `async` only because the port is. Nothing here awaits between statements, so a
 * caller's `BEGIN IMMEDIATE` cannot have another writer interleaved into it.
 */
export function createRepository(handle: IndexHandle): TraceRepository {
  const { db } = handle

  // Statements are prepared once and reused; the SQL is a module-level constant,
  // so the key is stable and the cache cannot grow with data.
  const prepared = new Map<string, StatementSync>()
  const statement = (sql: string): StatementSync => {
    const cached = prepared.get(sql)
    if (cached !== undefined) return cached
    const created = db.prepare(sql)
    prepared.set(sql, created)
    return created
  }

  const all = (sql: string, ...params: SQLInputValue[]): Row[] => statement(sql).all(...params)
  const one = (sql: string, ...params: SQLInputValue[]): Row | undefined =>
    statement(sql).get(...params)

  const upsertWorkspace = async (record: WorkspaceRecord): Promise<void> => {
    statement(
      `INSERT INTO workspaces (id, repo_root, repo_root_hash, settings_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         repo_root = excluded.repo_root,
         repo_root_hash = excluded.repo_root_hash,
         settings_json = excluded.settings_json,
         created_at = excluded.created_at`,
    ).run(record.id, record.repoRoot, record.repoRootHash, record.settingsJson, record.createdAt)
  }

  const upsertSession = async (record: SessionRecord): Promise<void> => {
    statement(
      `INSERT INTO sessions (id, workspace_id, upstream_session_id, parent_session_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         upstream_session_id = excluded.upstream_session_id,
         parent_session_id = excluded.parent_session_id,
         created_at = excluded.created_at`,
    ).run(
      record.id,
      record.workspaceId,
      record.upstreamSessionId,
      nullable(record.parentSessionId),
      record.createdAt,
    )
  }

  const upsertTurn = async (record: TurnRecord): Promise<void> => {
    // A plain last-write-wins upsert. The terminal-state rule is not applied
    // here on purpose: it belongs to `closeTurn`, which is the transition the
    // recorder performs, and above this port to `transitionTurn`. Storage that
    // silently second-guessed a status would make a replay look like a state
    // machine bug rather than the overwrite it is.
    statement(
      `INSERT INTO turns (${TURN_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id,
         ordinal = excluded.ordinal,
         status = excluded.status,
         started_at = excluded.started_at,
         ended_at = excluded.ended_at,
         activity_count = excluded.activity_count,
         error_count = excluded.error_count,
         pre_checkpoint_id = excluded.pre_checkpoint_id,
         post_checkpoint_id = excluded.post_checkpoint_id`,
    ).run(
      record.id,
      record.sessionId,
      record.ordinal,
      record.status,
      record.startedAt,
      nullable(record.endedAt),
      record.activityCount,
      record.errorCount,
      nullable(record.preCheckpointId),
      nullable(record.postCheckpointId),
    )
  }

  const closeTurn = async (
    turnId: string,
    status: TurnStatus,
    endedAt: number,
  ): Promise<void> => {
    // The terminal set is spelled out here rather than read first and compared
    // in JavaScript: one statement means a concurrent late event cannot slip
    // between the read and the write and resurrect a finished turn.
    statement(
      `UPDATE turns SET status = ?, ended_at = ?
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'interrupted')`,
    ).run(status, endedAt, turnId)
  }

  const listTurns = async (sessionId: string, limit: number): Promise<readonly TurnRecord[]> => {
    return all(
      `SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? ORDER BY ordinal DESC LIMIT ?`,
      sessionId,
      limit,
    ).map(toTurn)
  }

  const getTurn = async (turnId: string): Promise<TurnRecord | undefined> => {
    const row = one(`SELECT ${TURN_COLUMNS} FROM turns WHERE id = ?`, turnId)
    return row === undefined ? undefined : toTurn(row)
  }

  const appendActivity = async (record: ActivityRecord): Promise<void> => {
    // An event replayed by the harness maps to the same activity id by
    // construction (Task 2's `activityIdFor`), so the first write wins and the
    // second is a no-op. `DO NOTHING` rather than `DO UPDATE` keeps an append
    // an append: a later duplicate must not rewrite an already-observed payload.
    statement(
      `INSERT INTO activities (${ACTIVITY_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      record.id,
      record.turnId,
      record.sessionId,
      nullable(record.parentId),
      record.kind,
      record.phase,
      record.seq,
      record.label,
      record.occurredAt,
      nullable(record.payloadRef),
      toSqlFlag(record.truncated === true),
    )
  }

  const getActivities = async (turnId: string): Promise<readonly ActivityRecord[]> => {
    // `seq` is unique and monotonic per session, so ordering by it reproduces
    // the upstream order rather than the order they happened to be written.
    return all(
      `SELECT ${ACTIVITY_COLUMNS} FROM activities WHERE turn_id = ? ORDER BY seq ASC`,
      turnId,
    ).map(toActivity)
  }

  const putCheckpoint = async (record: CheckpointRecord): Promise<void> => {
    statement(
      `INSERT INTO checkpoints (${CHECKPOINT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         turn_id = excluded.turn_id,
         phase = excluded.phase,
         head_oid = excluded.head_oid,
         branch = excluded.branch,
         clean_start = excluded.clean_start,
         index_digest = excluded.index_digest,
         worktree_digest = excluded.worktree_digest,
         file_digests = excluded.file_digests,
         restorable = excluded.restorable,
         created_at = excluded.created_at,
         failure_reason = excluded.failure_reason`,
    ).run(
      record.id,
      record.workspaceId,
      record.turnId,
      record.phase,
      nullable(record.headOid),
      nullable(record.branch),
      toSqlFlag(record.cleanStart),
      nullable(record.indexDigest),
      nullable(record.worktreeDigest),
      record.fileDigests === undefined ? null : JSON.stringify(record.fileDigests),
      toSqlFlag(record.restorable),
      record.createdAt,
      nullable(record.failureReason),
    )
  }

  const getCheckpoint = async (id: string): Promise<CheckpointRecord | undefined> => {
    const row = one(`SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE id = ?`, id)
    return row === undefined ? undefined : toCheckpoint(row)
  }

  const listCheckpoints = async (turnId: string): Promise<readonly CheckpointRecord[]> => {
    // `created_at` orders the pre checkpoint before the post one; the id breaks
    // a tie inside the same millisecond so the result is fully deterministic.
    return all(
      `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE turn_id = ?
       ORDER BY created_at ASC, id ASC`,
      turnId,
    ).map(toCheckpoint)
  }

  const putObjectRecord = async (record: ObjectRecord): Promise<void> => {
    statement(
      `INSERT INTO objects (ref, kind, byte_size, sha256, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET
         kind = excluded.kind,
         byte_size = excluded.byte_size,
         sha256 = excluded.sha256,
         created_at = excluded.created_at`,
    ).run(record.ref, record.kind, record.byteSize, record.sha256, record.createdAt)
  }

  const statObject = async (ref: string): Promise<ObjectRecord | undefined> => {
    const row = one(
      'SELECT ref, kind, byte_size, sha256, created_at FROM objects WHERE ref = ?',
      ref,
    )
    return row === undefined ? undefined : toObjectRecord(row)
  }

  const referencedRefs = async (): Promise<readonly string[]> => {
    // Activities are the only records that hold a plugin object ref in this
    // slice. A checkpoint carries git digests, not refs: it observes the
    // repository without creating anything in the object store, and `tree_ref`
    // — the column a restorable checkpoint would use — is deliberately absent
    // until a Restore/Fork plan adds it. Returning those digests as if they were
    // refs would make retention pin strings no object can ever match, so the
    // union over checkpoints is empty by construction rather than by omission.
    return all(
      `SELECT DISTINCT payload_ref AS ref FROM activities
       WHERE payload_ref IS NOT NULL
       ORDER BY ref ASC`,
    ).map(row => text(row, 'ref'))
  }

  const storageUsage = async (): Promise<{
    readonly objectBytes: number
    readonly objectCount: number
  }> => {
    const row = one(
      'SELECT COALESCE(SUM(byte_size), 0) AS object_bytes, COUNT(*) AS object_count FROM objects',
    )
    if (row === undefined) return { objectBytes: 0, objectCount: 0 }
    return { objectBytes: integer(row, 'object_bytes'), objectCount: integer(row, 'object_count') }
  }

  const close = async (): Promise<void> => {
    handle.close()
  }

  return {
    upsertWorkspace,
    upsertSession,
    upsertTurn,
    closeTurn,
    listTurns,
    getTurn,
    appendActivity,
    getActivities,
    putCheckpoint,
    getCheckpoint,
    listCheckpoints,
    putObjectRecord,
    statObject,
    referencedRefs,
    storageUsage,
    close,
  }
}
