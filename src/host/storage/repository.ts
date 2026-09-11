import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'
import { SCHEMA_VERSION } from '../domain/types.ts'
import type {
  ActivityRecord,
  Attribution,
  AttributionConfidence,
  CheckpointCompleteness,
  CheckpointPhase,
  CheckpointPathState,
  CheckpointRecord,
  CommandRecord,
  EventKind,
  EventPhase,
  EvidenceCompleteness,
  FileChange,
  FileChangeKind,
  ObjectRecord,
  PathStatus,
  RecoveryAction,
  SafetyLevel,
  SafetyReason,
  SafetyVerdict,
  SessionRecord,
  TestRecord,
  TurnRecord,
  TurnStatus,
  ValidationKind,
  ValidationStatus,
  WorkspaceRecord,
} from '../domain/types.ts'
import { TERMINAL_TURN_STATUSES } from '../domain/turn-state.ts'
import type { IndexHandle } from './sqlite-index.ts'

/**
 * How much of a session's turn list to read, and from where.
 *
 * `cursor` is opaque to the caller on purpose — it is the previous page's last
 * `ordinal`, but a client that treated it as an arithmetic offset would break
 * the moment the ordering key changed, so nothing in the contract invites that.
 */
export interface TurnPageQuery {
  readonly limit: number
  /** Exclusive upper bound on `ordinal`: return turns strictly older than this. */
  readonly cursor?: number
}

/** One page of turns, plus how to ask for the next one. */
export interface TurnPage {
  readonly turns: readonly TurnRecord[]
  /** Set only when more rows are known to exist, so its absence is trustworthy. */
  readonly nextCursor?: number
}

/**
 * The read side of the trace store: the port every other module consumes.
 *
 * It is the seam that keeps `node:sqlite` inside `src/host/storage`. It is also
 * the seam that would let a future backend (a remote store, a different engine)
 * be swapped in without touching the recorder, which is why every method is
 * `async` even though the current driver is synchronous.
 */
