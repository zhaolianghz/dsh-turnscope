/**
 * Round-trip tests for the V0.2 recovery CRUD functions, per
 * `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §4.4` and §5.
 *
 * The functions under test sit in `TraceRepository`; the test fixtures come
 * from the V0.1 pattern in `tests/host/repository.spec.ts` (a fresh index per
 * test via `mkdtemp` + `openIndex`), so a divergence here means the port and
 * the schema disagree, not that the test happens to use a different seed.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SCHEMA_VERSION } from '../../../src/host/domain/types.ts'
import type {
  RecoveryFileOperation,
  RecoveryJournalEntry,
  RecoveryPlan,
} from '../../../src/host/recovery/types.ts'
import type { SafetyVerdict } from '../../../src/host/domain/types.ts'
import { createRepository, type TraceRepository } from '../../../src/host/storage/repository.ts'
import { openIndex } from '../../../src/host/storage/sqlite-index.ts'

const SAFE_VERDICT: SafetyVerdict = {
  schemaVersion: SCHEMA_VERSION,
  id: 'ev-1',
  turnId: 's-1:turn:0',
  level: 'SAFE',
  reasons: [],
  allowedActions: ['PREVIEW_REWIND', 'REWIND'],
  recommendedAction: 'REWIND',
  evaluatedAt: 1_700_000_000_000,
  engineVersion: 1,
  currentStateHash: 'sha256:' + 'a'.repeat(64),
}

const samplePlan = (patch: Partial<RecoveryPlan> = {}): RecoveryPlan => ({
  schemaVersion: SCHEMA_VERSION,
  id: patch.id ?? 's-1:turn:0:plan:ev-1',
  turnId: patch.turnId ?? 's-1:turn:0',
  verdict: patch.verdict ?? SAFE_VERDICT,
  evaluationId: patch.evaluationId ?? 'ev-1',
  stateHash: patch.stateHash ?? 'sha256:' + 'a'.repeat(64),
  operations: patch.operations ?? [],
  beforeCheckpointId: patch.beforeCheckpointId ?? 'cp-pre',
  status: patch.status ?? 'planned',
  createdAt: patch.createdAt ?? 1_700_000_000_000,
  expiresAt: patch.expiresAt ?? 1_700_000_060_000,
})

const journalEntry = (
  plan: RecoveryPlan,
  seq: number,
  state: RecoveryJournalEntry['state'],
  op: RecoveryFileOperation = { kind: 'noop', path: 'a.ts', reason: 'unchanged' },
): RecoveryJournalEntry => ({
  schemaVersion: SCHEMA_VERSION,
  planId: plan.id,
  seq,
  operation: op,
  state,
  occurredAt: 1_700_000_000_000 + seq,
  ...(state === 'failed' ? { error: { code: 'RECOVERY_APPLY_FAILED', message: 'boom' } } : {}),
})

describe('TraceRepository — V0.2 recovery CRUD', () => {
  let root: string
  let repo: TraceRepository

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'turnscope-repo-rec-'))
    const handle = await openIndex(join(root, 'index.sqlite3'))
    repo = createRepository(handle)
  })
  afterEach(async () => {
    await repo.close()
    await rm(root, { recursive: true, force: true })
  })

  it('round-trips a plan with a populated operations array', async () => {
    const ops: readonly RecoveryFileOperation[] = [
      { kind: 'restore', path: 'src/a.ts', expectedCurrentHash: 'sha256:' + 'h'.repeat(64), targetBlobRef: 'sha256:' + 'b'.repeat(64) },
      { kind: 'delete_created_file', path: 'tmp/junk.txt', expectedCurrentHash: 'sha256:' + 'j'.repeat(64) },
      { kind: 'recreate_deleted_file', path: 'old.txt', targetBlobRef: 'sha256:' + 'o'.repeat(64) },
      { kind: 'noop', path: 'README.md', reason: 'baseline_only' },
    ]
    const plan = samplePlan({ operations: ops, stateHash: 'sha256:' + 'x'.repeat(64) })
    await repo.putRecoveryPlan(plan)

    const got = await repo.getRecoveryPlan(plan.id)
    expect(got).toBeDefined()
    expect(got!.id).toBe(plan.id)
    expect(got!.status).toBe('planned')
    expect(got!.verdict.id).toBe(SAFE_VERDICT.id)
    expect(got!.operations).toEqual(ops)
  })

  it('overwrites a plan when re-inserted with the same id (re-preview)', async () => {
    const plan = samplePlan({ status: 'planned' })
    await repo.putRecoveryPlan(plan)
    await repo.putRecoveryPlan({ ...plan, status: 'previewed', stateHash: 'sha256:' + 'n'.repeat(64) })

    const got = await repo.getRecoveryPlan(plan.id)
    expect(got!.status).toBe('previewed')
    expect(got!.stateHash).toBe('sha256:' + 'n'.repeat(64))
  })

  it('lists plans for a turn in created_at DESC order', async () => {
    const a = samplePlan({ id: 'p-1', createdAt: 1_000, evaluationId: 'a' })
    const b = samplePlan({ id: 'p-2', createdAt: 2_000, evaluationId: 'b' })
    const c = samplePlan({ id: 'p-3', createdAt: 3_000, evaluationId: 'c' })
    await repo.putRecoveryPlan(a)
    await repo.putRecoveryPlan(b)
    await repo.putRecoveryPlan(c)

    const got = await repo.listRecoveryPlans(a.turnId)
    expect(got.map(p => p.id)).toEqual(['p-3', 'p-2', 'p-1'])
  })

  it('updateRecoveryPlanStatus flips the status field', async () => {
    await repo.putRecoveryPlan(samplePlan({ status: 'planned' }))
    await repo.updateRecoveryPlanStatus('s-1:turn:0:plan:ev-1', 'previewed')
    const got = await repo.getRecoveryPlan('s-1:turn:0:plan:ev-1')
    expect(got!.status).toBe('previewed')
  })

  it('listRecoveryJournal returns entries in seq ASC order, multiple states per seq', async () => {
    const plan = samplePlan()
    await repo.putRecoveryPlan(plan)
    await repo.putRecoveryJournalEntry(journalEntry(plan, 1, 'applied', {
      kind: 'restore',
      path: 'src/a.ts',
      expectedCurrentHash: 'sha256:' + 'h'.repeat(64),
      targetBlobRef: 'sha256:' + 'b'.repeat(64),
    }))
    await repo.putRecoveryJournalEntry(journalEntry(plan, 1, 'verified'))
    await repo.putRecoveryJournalEntry(journalEntry(plan, 2, 'applied'))
    await repo.putRecoveryJournalEntry(journalEntry(plan, 2, 'verified'))

    const got = await repo.listRecoveryJournal(plan.id)
    // Four entries: seq 1 (applied, verified), seq 2 (applied, verified), in
    // the order the runner would write them.
    expect(got).toHaveLength(4)
    expect(got.map(e => `${e.seq}:${e.state}`)).toEqual([
      '1:applied',
      '1:verified',
      '2:applied',
      '2:verified',
    ])
  })

  it('listRecoveryJournal is idempotent on (plan_id, seq, state)', async () => {
    const plan = samplePlan()
    await repo.putRecoveryPlan(plan)
    await repo.putRecoveryJournalEntry(journalEntry(plan, 1, 'applied'))
    await repo.putRecoveryJournalEntry(journalEntry(plan, 1, 'applied'))
    const got = await repo.listRecoveryJournal(plan.id)
    expect(got).toHaveLength(1)
  })

  it('listUnfinishedRecoveryPlans returns previewed-past-expiry and applying plans', async () => {
    const past = samplePlan({ id: 'p-past', status: 'previewed', createdAt: 1_000, expiresAt: 2_000 })
    const applying = samplePlan({ id: 'p-applying', status: 'applying', createdAt: 3_000, expiresAt: 9_000 })
    const livePreview = samplePlan({ id: 'p-live', status: 'previewed', createdAt: 4_000, expiresAt: 9_000 })
    const completed = samplePlan({ id: 'p-done', status: 'completed', createdAt: 5_000, expiresAt: 9_000 })
    const failed = samplePlan({ id: 'p-fail', status: 'failed', createdAt: 6_000, expiresAt: 9_000 })
    for (const p of [past, applying, livePreview, completed, failed]) {
      await repo.putRecoveryPlan(p)
    }

    const now = 5_000
    const got = await repo.listUnfinishedRecoveryPlans(now)
    const ids = got.map(p => p.id).sort()
    expect(ids).toEqual(['p-applying', 'p-past'].sort())
  })
})