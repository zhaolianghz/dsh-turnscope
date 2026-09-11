import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The architectural rule that only `src/storage/` imports `node:sqlite` governs
// production code. A guard test must not build its "foreign database" fixture
// with the very code under test, so this file drives the driver directly.
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  ActivityRecord,
  CheckpointRecord,
  EventKind,
  EventPhase,
  ObjectRecord,
  SessionRecord,
  TurnRecord,
  TurnStatus,
  WorkspaceRecord,
} from '../../src/host/domain/types.ts'
import type { IndexHandle } from '../../src/host/storage/sqlite-index.ts'
import { SCHEMA_VERSION, TRACESCOPE_APPLICATION_ID } from '../../src/host/storage/schema.ts'
import { openIndex } from '../../src/host/storage/sqlite-index.ts'
import { createRepository, type TraceRepository } from '../../src/host/storage/repository.ts'

const START = 1_700_000_000_000
const END = START + 5_000
const REF_A = `sha256:${'a'.repeat(64)}`
const REF_B = `sha256:${'b'.repeat(64)}`

interface TurnPatch {
  readonly id?: string
  readonly sessionId?: string
  readonly ordinal?: number
  readonly status?: TurnStatus
  readonly startedAt?: number
  readonly endedAt?: number
  readonly activityCount?: number
  readonly errorCount?: number
  readonly preCheckpointId?: string
  readonly postCheckpointId?: string
  readonly workspaceId?: string
  readonly evidenceCompleteness?: TurnRecord['evidenceCompleteness']
}

/**
 * Build a {@link TurnRecord}. Optional fields are spread conditionally: under
 * `exactOptionalPropertyTypes` an explicitly `undefined` optional is not the
 * same as an absent one, and the round-trip tests depend on telling them apart.
 */
const turn = (patch: TurnPatch = {}): TurnRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id: patch.id ?? 's-1:turn:0',
  sessionId: patch.sessionId ?? 's-1',
  workspaceId: patch.workspaceId ?? 'ws-1',
  ordinal: patch.ordinal ?? 0,
  status: patch.status ?? 'running',
  startedAt: patch.startedAt ?? START,
  endedAt: patch.endedAt,
  activityCount: patch.activityCount ?? 0,
  errorCount: patch.errorCount ?? 0,
  evidenceCompleteness: patch.evidenceCompleteness ?? 'complete',
  ...(patch.preCheckpointId === undefined ? {} : { preCheckpointId: patch.preCheckpointId }),
  ...(patch.postCheckpointId === undefined ? {} : { postCheckpointId: patch.postCheckpointId }),
})

interface ActivityPatch {
  readonly id?: string
  readonly turnId?: string
  readonly sessionId?: string
  readonly parentId?: string
  readonly kind?: EventKind
  readonly phase?: EventPhase
  readonly seq?: number
  readonly label?: string
  readonly occurredAt?: number
  readonly payloadRef?: string
  readonly truncated?: boolean
}

const activity = (patch: ActivityPatch = {}): ActivityRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id: patch.id ?? 's-1:act:1',
  turnId: patch.turnId ?? 's-1:turn:0',
  sessionId: patch.sessionId ?? 's-1',
  kind: patch.kind ?? 'tool',
  phase: patch.phase ?? 'started',
  seq: patch.seq ?? 1,
  label: patch.label ?? 'read src/index.ts',
  occurredAt: patch.occurredAt ?? START,
  ...(patch.parentId === undefined ? {} : { parentId: patch.parentId }),
  ...(patch.payloadRef === undefined ? {} : { payloadRef: patch.payloadRef }),
  ...(patch.truncated === undefined ? {} : { truncated: patch.truncated }),
})

interface CheckpointPatch {
  readonly id?: string
  readonly workspaceId?: string
  readonly turnId?: string
  readonly phase?: 'pre' | 'post'
  readonly headOid?: string
  readonly branch?: string
  readonly cleanStart?: boolean
  readonly indexDigest?: string
  readonly worktreeDigest?: string
  readonly fileDigests?: Readonly<Record<string, string>>
  readonly restorable?: boolean
  readonly mergeInProgress?: boolean
  readonly rebaseInProgress?: boolean
  readonly cherryPickInProgress?: boolean
  readonly completeness?: CheckpointRecord['completeness']
  readonly createdAt?: number
  readonly failureReason?: string
}