export interface TraceRepository {
  upsertWorkspace(record: WorkspaceRecord): Promise<void>
  getWorkspace(workspaceId: string): Promise<WorkspaceRecord | undefined>
  upsertSession(record: SessionRecord): Promise<void>
  upsertTurn(record: TurnRecord): Promise<void>
  /** Move a turn to a terminal status, unless it already reached one. */
  closeTurn(turnId: string, status: TurnStatus, endedAt: number): Promise<void>
  /** Record what a turn's evidence turned out to be worth, after the fact. */
  setEvidenceCompleteness(turnId: string, value: EvidenceCompleteness): Promise<void>
  /**
   * One page of a session's turns, newest ordinal first.
   *
   * Keyset rather than offset, per `docs/ARCHITECTURE.md §44.3`: a session can
   * outlive a thousand turns, and an `OFFSET` page shifts under the reader every
   * time a new turn is appended — which, for a list that is being watched live,
   * is exactly when it must not. The cursor is the `ordinal` of the last row the
   * caller saw, so the next page is "everything older than that" and nothing is
   * ever skipped or repeated.
   */
  listTurns(sessionId: string, query: TurnPageQuery): Promise<TurnPage>
  getTurn(turnId: string): Promise<TurnRecord | undefined>
  appendActivity(record: ActivityRecord): Promise<void>
  /** The activities of a turn, in upstream `seq` order. */
  getActivities(turnId: string): Promise<readonly ActivityRecord[]>
  putCheckpoint(record: CheckpointRecord): Promise<void>
  getCheckpoint(id: string): Promise<CheckpointRecord | undefined>
  listCheckpoints(turnId: string): Promise<readonly CheckpointRecord[]>
  /** Record one observed path of a checkpoint. Idempotent on the path id. */
  putCheckpointPath(record: CheckpointPathState): Promise<void>
  /** The paths a checkpoint observed, ordered by path. */
  listCheckpointPaths(checkpointId: string): Promise<readonly CheckpointPathState[]>
  /** Record one attributed file change. Idempotent on the change id. */
  putFileChange(record: FileChange): Promise<void>
  /** The changes attributed to a turn, ordered by path. */
  listFileChanges(turnId: string): Promise<readonly FileChange[]>
  /**
   * How many changes each of these turns has, in one statement.
   *
   * Bulk for the same reason the verdict lookup below is: the turn list renders
   * a count per row and refreshes while a turn runs, so a per-row query would
   * make the hot path 1 + N (`docs/ARCHITECTURE.md §44.3`).
   */
  countFileChanges(turnIds: readonly string[]): Promise<ReadonlyMap<string, number>>
  putCommand(record: CommandRecord): Promise<void>
  listCommands(turnId: string): Promise<readonly CommandRecord[]>
  putTest(record: TestRecord): Promise<void>
  listTests(turnId: string): Promise<readonly TestRecord[]>
  putSafetyVerdict(record: SafetyVerdict): Promise<void>
  /** The most recent verdict for a turn, by evaluation time. */
  getLatestVerdict(turnId: string): Promise<SafetyVerdict | undefined>
  /**
   * The most recent verdict for each of these turns, in one statement.
   *
   * "Most recent" is per turn, not per call, so the rows come back newest first
   * and the first one seen for a turn wins. A turn with no verdict is simply
   * absent from the result — which is how the caller tells "never judged" from
   * "judged `SAFE`".
   */
  latestVerdicts(turnIds: readonly string[]): Promise<ReadonlyMap<string, SafetyVerdict>>
  putObjectRecord(record: ObjectRecord): Promise<void>
  statObject(ref: string): Promise<ObjectRecord | undefined>
  /** Drop one object's index row. The bytes are the object store's business. */
  deleteObject(ref: string): Promise<void>
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

/** A `NOT NULL` column holding a JSON array of strings. */
function stringArray(row: Row, column: string): readonly string[] {
  const parsed = parsedArray(row, column, 'string')
  return parsed as readonly string[]
}

/**
 * A `NOT NULL` column holding a JSON array of objects.
 *
 * Elements are checked to be objects but not to match the record type they will
 * be handed to: the shapes are owned by the domain, and duplicating them here
 * would give a stored verdict two definitions to drift between.
 */
function objectArray(row: Row, column: string): readonly unknown[] {
  return parsedArray(row, column, 'object')
}

function parsedArray(row: Row, column: string, element: 'string' | 'object'): readonly unknown[] {
  const raw = text(row, column)
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error(`column ${column}: expected a JSON array, read ${raw}`)
  }
  for (const item of parsed) {
    const matches =
      element === 'string'
        ? typeof item === 'string'
        : item !== null && typeof item === 'object' && !Array.isArray(item)
    if (!matches) {
      throw new Error(`column ${column}: expected every element to be a ${element}, read ${raw}`)
    }
  }
  return parsed
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
  workspaceId: text(row, 'workspace_id'),
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
  evidenceCompleteness: text(row, 'evidence_completeness') as EvidenceCompleteness,
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
  mergeInProgress: flag(row, 'merge_in_progress'),
  rebaseInProgress: flag(row, 'rebase_in_progress'),
  cherryPickInProgress: flag(row, 'cherry_pick_in_progress'),
  ...absent('indexDigest', optionalText(row, 'index_digest')),
  ...absent('worktreeDigest', optionalText(row, 'worktree_digest')),
  ...absent('fileDigests', optionalDigestMap(row, 'file_digests')),
  completeness: text(row, 'completeness') as CheckpointCompleteness,
  restorable: flag(row, 'restorable'),
  createdAt: integer(row, 'created_at'),
  ...absent('failureReason', optionalText(row, 'failure_reason')),
})

const toCheckpointPath = (row: Row): CheckpointPathState => ({
  schemaVersion: SCHEMA_VERSION,
  id: text(row, 'id'),
  checkpointId: text(row, 'checkpoint_id'),
  path: text(row, 'path'),
  status: text(row, 'status') as PathStatus,
  staged: flag(row, 'staged'),
  binary: flag(row, 'binary'),
  ...absent('previousPath', optionalText(row, 'previous_path')),
  ...absent('contentHash', optionalText(row, 'content_hash')),
  ...absent('mode', optionalText(row, 'mode')),
  ...absent('blobRef', optionalText(row, 'blob_ref')),
})

