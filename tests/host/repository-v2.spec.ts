/**
 * The schema-2 half of the repository port: the records the attribution and
 * safety engines write.
 *
 * Kept apart from `repository.spec.ts`, which covers the turn and activity store
 * the recorder has always used. The split is by when the table was added, and it
 * is worth being explicit that it is *not* a statement about importance — the
 * `referencedRefs` union below is the difference between retention deleting a
 * file's only copy and not, and it spans both halves.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CheckpointPathState,
  CommandRecord,
  FileChange,
  SafetyVerdict,
  TestRecord,
  TurnRecord,
} from '../../src/host/domain/types.ts'
import { SCHEMA_VERSION } from '../../src/host/domain/types.ts'
import { createRepository } from '../../src/host/storage/repository.ts'
import type { TraceRepository } from '../../src/host/storage/repository.ts'
import { openIndex } from '../../src/host/storage/sqlite-index.ts'

const created: string[] = []
const open: TraceRepository[] = []

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close()
  await Promise.all(created.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function bench(): Promise<TraceRepository> {
  const dir = await mkdtemp(join(tmpdir(), 'turnscope-repo2-'))
  created.push(dir)
  const handle = await openIndex(join(dir, 'index.sqlite3'))
  const repository = createRepository(handle)
  open.push(repository)
  return repository
}

const turn = (patch: Partial<TurnRecord> = {}): TurnRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id: 's-1:turn:0',
  sessionId: 's-1',
  workspaceId: 'ws-1',
  ordinal: 0,
  status: 'running',
  startedAt: 1_000,
  endedAt: undefined,
  activityCount: 0,
  errorCount: 0,
  evidenceCompleteness: 'missing',
  ...patch,
})

const pathState = (patch: Partial<CheckpointPathState> = {}): CheckpointPathState => ({
  schemaVersion: SCHEMA_VERSION,
  id: 'cp-1:src/b.ts',
  checkpointId: 'cp-1',
  path: 'src/b.ts',
  status: 'modified',
  staged: false,
  binary: false,
  ...patch,
})

const fileChange = (patch: Partial<FileChange> = {}): FileChange => ({
  schemaVersion: SCHEMA_VERSION,
  id: 's-1:turn:0:src/b.ts',
  turnId: 's-1:turn:0',
  path: 'src/b.ts',
  kind: 'modified',
  attribution: 'AGENT',
  confidence: 'high',
  baseline: false,
  evidenceRefs: ['act:1', 'cp:pre'],
  ...patch,
})

const command = (patch: Partial<CommandRecord> = {}): CommandRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id: 's-1:act:7',
  turnId: 's-1:turn:0',
  command: 'pnpm test',
  ...patch,
})

const testRecord = (patch: Partial<TestRecord> = {}): TestRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id: 's-1:turn:0:test',
  turnId: 's-1:turn:0',
  kind: 'test',
  status: 'failed',
  summary: 'pnpm test exited 1',
  ...patch,
})

const verdict = (patch: Partial<SafetyVerdict> = {}): SafetyVerdict => ({
  schemaVersion: SCHEMA_VERSION,
  id: 's-1:turn:0:verdict:1',
  turnId: 's-1:turn:0',
  level: 'FORK_ONLY',
  reasons: [
    {
      code: 'S005_TARGET_FILE_DRIFT',
      severity: 'FORK_ONLY',
      title: 'File changed after the turn',
      detail: 'src/auth.ts changed after the recorded turn',
      path: 'src/auth.ts',
      evidenceRefs: ['cp:post'],
    },
  ],
  allowedActions: ['INSPECT', 'FORK'],
  recommendedAction: 'FORK',
  evaluatedAt: 5_000,
  engineVersion: 1,
  ...patch,
})

describe('checkpoint paths', () => {
  it('round-trips every field and orders by path', async () => {
    const repo = await bench()
    await repo.putCheckpointPath(pathState({ id: 'cp-1:src/a.ts', path: 'src/a.ts' }))
    await repo.putCheckpointPath(
      pathState({
        id: 'cp-1:src/b.ts',
        previousPath: 'src/old.ts',
        status: 'renamed',
        staged: true,
        binary: true,
        contentHash: 'abc',
        mode: '100644',
        blobRef: 'sha256:deadbeef',
      }),
    )

    const paths = await repo.listCheckpointPaths('cp-1')
    expect(paths.map(entry => entry.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(paths[1]).toEqual(
      pathState({
        id: 'cp-1:src/b.ts',
        previousPath: 'src/old.ts',
        status: 'renamed',
        staged: true,
        binary: true,
        contentHash: 'abc',
        mode: '100644',
        blobRef: 'sha256:deadbeef',
      }),
    )
  })

  it('is idempotent on the path id', async () => {
    const repo = await bench()
    await repo.putCheckpointPath(pathState())
    await repo.putCheckpointPath(pathState({ status: 'deleted' }))

    const paths = await repo.listCheckpointPaths('cp-1')
    expect(paths).toHaveLength(1)
    expect(paths[0]?.status).toBe('deleted')
  })
})

describe('file changes', () => {
  it('round-trips the attribution, the baseline flag and the evidence list', async () => {
    const repo = await bench()
    await repo.putFileChange(
      fileChange({ baseline: true, beforeHash: 'b', afterHash: 'a', currentHash: 'c' }),
    )

    const changes = await repo.listFileChanges('s-1:turn:0')
    expect(changes).toHaveLength(1)
    expect(changes[0]).toEqual(
      fileChange({ baseline: true, beforeHash: 'b', afterHash: 'a', currentHash: 'c' }),
    )
  })

  it('does not lose an empty evidence list', async () => {
    const repo = await bench()
    await repo.putFileChange(fileChange({ evidenceRefs: [] }))

    const changes = await repo.listFileChanges('s-1:turn:0')
    expect(changes[0]?.evidenceRefs).toEqual([])
  })
})

describe('commands and tests', () => {
  it('round-trips a command with its exit code and duration', async () => {
    const repo = await bench()
    await repo.putCommand(command({ exitCode: 1, durationMs: 2_500, outputRef: 'sha256:out' }))

    expect(await repo.listCommands('s-1:turn:0')).toEqual([
      command({ exitCode: 1, durationMs: 2_500, outputRef: 'sha256:out' }),
    ])
  })

  it('round-trips a validation result', async () => {
    const repo = await bench()
    await repo.putTest(testRecord({ commandId: 's-1:act:7' }))

    expect(await repo.listTests('s-1:turn:0')).toEqual([testRecord({ commandId: 's-1:act:7' })])
  })
})

describe('safety verdicts', () => {
  it('round-trips the reasons and the allowed-action list', async () => {
    const repo = await bench()
    await repo.putSafetyVerdict(verdict({ currentStateHash: 'state-1' }))

    const stored = await repo.getLatestVerdict('s-1:turn:0')
    expect(stored).toEqual(verdict({ currentStateHash: 'state-1' }))
  })

  it('returns the newest verdict, because the workspace moves under an old one', async () => {
    const repo = await bench()
    await repo.putSafetyVerdict(verdict({ id: 'v1', evaluatedAt: 5_000, level: 'SAFE' }))
    await repo.putSafetyVerdict(verdict({ id: 'v2', evaluatedAt: 6_000, level: 'FORK_ONLY' }))

    expect((await repo.getLatestVerdict('s-1:turn:0'))?.level).toBe('FORK_ONLY')
  })

  it('has no verdict for a turn that was never evaluated', async () => {
    const repo = await bench()
    expect(await repo.getLatestVerdict('s-1:turn:9')).toBeUndefined()
  })
})

describe('evidence completeness', () => {
  it('records what the observation decided', async () => {
    const repo = await bench()
    await repo.upsertTurn(turn())
    await repo.setEvidenceCompleteness('s-1:turn:0', 'partial')

    expect((await repo.getTurn('s-1:turn:0'))?.evidenceCompleteness).toBe('partial')
  })

  it('survives the recorder upserting the turn again', async () => {
    const repo = await bench()
    await repo.upsertTurn(turn())
    await repo.setEvidenceCompleteness('s-1:turn:0', 'complete')

    // Every event of a turn re-upserts its row carrying the `missing`
    // placeholder. If that write could overwrite the column, a routine activity
    // would erase the observation and the safety engine would refuse to decide
    // about a turn it had fully observed.
    await repo.upsertTurn(turn({ activityCount: 4, evidenceCompleteness: 'missing' }))

    const stored = await repo.getTurn('s-1:turn:0')
    expect(stored?.evidenceCompleteness).toBe('complete')
    expect(stored?.activityCount).toBe(4)
  })
})

describe('terminal statuses', () => {
  it.each(['cancelled', 'output_limited'] as const)('absorbs a later status after %s', async (status) => {
    const repo = await bench()
    await repo.upsertTurn(turn())
    await repo.closeTurn('s-1:turn:0', status, 2_000)
    await repo.closeTurn('s-1:turn:0', 'completed', 3_000)

    const stored = await repo.getTurn('s-1:turn:0')
    expect(stored?.status).toBe(status)
    expect(stored?.endedAt).toBe(2_000)
  })
})

describe('object references', () => {
  it('unions activities, checkpoint paths and command output', async () => {
    const repo = await bench()
    await repo.putCheckpointPath(pathState({ blobRef: 'sha256:blob' }))
    await repo.putCommand(command({ outputRef: 'sha256:out' }))
    await repo.appendActivity({
      schemaVersion: SCHEMA_VERSION,
      id: 's-1:act:3',
      turnId: 's-1:turn:0',
      sessionId: 's-1',
      kind: 'tool',
      phase: 'completed',
      seq: 3,
      label: 'Tool: read_file',
      occurredAt: 1_000,
      payloadRef: 'sha256:payload',
    })

    // A missing arm is an object retention deletes while a record still names
    // it, so all three are asserted rather than the count alone.
    expect(await repo.referencedRefs()).toEqual(['sha256:blob', 'sha256:out', 'sha256:payload'])
  })

  it('drops one object row without touching the records that named it', async () => {
    const repo = await bench()
    await repo.putCheckpointPath(pathState({ blobRef: 'sha256:blob' }))
    await repo.putObjectRecord({
      schemaVersion: SCHEMA_VERSION,
      ref: 'sha256:blob',
      kind: 'recovery-blob',
      byteSize: 10,
      sha256: 'blob',
      createdAt: 1_000,
    })

    await repo.deleteObject('sha256:blob')

    expect(await repo.statObject('sha256:blob')).toBeUndefined()
    expect(await repo.listCheckpointPaths('cp-1')).toHaveLength(1)
  })
})