const checkpoint = (patch: CheckpointPatch = {}): CheckpointRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id: patch.id ?? 's-1:turn:0:cp:pre',
  workspaceId: patch.workspaceId ?? 'ws-1',
  turnId: patch.turnId ?? 's-1:turn:0',
  phase: patch.phase ?? 'pre',
  cleanStart: patch.cleanStart ?? true,
  mergeInProgress: patch.mergeInProgress ?? false,
  rebaseInProgress: patch.rebaseInProgress ?? false,
  cherryPickInProgress: patch.cherryPickInProgress ?? false,
  completeness: patch.completeness ?? 'complete',
  restorable: patch.restorable ?? true,
  createdAt: patch.createdAt ?? START,
  ...(patch.headOid === undefined ? {} : { headOid: patch.headOid }),
  ...(patch.branch === undefined ? {} : { branch: patch.branch }),
  ...(patch.indexDigest === undefined ? {} : { indexDigest: patch.indexDigest }),
  ...(patch.worktreeDigest === undefined ? {} : { worktreeDigest: patch.worktreeDigest }),
  ...(patch.fileDigests === undefined ? {} : { fileDigests: patch.fileDigests }),
  ...(patch.failureReason === undefined ? {} : { failureReason: patch.failureReason }),
})

const workspace: WorkspaceRecord = {
  schemaVersion: SCHEMA_VERSION,
  id: 'ws-1',
  repoRoot: '/home/dev/repo',
  repoRootHash: 'c'.repeat(64),
  settingsJson: '{"retentionDays":30}',
  createdAt: START,
}

const session: SessionRecord = {
  schemaVersion: SCHEMA_VERSION,
  id: 's-1',
  workspaceId: 'ws-1',
  upstreamSessionId: 'up-1',
  createdAt: START,
}

const objectRecord = (ref: string, byteSize: number): ObjectRecord => ({
  schemaVersion: SCHEMA_VERSION,
  ref,
  kind: 'activity-payload',
  byteSize,
  sha256: ref.slice('sha256:'.length),
  createdAt: START,
})

let root: string
let handles: IndexHandle[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'turnscope-index-'))
  handles = []
})

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close()
  await rm(root, { recursive: true, force: true })
})

const open = async (name = 'index.sqlite3'): Promise<IndexHandle> => {
  const handle = await openIndex(join(root, name))
  handles.push(handle)
  return handle
}

/** A fresh repository over a fresh index, with the handle tracked for cleanup. */
const openRepository = async (name?: string): Promise<TraceRepository> =>
  createRepository(await open(name))

const pragmaValue = (handle: IndexHandle, name: string): unknown => {
  const row = handle.db.prepare(`PRAGMA ${name}`).get()
  return row === undefined ? undefined : Object.values(row)[0]
}

const columnNames = (handle: IndexHandle, table: string): string[] =>
  handle.db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map(row => String(row['name']))

const indexNames = (handle: IndexHandle): string[] =>
  handle.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
    .all()
    .map(row => String(row['name']))

const indexedColumns = (handle: IndexHandle, index: string): string[] =>
  handle.db
    .prepare(`PRAGMA index_info(${index})`)
    .all()
    .map(row => String(row['name']))

const tableSql = (handle: IndexHandle, table: string): string => {
  const row = handle.db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table)
  return String(row?.['sql'])
}

const scalar = (handle: IndexHandle, sql: string, ...params: string[]): unknown => {
  const row = handle.db.prepare(sql).get(...params)
  return row === undefined ? undefined : Object.values(row)[0]
}

const permissions = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