const toFileChange = (row: Row): FileChange => ({
  schemaVersion: SCHEMA_VERSION,
  id: text(row, 'id'),
  turnId: text(row, 'turn_id'),
  path: text(row, 'path'),
  kind: text(row, 'kind') as FileChangeKind,
  attribution: text(row, 'attribution') as Attribution,
  confidence: text(row, 'confidence') as AttributionConfidence,
  baseline: flag(row, 'baseline'),
  ...absent('beforeHash', optionalText(row, 'before_hash')),
  ...absent('afterHash', optionalText(row, 'after_hash')),
  ...absent('currentHash', optionalText(row, 'current_hash')),
  ...absent('previousPath', optionalText(row, 'previous_path')),
  evidenceRefs: stringArray(row, 'evidence_json'),
})

const toCommand = (row: Row): CommandRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id: text(row, 'id'),
  turnId: text(row, 'turn_id'),
  ...absent('activityId', optionalText(row, 'activity_id')),
  command: text(row, 'command'),
  ...absent('exitCode', optionalInteger(row, 'exit_code')),
  ...absent('durationMs', optionalInteger(row, 'duration_ms')),
  ...absent('outputRef', optionalText(row, 'output_ref')),
})

const toTest = (row: Row): TestRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id: text(row, 'id'),
  turnId: text(row, 'turn_id'),
  ...absent('commandId', optionalText(row, 'command_id')),
  kind: text(row, 'kind') as ValidationKind,
  status: text(row, 'status') as ValidationStatus,
  summary: text(row, 'summary'),
})

