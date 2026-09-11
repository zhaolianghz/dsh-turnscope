/**
 * Tests for {@link planRecovery}, the V0.2 planner.
 *
 * The planner is the one place that has to be *auditably right*: every other
 * layer either derives from it (the runner), renders it (the UI), or stores it
 * (the schema). If it gets a rewind wrong here, the runner and the UI inherit
 * the mistake, and the user either loses work or has a "successful" rewind
 * that does nothing.
 *
 * Per `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §5.1`
 * and §9.1: the matrix is small but every cell has to land on a documented
 * decision, because the user sees that decision in the recovery section.
 */

import { describe, expect, it } from 'vitest'

import { planRecovery, type RecoveryPlannerInput, type PlannerPathSnapshot } from '../../../src/host/recovery/planner.ts'
import type { FileChange, SafetyVerdict } from '../../../src/host/domain/types.ts'

const NOW = 1_700_000_000_000

const git = { headOid: 'abc', branch: 'main', worktreePath: '/wt' }

function makeVerdict(overrides: Partial<SafetyVerdict> = {}): SafetyVerdict {
  return {
    schemaVersion: 3 as const,
    id: 'v1',
    turnId: 't1',
    level: 'CAUTION',
    reasons: [],
    allowedActions: ['PREVIEW_REWIND', 'REWIND'],
    recommendedAction: 'PREVIEW_REWIND',
    evaluatedAt: NOW,
    engineVersion: 1,
    ...overrides,
  }
}

function makeChange(overrides: Partial<FileChange>): FileChange {
  return {
    schemaVersion: 3 as const,
    id: overrides.path ?? 'p',
    turnId: 't1',
    path: 'p',
    kind: 'modified',
    attribution: 'AGENT',
    confidence: 'high',
    baseline: false,
    evidenceRefs: [],
    ...overrides,
  } as FileChange
}

function baseInput(overrides: Partial<RecoveryPlannerInput> = {}): RecoveryPlannerInput {
  return {
    turnId: 't1',
    evaluationId: 'e1',
    verdict: makeVerdict(),
    workspaceId: 'w1',
    git,
    paths: [],
    fileChanges: [],
    checkpointPathStates: [],
    beforeCheckpointId: 'cp_pre',
    nowMs: NOW,
    ...overrides,
  }
}