describe('openIndex', () => {
  it('creates the database with owner-only permissions', async () => {
    const directory = join(root, 'nested')
    const path = join(directory, 'index.sqlite3')
    handles.push(await openIndex(path))

    expect(await permissions(directory)).toBe(0o700)
    expect(await permissions(path)).toBe(0o600)
  })

  it('stamps our application id and schema version', async () => {
    const handle = await open()

    expect(pragmaValue(handle, 'application_id')).toBe(TRACESCOPE_APPLICATION_ID)
    expect(pragmaValue(handle, 'user_version')).toBe(SCHEMA_VERSION)
    expect(pragmaValue(handle, 'journal_mode')).toBe('wal')
    expect(pragmaValue(handle, 'foreign_keys')).toBe(1)
  })

  it('opens an empty index that answers reads with nothing', async () => {
    const repository = await openRepository()

    expect(await repository.listTurns('s-1', { limit: 10 })).toEqual({ turns: [] })
    await expect(repository.getTurn('s-1:turn:0')).resolves.toBeUndefined()
    expect(await repository.getActivities('s-1:turn:0')).toEqual([])
    expect(await repository.referencedRefs()).toEqual([])
    expect(await repository.storageUsage()).toEqual({ objectBytes: 0, objectCount: 0 })
  })

  it('creates every table as STRICT with exactly the pinned columns', async () => {
    const handle = await open()

    expect(columnNames(handle, 'workspaces')).toEqual([
      'id',
      'repo_root',
      'repo_root_hash',
      'settings_json',
      'created_at',
    ])
    expect(columnNames(handle, 'sessions')).toEqual([
      'id',
      'workspace_id',
      'upstream_session_id',
      'parent_session_id',
      'created_at',
    ])
    // Schema 2 adds its columns with ALTER TABLE, which appends them: the
    // physical order is migration history, not the logical grouping the
    // select lists use. Pinned exactly, so a future migration that reorders
    // the table has to say so here.
    expect(columnNames(handle, 'turns')).toEqual([
      'id',
      'session_id',
      'ordinal',
      'status',
      'started_at',
      'ended_at',
      'activity_count',
      'error_count',
      'pre_checkpoint_id',
      'post_checkpoint_id',
      'workspace_id',
      'evidence_completeness',
    ])
    expect(columnNames(handle, 'activities')).toEqual([
      'id',
      'turn_id',
      'session_id',
      'parent_id',
      'kind',
      'phase',
      'seq',
      'label',
      'occurred_at',
      'payload_ref',
      'truncated',
    ])
    expect(columnNames(handle, 'checkpoints')).toEqual([
      'id',
      'workspace_id',
      'turn_id',
      'phase',
      'head_oid',
      'branch',
      'clean_start',
      'index_digest',
      'worktree_digest',
      'file_digests',
      'restorable',
      'created_at',
      'failure_reason',
      'merge_in_progress',
      'rebase_in_progress',
      'cherry_pick_in_progress',
      'completeness',
    ])
    expect(columnNames(handle, 'findings')).toEqual([
      'id',
      'turn_id',
      'rule_id',
      'severity',
      'evidence_json',
    ])
    expect(columnNames(handle, 'forks')).toEqual([
      'id',
      'checkpoint_id',
      'parent_session_id',
      'child_session_id',
      'worktree_path',
      'status',
    ])
    expect(columnNames(handle, 'objects')).toEqual([
      'ref',
      'kind',
      'byte_size',
      'sha256',
      'created_at',
    ])

    for (const table of [
      'workspaces',
      'sessions',
      'turns',
      'activities',
      'checkpoints',
      'objects',
      'checkpoint_paths',
      'file_changes',
      'commands',
      'tests',
      'safety_verdicts',
    ]) {
      expect(tableSql(handle, table)).toMatch(/STRICT/)
    }
  })

  it('does not carry a tree_ref column, because this slice writes no trees', async () => {
    const handle = await open()

    expect(columnNames(handle, 'checkpoints')).not.toContain('tree_ref')
  })

  it('indexes the pinned lookup columns', async () => {
    const handle = await open()

    expect(indexNames(handle)).toEqual(
      expect.arrayContaining([
        'activities_turn_id',
        'turns_session_id_ordinal',
        'checkpoints_turn_id',
        'objects_sha256',
      ]),
    )
    expect(indexedColumns(handle, 'activities_turn_id')).toEqual(['turn_id'])
    expect(indexedColumns(handle, 'turns_session_id_ordinal')).toEqual(['session_id', 'ordinal'])
    expect(indexedColumns(handle, 'checkpoints_turn_id')).toEqual(['turn_id'])
    expect(indexedColumns(handle, 'objects_sha256')).toEqual(['sha256'])
  })

  it('is idempotent, so a second open of the same path keeps working', async () => {
    const handle = await open()
    createRepository(handle)
    handle.close()

    const reopened = await open()

    expect(pragmaValue(reopened, 'user_version')).toBe(SCHEMA_VERSION)
  })
})

describe('workspaces and sessions', () => {
  it('upserts a workspace and updates it in place', async () => {
    const handle = await open()
    const repository = createRepository(handle)

    await repository.upsertWorkspace(workspace)
    await repository.upsertWorkspace({ ...workspace, settingsJson: '{"retentionDays":7}' })

    expect(scalar(handle, 'SELECT count(*) AS n FROM workspaces')).toBe(1)
    expect(scalar(handle, 'SELECT settings_json FROM workspaces WHERE id = ?', 'ws-1')).toBe(
      '{"retentionDays":7}',
    )
  })

  it('stores a session with an absent parent as SQL NULL', async () => {
    const handle = await open()
    const repository = createRepository(handle)

    await repository.upsertSession(session)

    expect(scalar(handle, 'SELECT parent_session_id FROM sessions WHERE id = ?', 's-1')).toBe(null)
    expect(scalar(handle, 'SELECT upstream_session_id FROM sessions WHERE id = ?', 's-1')).toBe('up-1')
  })

  it('stores a session parent when one is set', async () => {
    const handle = await open()
    const repository = createRepository(handle)

    await repository.upsertSession({ ...session, parentSessionId: 's-0' })

    expect(scalar(handle, 'SELECT parent_session_id FROM sessions WHERE id = ?', 's-1')).toBe('s-0')
  })
})