const toVerdict = (row: Row): SafetyVerdict => ({
  schemaVersion: SCHEMA_VERSION,
  id: text(row, 'id'),
  turnId: text(row, 'turn_id'),
  level: text(row, 'level') as SafetyLevel,
  reasons: objectArray(row, 'reasons_json') as readonly SafetyReason[],
  allowedActions: stringArray(row, 'allowed_actions_json').map(
    (action): RecoveryAction => action as RecoveryAction,
  ),
  recommendedAction: text(row, 'recommended_action') as RecoveryAction,
  evaluatedAt: integer(row, 'evaluated_at'),
  engineVersion: integer(row, 'engine_version'),
  ...absent('currentStateHash', optionalText(row, 'current_state_hash')),
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
  'id, session_id, workspace_id, ordinal, status, started_at, ended_at, activity_count, error_count, evidence_completeness, pre_checkpoint_id, post_checkpoint_id'

const ACTIVITY_COLUMNS =
  'id, turn_id, session_id, parent_id, kind, phase, seq, label, occurred_at, payload_ref, truncated'

const CHECKPOINT_COLUMNS =
  'id, workspace_id, turn_id, phase, head_oid, branch, clean_start, merge_in_progress, rebase_in_progress, cherry_pick_in_progress, index_digest, worktree_digest, file_digests, completeness, restorable, created_at, failure_reason'

const CHECKPOINT_PATH_COLUMNS =
  'id, checkpoint_id, path, status, staged, binary, previous_path, content_hash, mode, blob_ref'

const FILE_CHANGE_COLUMNS =
  'id, turn_id, path, kind, attribution, confidence, baseline, before_hash, after_hash, current_hash, previous_path, evidence_json'

const COMMAND_COLUMNS = 'id, turn_id, activity_id, command, exit_code, duration_ms, output_ref'

const TEST_COLUMNS = 'id, turn_id, command_id, kind, status, summary'

const VERDICT_COLUMNS =
  'id, turn_id, level, reasons_json, allowed_actions_json, recommended_action, engine_version, evaluated_at, current_state_hash'

/**
 * The terminal set as a SQL `IN` list, built from the single definition in
 * `../domain/turn-state.ts`.
 *
 * The literals come from a closed union this package owns, so there is nothing
 * to inject; spelling them out separately here is what previously let the SQL
 * and the predicate disagree about which states are absorbing.
 */
const TERMINAL_STATUS_SQL = TERMINAL_TURN_STATUSES.map(status => `'${status}'`).join(', ')

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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id,
         workspace_id = excluded.workspace_id,
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
      record.workspaceId,
      record.ordinal,
      record.status,
      record.startedAt,
      nullable(record.endedAt),
      record.activityCount,
      record.errorCount,
      record.evidenceCompleteness,
      nullable(record.preCheckpointId),
      nullable(record.postCheckpointId),
    )
  }

  /**
   * `evidence_completeness` is deliberately absent from the `DO UPDATE` list
   * above. The recorder upserts a turn on every event of that turn, and those
   * records all carry the placeholder `'missing'`; including the column would
   * let a routine activity overwrite the value {@link setEvidenceCompleteness}
   * computed after observing the workspace. It is written on insert and then
   * owned by that one method.
   */
  const setEvidenceCompleteness = async (
    turnId: string,
    value: EvidenceCompleteness,
  ): Promise<void> => {
    statement('UPDATE turns SET evidence_completeness = ? WHERE id = ?').run(value, turnId)
  }

  const closeTurn = async (
    turnId: string,
    status: TurnStatus,
    endedAt: number,
  ): Promise<void> => {
    // The rule is applied in SQL rather than by reading first and comparing in
    // JavaScript: one statement means a concurrent late event cannot slip
    // between the read and the write and resurrect a finished turn.
    statement(
      `UPDATE turns SET status = ?, ended_at = ?
       WHERE id = ? AND status NOT IN (${TERMINAL_STATUS_SQL})`,
    ).run(status, endedAt, turnId)
  }

  const getWorkspace = async (workspaceId: string): Promise<WorkspaceRecord | undefined> => {
    const row = one(
      `SELECT id, repo_root, repo_root_hash, settings_json, created_at
       FROM workspaces WHERE id = ?`,
      workspaceId,
    )
    if (row === undefined) return undefined
    return {
      schemaVersion: SCHEMA_VERSION,
      id: text(row, 'id'),
      repoRoot: text(row, 'repo_root'),
      repoRootHash: text(row, 'repo_root_hash'),
      settingsJson: text(row, 'settings_json'),
      createdAt: integer(row, 'created_at'),
    }
  }

  const listTurns = async (sessionId: string, query: TurnPageQuery): Promise<TurnPage> => {
    // One row more than asked for, because "is there another page?" cannot be
    // answered from a full page: a page that exactly exhausts the session and a
    // page with one more row behind it look identical. `nextCursor` is derived
    // from the probe row and the probe row is then dropped, so the caller never
    // sees it — which is what makes the absence of `nextCursor` meaningful
    // rather than an optimistic guess.
    const probe = query.limit + 1
    const rows = await all(
      query.cursor === undefined
        ? `SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? ORDER BY ordinal DESC LIMIT ?`
        : `SELECT ${TURN_COLUMNS} FROM turns
           WHERE session_id = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT ?`,
      ...(query.cursor === undefined ? [sessionId, probe] : [sessionId, query.cursor, probe]),
    )
    const turns = rows.slice(0, query.limit).map(toTurn)
    const last = turns.at(-1)
    return rows.length > query.limit && last !== undefined
      ? { turns, nextCursor: last.ordinal }
      : { turns }
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         turn_id = excluded.turn_id,
         phase = excluded.phase,
         head_oid = excluded.head_oid,
         branch = excluded.branch,
         clean_start = excluded.clean_start,
         merge_in_progress = excluded.merge_in_progress,
         rebase_in_progress = excluded.rebase_in_progress,
         cherry_pick_in_progress = excluded.cherry_pick_in_progress,
         index_digest = excluded.index_digest,
         worktree_digest = excluded.worktree_digest,
         file_digests = excluded.file_digests,
         completeness = excluded.completeness,
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
      toSqlFlag(record.mergeInProgress),
      toSqlFlag(record.rebaseInProgress),
      toSqlFlag(record.cherryPickInProgress),
      nullable(record.indexDigest),
      nullable(record.worktreeDigest),
      record.fileDigests === undefined ? null : JSON.stringify(record.fileDigests),
      record.completeness,
      toSqlFlag(record.restorable),
      record.createdAt,
      nullable(record.failureReason),
    )
  }

  const putCheckpointPath = async (record: CheckpointPathState): Promise<void> => {
    statement(
      `INSERT INTO checkpoint_paths (${CHECKPOINT_PATH_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         checkpoint_id = excluded.checkpoint_id,
         path = excluded.path,
         status = excluded.status,
         staged = excluded.staged,
         binary = excluded.binary,
         previous_path = excluded.previous_path,
         content_hash = excluded.content_hash,
         mode = excluded.mode,
         blob_ref = excluded.blob_ref`,
    ).run(
      record.id,
      record.checkpointId,
      record.path,
      record.status,
      toSqlFlag(record.staged),
      toSqlFlag(record.binary),
      nullable(record.previousPath),
      nullable(record.contentHash),
      nullable(record.mode),
      nullable(record.blobRef),
    )
  }

  const listCheckpointPaths = async (
    checkpointId: string,
  ): Promise<readonly CheckpointPathState[]> => {
    return all(
      `SELECT ${CHECKPOINT_PATH_COLUMNS} FROM checkpoint_paths WHERE checkpoint_id = ?
       ORDER BY path ASC`,
      checkpointId,
    ).map(toCheckpointPath)
  }

  const putFileChange = async (record: FileChange): Promise<void> => {
    statement(
      `INSERT INTO file_changes (${FILE_CHANGE_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         turn_id = excluded.turn_id,
         path = excluded.path,
         kind = excluded.kind,
         attribution = excluded.attribution,
         confidence = excluded.confidence,
         baseline = excluded.baseline,
         before_hash = excluded.before_hash,
         after_hash = excluded.after_hash,
         current_hash = excluded.current_hash,
         previous_path = excluded.previous_path,
         evidence_json = excluded.evidence_json`,
    ).run(
      record.id,
      record.turnId,
      record.path,
      record.kind,
      record.attribution,
      record.confidence,
      toSqlFlag(record.baseline),
      nullable(record.beforeHash),
      nullable(record.afterHash),
      nullable(record.currentHash),
      nullable(record.previousPath),
      JSON.stringify(record.evidenceRefs),
    )
  }

  const listFileChanges = async (turnId: string): Promise<readonly FileChange[]> => {
    return all(
      `SELECT ${FILE_CHANGE_COLUMNS} FROM file_changes WHERE turn_id = ? ORDER BY path ASC`,
      turnId,
    ).map(toFileChange)
  }

  const putCommand = async (record: CommandRecord): Promise<void> => {
    statement(
      `INSERT INTO commands (${COMMAND_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         turn_id = excluded.turn_id,
         activity_id = excluded.activity_id,
         command = excluded.command,
         exit_code = excluded.exit_code,
         duration_ms = excluded.duration_ms,
         output_ref = excluded.output_ref`,
    ).run(
      record.id,
      record.turnId,
      nullable(record.activityId),
      record.command,
      nullable(record.exitCode),
      nullable(record.durationMs),
      nullable(record.outputRef),
    )
  }

  const listCommands = async (turnId: string): Promise<readonly CommandRecord[]> => {
    // No natural key orders commands within a turn, so the id does: it is derived
    // from the upstream sequence, which is monotonic.
    return all(
      `SELECT ${COMMAND_COLUMNS} FROM commands WHERE turn_id = ? ORDER BY id ASC`,
      turnId,
    ).map(toCommand)
  }

  const putTest = async (record: TestRecord): Promise<void> => {
    statement(
      `INSERT INTO tests (${TEST_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         turn_id = excluded.turn_id,
         command_id = excluded.command_id,
         kind = excluded.kind,
         status = excluded.status,
         summary = excluded.summary`,
    ).run(
      record.id,
      record.turnId,
      nullable(record.commandId),
      record.kind,
      record.status,
      record.summary,
    )
  }

  const listTests = async (turnId: string): Promise<readonly TestRecord[]> => {
    return all(`SELECT ${TEST_COLUMNS} FROM tests WHERE turn_id = ? ORDER BY id ASC`, turnId).map(
      toTest,
    )
  }

  const putSafetyVerdict = async (record: SafetyVerdict): Promise<void> => {
    statement(
      `INSERT INTO safety_verdicts (${VERDICT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         turn_id = excluded.turn_id,
         level = excluded.level,
         reasons_json = excluded.reasons_json,
         allowed_actions_json = excluded.allowed_actions_json,
         recommended_action = excluded.recommended_action,
         engine_version = excluded.engine_version,
         evaluated_at = excluded.evaluated_at,
         current_state_hash = excluded.current_state_hash`,
    ).run(
      record.id,
      record.turnId,
      record.level,
      JSON.stringify(record.reasons),
      JSON.stringify(record.allowedActions),
      record.recommendedAction,
      record.engineVersion,
      record.evaluatedAt,
      nullable(record.currentStateHash),
    )
  }

  const getLatestVerdict = async (turnId: string): Promise<SafetyVerdict | undefined> => {
    // A turn may be re-evaluated as the workspace moves, so "the verdict" is the
    // newest one. The id breaks a tie inside one millisecond deterministically.
    const row = one(
      `SELECT ${VERDICT_COLUMNS} FROM safety_verdicts WHERE turn_id = ?
       ORDER BY evaluated_at DESC, id DESC LIMIT 1`,
      turnId,
    )
    return row === undefined ? undefined : toVerdict(row)
  }

  const countFileChanges = async (
    turnIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> => {
    // An empty `IN ()` is a syntax error rather than a vacuous truth, and the
    // empty page is the first thing a fresh session produces.
    if (turnIds.length === 0) return new Map()
    const rows = await all(
      `SELECT turn_id, count(*) AS n FROM file_changes
       WHERE turn_id IN (${turnIds.map(() => '?').join(', ')}) GROUP BY turn_id`,
      ...turnIds,
    )
    return new Map(rows.map(row => [text(row, 'turn_id'), integer(row, 'n')]))
  }

  const latestVerdicts = async (
    turnIds: readonly string[],
  ): Promise<ReadonlyMap<string, SafetyVerdict>> => {
    if (turnIds.length === 0) return new Map()
    // Sorted across all the requested turns rather than per turn, then resolved
    // first-pass-wins in JavaScript. Per-turn ordering would need a window
    // function for no gain: the tie-break below is the same one
    // `getLatestVerdict` uses, so the two agree on every turn.
    const rows = await all(
      `SELECT ${VERDICT_COLUMNS} FROM safety_verdicts
       WHERE turn_id IN (${turnIds.map(() => '?').join(', ')})
       ORDER BY evaluated_at DESC, id DESC`,
      ...turnIds,
    )
    const latest = new Map<string, SafetyVerdict>()
    for (const row of rows) {
      const verdict = toVerdict(row)
      if (!latest.has(verdict.turnId)) latest.set(verdict.turnId, verdict)
    }
    return latest
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
    // Every record that can own an object, unioned in one statement so the list
    // cannot be assembled from a partial read. Three arms do hold refs now:
    // activities carry redacted diagnostic payloads, checkpoint paths carry the
    // raw file bytes a recovery would need, and commands carry their output.
    // A ref this misses is an object retention will delete out from under a
    // record that still names it.
    return all(
      `SELECT DISTINCT ref FROM (
         SELECT payload_ref AS ref FROM activities WHERE payload_ref IS NOT NULL
         UNION
         SELECT blob_ref AS ref FROM checkpoint_paths WHERE blob_ref IS NOT NULL
         UNION
         SELECT output_ref AS ref FROM commands WHERE output_ref IS NOT NULL
       ) ORDER BY ref ASC`,
    ).map(row => text(row, 'ref'))
  }

  const deleteObject = async (ref: string): Promise<void> => {
    // The index row only. The bytes belong to the object store, and retention
    // deletes them there; a port method that reached into the filesystem would
    // put path handling in two modules.
    statement('DELETE FROM objects WHERE ref = ?').run(ref)
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
    getWorkspace,
    upsertSession,
    upsertTurn,
    closeTurn,
    setEvidenceCompleteness,
    listTurns,
    getTurn,
    appendActivity,
    getActivities,
    putCheckpoint,
    getCheckpoint,
    listCheckpoints,
    putCheckpointPath,
    listCheckpointPaths,
    putFileChange,
    listFileChanges,
    countFileChanges,
    putCommand,
    listCommands,
    putTest,
    listTests,
    putSafetyVerdict,
    getLatestVerdict,
    latestVerdicts,
    putObjectRecord,
    statObject,
    deleteObject,
    referencedRefs,
    storageUsage,
    close,
  }
}