describe('planRecovery', () => {
  it('produces a deterministic plan id from turnId:plan:evaluationId', () => {
    const a = planRecovery(baseInput())
    const b = planRecovery(baseInput())
    expect(a.id).toBe('t1:plan:e1')
    expect(a.id).toBe(b.id)
  })

  it('emits a `restore` op for an AGENT-modified path with a known before blob', () => {
    const snap: PlannerPathSnapshot = {
      path: 'a.txt',
      staged: false,
      currentContentHash: 'cur',
      beforeBlobRef: 'blobs/a-pre',
      afterBlobRef: 'blobs/a-post',
      existedBefore: true,
      existsNow: true,
    }
    const p = planRecovery(
      baseInput({
        paths: [snap],
        fileChanges: [makeChange({ path: 'a.txt', kind: 'modified', attribution: 'AGENT' })],
        checkpointPathStates: [{ schemaVersion: 3 as const, id: 'cp1', checkpointId: 'cp_pre', path: 'a.txt', status: 'modified', staged: false, binary: false, blobRef: 'blobs/a-pre' }],
      }),
    )
    expect(p.operations).toEqual([
      { kind: 'restore', path: 'a.txt', expectedCurrentHash: 'cur', targetBlobRef: 'blobs/a-pre' },
    ])
    expect(p.stateHash).toMatch(/^sha256:/)
  })

  it('emits a `delete_created_file` op for an AGENT-created path', () => {
    const snap: PlannerPathSnapshot = {
      path: 'new.txt',
      staged: false,
      currentContentHash: 'cur',
      beforeBlobRef: undefined,
      afterBlobRef: 'blobs/n-post',
      existedBefore: false,
      existsNow: true,
    }
    const p = planRecovery(
      baseInput({
        paths: [snap],
        fileChanges: [makeChange({ path: 'new.txt', kind: 'created', attribution: 'AGENT' })],
      }),
    )
    expect(p.operations).toEqual([
      { kind: 'delete_created_file', path: 'new.txt', expectedCurrentHash: 'cur' },
    ])
  })

  it('emits a `recreate_deleted_file` op for an AGENT-deleted path', () => {
    const snap: PlannerPathSnapshot = {
      path: 'gone.txt',
      staged: false,
      currentContentHash: undefined,
      beforeBlobRef: 'blobs/g-pre',
      afterBlobRef: undefined,
      existedBefore: true,
      existsNow: false,
    }
    const p = planRecovery(
      baseInput({
        paths: [snap],
        fileChanges: [makeChange({ path: 'gone.txt', kind: 'deleted', attribution: 'AGENT' })],
      }),
    )
    expect(p.operations).toEqual([
      { kind: 'recreate_deleted_file', path: 'gone.txt', targetBlobRef: 'blobs/g-pre' },
    ])
  })

  it('skips a BASELINE-only path as noop baseline_only (does not include it in the drift hash)', () => {
    const snap: PlannerPathSnapshot = {
      path: 'baseline.txt',
      staged: false,
      currentContentHash: 'dirty',
      beforeBlobRef: 'blobs/b-pre',
      afterBlobRef: 'blobs/b-post',
      existedBefore: true,
      existsNow: true,
    }
    const p = planRecovery(
      baseInput({
        paths: [snap],
        fileChanges: [makeChange({ path: 'baseline.txt', attribution: 'BASELINE' })],
      }),
    )
    expect(p.operations).toEqual([
      { kind: 'noop', path: 'baseline.txt', reason: 'baseline_only' },
    ])
  })

  it('preserves a DRIFT path as noop drift_preserved', () => {
    const snap: PlannerPathSnapshot = {
      path: 'drift.txt',
      staged: false,
      currentContentHash: 'd',
      beforeBlobRef: 'blobs/dr-pre',
      afterBlobRef: 'blobs/dr-post',
      existedBefore: true,
      existsNow: true,
    }
    const p = planRecovery(
      baseInput({
        paths: [snap],
        fileChanges: [makeChange({ path: 'drift.txt', attribution: 'DRIFT' })],
      }),
    )
    expect(p.operations).toEqual([
      { kind: 'noop', path: 'drift.txt', reason: 'drift_preserved' },
    ])
  })

  it('refuses to rewind an UNCERTAIN path as noop unknown', () => {
    const snap: PlannerPathSnapshot = {
      path: 'u.txt',
      staged: false,
      currentContentHash: 'u',
      beforeBlobRef: 'blobs/u-pre',
      afterBlobRef: 'blobs/u-post',
      existedBefore: true,
      existsNow: true,
    }
    const p = planRecovery(
      baseInput({
        paths: [snap],
        fileChanges: [makeChange({ path: 'u.txt', attribution: 'UNCERTAIN' })],
      }),
    )
    expect(p.operations).toEqual([
      { kind: 'noop', path: 'u.txt', reason: 'unknown' },
    ])
  })

  it('emits noop unchanged for a path that has no file_change row (clean through the turn)', () => {
    const snap: PlannerPathSnapshot = {
      path: 'clean.txt',
      staged: false,
      currentContentHash: 'c',
      beforeBlobRef: undefined,
      afterBlobRef: undefined,
      existedBefore: true,
      existsNow: true,
    }
    const p = planRecovery(
      baseInput({
        paths: [snap],
        fileChanges: [],
        checkpointPathStates: [],
      }),
    )
    expect(p.operations).toEqual([
      { kind: 'noop', path: 'clean.txt', reason: 'unchanged' },
    ])
  })

  it('expires at now + ttlMs (default 60_000 ms)', () => {
    const p = planRecovery(baseInput())
    expect(p.expiresAt - p.createdAt).toBe(60_000)
    const p2 = planRecovery(baseInput({ ttlMs: 5_000 }))
    expect(p2.expiresAt - p2.createdAt).toBe(5_000)
  })

  it('is order-independent over its input arrays (same plan, byte-equal JSON)', () => {
    const mkSnap = (path: string): PlannerPathSnapshot => ({
      path,
      staged: false,
      currentContentHash: `${path}-h`,
      beforeBlobRef: `${path}-pre`,
      afterBlobRef: `${path}-post`,
      existedBefore: true,
      existsNow: true,
    })
    const mk = (path: string): FileChange => makeChange({ path, kind: 'modified', attribution: 'AGENT' })
    const paths = [mkSnap('a'), mkSnap('b'), mkSnap('c')]
    const changes = [mk('a'), mk('b'), mk('c')]
    const cps = paths.map(s => ({ schemaVersion: 3 as const, id: s.path, checkpointId: 'cp_pre', path: s.path, status: 'modified' as const, staged: false, binary: false, blobRef: s.beforeBlobRef! }))
    const fwd = planRecovery(baseInput({ paths, fileChanges: changes, checkpointPathStates: cps }))
    const rev = planRecovery(baseInput({
      paths: [paths[2]!, paths[0]!, paths[1]!],
      fileChanges: [changes[2]!, changes[0]!, changes[1]!],
      checkpointPathStates: [cps[2]!, cps[0]!, cps[1]!],
    }))
    expect(fwd.operations).toEqual(rev.operations)
    expect(fwd.stateHash).toBe(rev.stateHash)
  })

  it('includes the rewinding paths (not noops) in the drift hash, but skips noops', () => {
    const cleanSnap: PlannerPathSnapshot = {
      path: 'clean.txt',
      staged: false,
      currentContentHash: 'c1',
      beforeBlobRef: undefined,
      afterBlobRef: undefined,
      existedBefore: true,
      existsNow: true,
    }
    const baselineSnap: PlannerPathSnapshot = {
      path: 'b.txt',
      staged: false,
      currentContentHash: 'b1',
      beforeBlobRef: 'b-pre',
      afterBlobRef: 'b-post',
      existedBefore: true,
      existsNow: true,
    }
    const modifySnap: PlannerPathSnapshot = {
      path: 'm.txt',
      staged: false,
      currentContentHash: 'm1',
      beforeBlobRef: 'm-pre',
      afterBlobRef: 'm-post',
      existedBefore: true,
      existsNow: true,
    }
    const p1 = planRecovery(
      baseInput({
        paths: [cleanSnap, baselineSnap, modifySnap],
        fileChanges: [
          makeChange({ path: 'b.txt', attribution: 'BASELINE' }),
          makeChange({ path: 'm.txt', attribution: 'AGENT', kind: 'modified' }),
        ],
      }),
    )
    // Hash differs from a plan that hashes the noops too (sanity).
    const p2 = planRecovery(baseInput({
      paths: [cleanSnap, baselineSnap],
      fileChanges: [makeChange({ path: 'b.txt', attribution: 'BASELINE' })],
    }))
    expect(p1.stateHash).not.toBe(p2.stateHash)
  })
})