describe('turns', () => {
  it('round-trips a turn, with absent optionals staying absent', async () => {
    const handle = await open()
    const repository = createRepository(handle)
    const record = turn()

    await repository.upsertTurn(record)

    expect(await repository.getTurn(record.id)).toEqual(record)
    expect(scalar(handle, 'SELECT ended_at FROM turns WHERE id = ?', record.id)).toBe(null)
    expect(scalar(handle, 'SELECT pre_checkpoint_id FROM turns WHERE id = ?', record.id)).toBe(null)
    expect(scalar(handle, 'SELECT post_checkpoint_id FROM turns WHERE id = ?', record.id)).toBe(null)
  })

  it('reads an absent endedAt back as undefined, never null', async () => {
    const repository = await openRepository()
    await repository.upsertTurn(turn())

    const read = await repository.getTurn('s-1:turn:0')

    expect(read?.endedAt).toBeUndefined()
    expect(read?.endedAt).not.toBeNull()
  })

  it('round-trips every optional and counters when they are set', async () => {
    const repository = await openRepository()
    const record = turn({
      endedAt: END,
      status: 'completed',
      activityCount: 7,
      errorCount: 2,
      preCheckpointId: 'cp-pre',
      postCheckpointId: 'cp-post',
    })

    await repository.upsertTurn(record)

    expect(await repository.getTurn(record.id)).toEqual(record)
  })

  it('returns undefined for a turn that was never written', async () => {
    const repository = await openRepository()

    await expect(repository.getTurn('nope')).resolves.toBeUndefined()
  })

  it('is idempotent on the same id', async () => {
    const handle = await open()
    const repository = createRepository(handle)

    await repository.upsertTurn(turn({ ordinal: 3 }))
    await repository.upsertTurn(turn({ ordinal: 3 }))

    expect(scalar(handle, 'SELECT count(*) AS n FROM turns')).toBe(1)
    expect(scalar(handle, 'SELECT ordinal FROM turns WHERE id = ?', 's-1:turn:0')).toBe(3)
  })

  it('lists newest first by ordinal and honours the limit', async () => {
    const repository = await openRepository()
    for (const ordinal of [0, 1, 2]) {
      await repository.upsertTurn(turn({ id: `s-1:turn:${ordinal}`, ordinal }))
    }
    await repository.upsertTurn(turn({ id: 's-2:turn:0', sessionId: 's-2', ordinal: 0 }))

    const all = await repository.listTurns('s-1', { limit: 10 })
    expect(all.turns.map(record => record.id)).toEqual(['s-1:turn:2', 's-1:turn:1', 's-1:turn:0'])

    const limited = await repository.listTurns('s-1', { limit: 2 })
    expect(limited.turns.map(record => record.id)).toEqual(['s-1:turn:2', 's-1:turn:1'])
  })

  it('reports no next cursor when the page exhausts the session', async () => {
    const repository = await openRepository()
    await repository.upsertTurn(turn({ ordinal: 0 }))

    // A short page and an exactly-full page both mean "nothing more". The extra
    // probe row is what lets the difference between "full page" and "last page"
    // be answered without a second query, and this is the case that catches a
    // naive `rows.length === limit` test.
    expect(await repository.listTurns('s-1', { limit: 1 })).toEqual({
      turns: [expect.objectContaining({ id: 's-1:turn:0' })],
    })
    expect(await repository.listTurns('s-1', { limit: 20 })).toEqual({
      turns: [expect.objectContaining({ id: 's-1:turn:0' })],
    })
  })

  it('walks a session older and older without repeating or skipping a turn', async () => {
    const repository = await openRepository()
    for (const ordinal of [0, 1, 2, 3, 4]) {
      await repository.upsertTurn(turn({ id: `s-1:turn:${ordinal}`, ordinal }))
    }

    const seen: string[] = []
    let cursor: number | undefined
    // Deliberately a bounded walk rather than `while (page.nextCursor)`: if the
    // cursor were ever returned unchanged this loop would hang, and a test that
    // can hang reports less than one that fails.
    for (let page = 0; page < 10; page += 1) {
      const result: Awaited<ReturnType<typeof repository.listTurns>> =
        cursor === undefined
          ? await repository.listTurns('s-1', { limit: 2 })
          : await repository.listTurns('s-1', { limit: 2, cursor })
      seen.push(...result.turns.map(record => record.id))
      if (result.nextCursor === undefined) break
      cursor = result.nextCursor
    }

    expect(seen).toEqual([
      's-1:turn:4',
      's-1:turn:3',
      's-1:turn:2',
      's-1:turn:1',
      's-1:turn:0',
    ])
  })

  it('keeps a page stable while newer turns are appended', async () => {
    const repository = await openRepository()
    for (const ordinal of [0, 1, 2, 3]) {
      await repository.upsertTurn(turn({ id: `s-1:turn:${ordinal}`, ordinal }))
    }

    const first = await repository.listTurns('s-1', { limit: 2 })
    // The live case this exists for: a turn lands between two page reads.
    await repository.upsertTurn(turn({ id: 's-1:turn:4', ordinal: 4 }))
    const second = await repository.listTurns('s-1', {
      limit: 2,
      ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
    })

    // An offset page would repeat `turn:2` here.
    expect([...first.turns, ...second.turns].map(record => record.id)).toEqual([
      's-1:turn:3',
      's-1:turn:2',
      's-1:turn:1',
      's-1:turn:0',
    ])
  })

  it('orders by ordinal, not by insertion order', async () => {
    const repository = await openRepository()
    for (const ordinal of [2, 0, 1]) {
      await repository.upsertTurn(turn({ id: `s-1:turn:${ordinal}`, ordinal }))
    }

    const page = await repository.listTurns('s-1', { limit: 10 })

    expect(page.turns.map(record => record.ordinal)).toEqual([2, 1, 0])
  })
})

describe('closeTurn', () => {
  it('sets the status and the end time', async () => {
    const repository = await openRepository()
    await repository.upsertTurn(turn())

    await repository.closeTurn('s-1:turn:0', 'completed', END)

    const read = await repository.getTurn('s-1:turn:0')
    expect(read?.status).toBe('completed')
    expect(read?.endedAt).toBe(END)
  })

  it('reads a turn closed as failed back as failed', async () => {
    const repository = await openRepository()
    await repository.upsertTurn(turn())

    await repository.closeTurn('s-1:turn:0', 'failed', END)

    expect((await repository.getTurn('s-1:turn:0'))?.status).toBe('failed')
  })

  it('lets a non-terminal turn reach any terminal status', async () => {
    const repository = await openRepository()
    await repository.upsertTurn(turn({ status: 'pending' }))

    await repository.closeTurn('s-1:turn:0', 'interrupted', END)

    expect((await repository.getTurn('s-1:turn:0'))?.status).toBe('interrupted')
  })

  it('leaves the original status intact when a late close arrives', async () => {
    const repository = await openRepository()
    await repository.upsertTurn(turn())
    await repository.closeTurn('s-1:turn:0', 'completed', END)

    await repository.closeTurn('s-1:turn:0', 'failed', END + 1_000)

    const read = await repository.getTurn('s-1:turn:0')
    expect(read?.status).toBe('completed')
    expect(read?.endedAt).toBe(END)
  })

  it('refuses to resurrect a terminal turn even when the late status is non-terminal', async () => {
    const repository = await openRepository()
    await repository.upsertTurn(turn())
    await repository.closeTurn('s-1:turn:0', 'failed', END)

    await repository.closeTurn('s-1:turn:0', 'running', END + 1_000)

    const read = await repository.getTurn('s-1:turn:0')
    expect(read?.status).toBe('failed')
    expect(read?.endedAt).toBe(END)
  })

  it('silently ignores a close for an unknown turn', async () => {
    const repository = await openRepository()

    await expect(repository.closeTurn('nope', 'completed', END)).resolves.toBeUndefined()
  })
})

describe('activities', () => {
  it('round-trips a turn plus three activities with every field equal', async () => {
    const repository = await openRepository()
    const record = turn()
    const records = [
      activity({ id: 's-1:act:1', seq: 1, kind: 'tool', phase: 'started' }),
      activity({ id: 's-1:act:2', seq: 2, kind: 'command', phase: 'completed' }),
      activity({ id: 's-1:act:3', seq: 3, kind: 'error', phase: 'failed', parentId: 's-1:act:1' }),
    ]

    await repository.upsertTurn(record)
    for (const item of records) await repository.appendActivity(item)

    expect(await repository.getTurn(record.id)).toEqual(record)
    expect(await repository.getActivities(record.id)).toEqual(records)
  })

  it('returns activities in upstream seq order', async () => {
    const repository = await openRepository()
    for (const seq of [3, 1, 2]) {
      await repository.appendActivity(activity({ id: `s-1:act:${seq}`, seq }))
    }

    const records = await repository.getActivities('s-1:turn:0')

    expect(records.map(record => record.seq)).toEqual([1, 2, 3])
  })

  it('round-trips payloadRef and truncated when set, and leaves them absent otherwise', async () => {
    const repository = await openRepository()
    await repository.appendActivity(
      activity({ id: 's-1:act:1', seq: 1, payloadRef: REF_A, truncated: true }),
    )
    await repository.appendActivity(activity({ id: 's-1:act:2', seq: 2 }))

    const records = await repository.getActivities('s-1:turn:0')

    expect(records[0]).toEqual(
      activity({ id: 's-1:act:1', seq: 1, payloadRef: REF_A, truncated: true }),
    )
    expect(records[1]?.payloadRef).toBeUndefined()
    expect(records[1]?.truncated).toBeUndefined()
  })

  it('reads a payloadRef back out of SQL as a plain string', async () => {
    const handle = await open()
    const repository = createRepository(handle)
    await repository.appendActivity(activity({ payloadRef: REF_A }))

    expect(scalar(handle, 'SELECT payload_ref FROM activities WHERE id = ?', 's-1:act:1')).toBe(REF_A)
    expect(scalar(handle, 'SELECT truncated FROM activities WHERE id = ?', 's-1:act:1')).toBe(0)
  })

  it('leaves exactly one row when the same activity id is appended twice', async () => {
    const handle = await open()
    const repository = createRepository(handle)

    await repository.appendActivity(activity({ id: 's-1:act:1', seq: 1, label: 'first' }))
    await repository.appendActivity(activity({ id: 's-1:act:1', seq: 1, label: 'second' }))

    const records = await repository.getActivities('s-1:turn:0')
    expect(records).toHaveLength(1)
    expect(records[0]?.label).toBe('first')
    expect(scalar(handle, 'SELECT count(*) AS n FROM activities')).toBe(1)
  })

  it('scopes reads to one turn', async () => {
    const repository = await openRepository()
    await repository.appendActivity(activity({ id: 's-1:act:1', seq: 1, turnId: 's-1:turn:0' }))
    await repository.appendActivity(activity({ id: 's-1:act:2', seq: 2, turnId: 's-1:turn:1' }))

    const records = await repository.getActivities('s-1:turn:1')

    expect(records.map(record => record.id)).toEqual(['s-1:act:2'])
  })
})

describe('checkpoints', () => {
  it('round-trips a fully populated checkpoint', async () => {
    const repository = await openRepository()
    const record = checkpoint({
      phase: 'post',
      headOid: 'd'.repeat(40),
      branch: 'main',
      indexDigest: 'e'.repeat(64),
      worktreeDigest: 'f'.repeat(64),
      fileDigests: { 'src/a.ts': '1'.repeat(40), 'src/b.ts': '2'.repeat(40) },
      cleanStart: false,
      restorable: true,
    })

    await repository.putCheckpoint(record)

    expect(await repository.getCheckpoint(record.id)).toEqual(record)
  })

  it('round-trips an absent optional as absent and keeps the booleans', async () => {
    const handle = await open()
    const repository = createRepository(handle)
    const record = checkpoint()

    await repository.putCheckpoint(record)

    const read = await repository.getCheckpoint(record.id)
    expect(read).toEqual(record)
    expect(read?.cleanStart).toBe(true)
    expect(read?.restorable).toBe(true)
    expect(read?.headOid).toBeUndefined()
    expect(read?.fileDigests).toBeUndefined()
    expect(scalar(handle, 'SELECT head_oid FROM checkpoints WHERE id = ?', record.id)).toBe(null)
    expect(scalar(handle, 'SELECT file_digests FROM checkpoints WHERE id = ?', record.id)).toBe(null)
  })

  it('stores fileDigests as JSON and reads the object back intact', async () => {
    const handle = await open()
    const repository = createRepository(handle)
    const fileDigests = { 'src/a.ts': '1'.repeat(40) }

    await repository.putCheckpoint(checkpoint({ fileDigests }))

    expect(scalar(handle, 'SELECT file_digests FROM checkpoints WHERE id = ?', 's-1:turn:0:cp:pre')).toBe(
      JSON.stringify(fileDigests),
    )
    expect((await repository.getCheckpoint('s-1:turn:0:cp:pre'))?.fileDigests).toEqual(fileDigests)
  })

  it('round-trips cleanStart false and a failureReason', async () => {
    const repository = await openRepository()
    const record = checkpoint({ cleanStart: false, restorable: false, failureReason: 'dirty worktree' })

    await repository.putCheckpoint(record)

    const read = await repository.getCheckpoint(record.id)
    expect(read?.cleanStart).toBe(false)
    expect(read?.restorable).toBe(false)
    expect(read?.failureReason).toBe('dirty worktree')
  })

  it('lists the checkpoints of one turn and returns undefined for an unknown id', async () => {
    const repository = await openRepository()
    await repository.putCheckpoint(checkpoint({ phase: 'pre' }))
    await repository.putCheckpoint(
      checkpoint({ id: 's-1:turn:0:cp:post', phase: 'post', createdAt: START + 1_000 }),
    )
    await repository.putCheckpoint(
      checkpoint({ id: 's-1:turn:1:cp:pre', turnId: 's-1:turn:1' }),
    )

    const records = await repository.listCheckpoints('s-1:turn:0')

    expect(records.map(record => record.phase)).toEqual(['pre', 'post'])
    await expect(repository.getCheckpoint('nope')).resolves.toBeUndefined()
  })
})

describe('objects', () => {
  it('stores an object record and stats it back', async () => {
    const repository = await openRepository()
    const record = objectRecord(REF_A, 1_024)

    await repository.putObjectRecord(record)

    expect(await repository.statObject(REF_A)).toEqual(record)
    await expect(repository.statObject(REF_B)).resolves.toBeUndefined()
  })

  it('keeps one row per ref when the same object is recorded twice', async () => {
    const handle = await open()
    const repository = createRepository(handle)

    await repository.putObjectRecord(objectRecord(REF_A, 1_024))
    await repository.putObjectRecord(objectRecord(REF_A, 1_024))

    expect(scalar(handle, 'SELECT count(*) AS n FROM objects')).toBe(1)
  })

  it('sums object bytes and counts rows', async () => {
    const repository = await openRepository()
    await repository.putObjectRecord(objectRecord(REF_A, 1_024))
    await repository.putObjectRecord(objectRecord(REF_B, 256))

    expect(await repository.storageUsage()).toEqual({ objectBytes: 1_280, objectCount: 2 })
  })
})

describe('referencedRefs', () => {
  it('returns the de-duplicated refs held by activities, sorted', async () => {
    const repository = await openRepository()
    await repository.appendActivity(activity({ id: 's-1:act:1', seq: 1, payloadRef: REF_B }))
    await repository.appendActivity(activity({ id: 's-1:act:2', seq: 2, payloadRef: REF_A }))
    await repository.appendActivity(activity({ id: 's-1:act:3', seq: 3, payloadRef: REF_A }))
    await repository.appendActivity(activity({ id: 's-1:act:4', seq: 4 }))

    expect(await repository.referencedRefs()).toEqual([REF_A, REF_B])
  })

  it('stops counting a ref once the last activity holding it is gone', async () => {
    const repository = await openRepository()
    await repository.appendActivity(activity({ id: 's-1:act:1', seq: 1, payloadRef: REF_A }))

    expect(await repository.referencedRefs()).toEqual([REF_A])
  })

  it('does not mistake a checkpoint digest for an object ref', async () => {
    // No checkpoint column can hold a plugin object ref in this slice: the Git
    // port produces bare git digests and `tree_ref` is deliberately absent.
    // Retention must therefore not see them as pinned objects.
    const repository = await openRepository()
    await repository.putCheckpoint(
      checkpoint({
        headOid: 'd'.repeat(40),
        indexDigest: 'e'.repeat(64),
        worktreeDigest: 'f'.repeat(64),
        fileDigests: { 'src/a.ts': '1'.repeat(40) },
      }),
    )

    expect(await repository.referencedRefs()).toEqual([])
  })
})

describe('openIndex ownership guards', () => {
  it('refuses a database that belongs to another application, leaving it untouched', async () => {
    const path = join(root, 'foreign.sqlite3')
    const foreign = new DatabaseSync(path)
    foreign.exec('PRAGMA application_id = 1234567')
    foreign.exec('CREATE TABLE their_data (id TEXT PRIMARY KEY NOT NULL) STRICT')
    foreign.prepare('INSERT INTO their_data (id) VALUES (?)').run('keep me')
    foreign.close()
    const before = await readFile(path)

    await expect(openIndex(path)).rejects.toThrow(/another application/i)
    await expect(openIndex(path)).rejects.toThrow(path)

    expect((await readFile(path)).equals(before)).toBe(true)

    const after = new DatabaseSync(path)
    expect(Object.values(after.prepare('PRAGMA application_id').get() ?? {})[0]).toBe(1234567)
    expect(after.prepare('SELECT id FROM their_data').all().map(row => String(row['id']))).toEqual([
      'keep me',
    ])
    after.close()
  })

  it('refuses an anonymous database that already contains tables', async () => {
    const path = join(root, 'anonymous.sqlite3')
    const foreign = new DatabaseSync(path)
    foreign.exec('CREATE TABLE somebody_elses (id TEXT PRIMARY KEY NOT NULL) STRICT')
    foreign.close()
    const before = await readFile(path)

    await expect(openIndex(path)).rejects.toThrow(/already contains|another application/i)

    expect((await readFile(path)).equals(before)).toBe(true)
  })

  it('refuses a database written by a newer version of Turnscope', async () => {
    const path = join(root, 'future.sqlite3')
    const handle = await openIndex(path)
    handle.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    handle.close()

    await expect(openIndex(path)).rejects.toThrow(/newer version of Turnscope/i)
  })

  it('adopts our own database on a second open', async () => {
    const path = join(root, 'ours.sqlite3')
    const first = await openIndex(path)
    createRepository(first)
    first.close()

    const second = await openIndex(path)

    expect(pragmaValue(second, 'application_id')).toBe(TRACESCOPE_APPLICATION_ID)
    second.close()
  })
})

describe('openIndex corrupt-file guard', () => {
  it('rejects a file that is not a database with a message naming it', async () => {
    const path = join(root, 'corrupt.sqlite3')
    await writeFile(path, 'not a database')
    const before = await readFile(path)

    await expect(openIndex(path)).rejects.toThrow(/not a SQLite database/i)
    await expect(openIndex(path)).rejects.toThrow(path)

    expect((await readFile(path)).equals(before)).toBe(true)
  })

  it('rejects rather than leaving a half-open handle behind', async () => {
    const path = join(root, 'corrupt.sqlite3')
    await writeFile(path, 'not a database')

    await expect(openIndex(path)).rejects.toBeInstanceOf(Error)

    // The failed open must not have locked the path out: replacing the file
    // with a real database lets the next open succeed.
    await rm(path)
    await mkdir(root, { recursive: true })
    const handle = await openIndex(path)
    handles.push(handle)
    expect(pragmaValue(handle, 'user_version')).toBe(SCHEMA_VERSION)
  })

  it('rejects a path that cannot hold a database at all', async () => {
    const path = join(root, 'a-directory.sqlite3')
    await mkdir(path)

    await expect(openIndex(path)).rejects.toThrow(path)
    await expect(openIndex(path)).rejects.toThrow(/not a usable SQLite database/i)
  })
})

describe('transactions', () => {
  it('rolls back everything a transaction wrote', async () => {
    const handle = await open()
    const repository = createRepository(handle)

    handle.db.exec('BEGIN IMMEDIATE')
    expect(handle.db.isTransaction).toBe(true)
    handle.db
      .prepare(
        'INSERT INTO workspaces (id, repo_root, repo_root_hash, settings_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('ws-tx', '/repo', 'a'.repeat(64), '{}', START)
    await repository.upsertTurn(turn({ id: 's-1:turn:9', ordinal: 9 }))
    handle.db.exec('ROLLBACK')

    expect(handle.db.isTransaction).toBe(false)
    expect(scalar(handle, 'SELECT count(*) AS n FROM workspaces')).toBe(0)
    expect(await repository.listTurns('s-1', { limit: 10 })).toEqual({ turns: [] })
  })

  it('makes a committed transaction visible', async () => {
    const handle = await open()

    handle.db.exec('BEGIN IMMEDIATE')
    handle.db
      .prepare(
        'INSERT INTO workspaces (id, repo_root, repo_root_hash, settings_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('ws-tx', '/repo', 'a'.repeat(64), '{}', START)
    handle.db.exec('COMMIT')

    expect(scalar(handle, 'SELECT count(*) AS n FROM workspaces')).toBe(1)
  })
})

describe('restart recovery', () => {
  it('reads every record back after a close and reopen', async () => {
    const path = join(root, 'index.sqlite3')
    const first = await openIndex(path)
    const before = createRepository(first)
    const turnRecord = turn({ ordinal: 4, endedAt: END, status: 'completed', activityCount: 2 })
    const activityRecord = activity({ id: 's-1:act:1', seq: 1, payloadRef: REF_A })
    const checkpointRecord = checkpoint({ phase: 'post', fileDigests: { 'src/a.ts': 'x'.repeat(40) } })
    const objectEntry = objectRecord(REF_A, 512)

    await before.upsertWorkspace(workspace)
    await before.upsertSession(session)
    await before.upsertTurn(turnRecord)
    await before.appendActivity(activityRecord)
    await before.putCheckpoint(checkpointRecord)
    await before.putObjectRecord(objectEntry)
    await before.close()
    handles.splice(handles.indexOf(first), 1)

    const second = await openIndex(path)
    handles.push(second)
    const after = createRepository(second)

    expect(await after.listTurns('s-1', { limit: 10 })).toEqual({ turns: [turnRecord] })
    expect(await after.getActivities(turnRecord.id)).toEqual([activityRecord])
    expect(await after.getCheckpoint(checkpointRecord.id)).toEqual(checkpointRecord)
    expect(await after.statObject(REF_A)).toEqual(objectEntry)
    expect(await after.referencedRefs()).toEqual([REF_A])
    expect(await after.storageUsage()).toEqual({ objectBytes: 512, objectCount: 1 })
    expect(pragmaValue(second, 'user_version')).toBe(SCHEMA_VERSION)
  })

  it('rejects a write after the repository is closed', async () => {
    const repository = await openRepository()
    await repository.close()

    await expect(repository.upsertTurn(turn())).rejects.toThrow()
  })
})

describe('repository.close', () => {
  it('closes the underlying database and tolerates a second close', async () => {
    const handle = await open()
    const repository = createRepository(handle)

    await repository.close()

    expect(() => handle.close()).not.toThrow()
    expect(() => handle.db.prepare('SELECT 1').get()).toThrow()
  })
})
