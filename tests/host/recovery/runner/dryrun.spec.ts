/**
 * Tests for the V0.2 dry-run
 * (`src/host/recovery/runner/dryrun.ts`).
 *
 * The dry-run is a *truthful preview*: every result it returns is one the
 * apply path will see, except for the actual rename. If a case here returns
 * "ok" but the apply would refuse, the user will hit `RECOVERY_STALE` in
 * production — exactly the outcome this layer is supposed to prevent. Each
 * test therefore pins a specific aspect of that alignment.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { cleanupDryRun, runDryRun } from '../../../../src/host/recovery/runner/dryrun.ts'
import { planRecovery, type PlannerPathSnapshot } from '../../../../src/host/recovery/planner.ts'
import type { FileChange, SafetyVerdict } from '../../../../src/host/domain/types.ts'
import type { ObjectRef, ObjectStore } from '../../../../src/host/storage/object-store.ts'

const NOW = 1_700_000_000_000
const enc = new TextEncoder()

function makeVerdict(): SafetyVerdict {
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
  }
}

function makeChange(p: Partial<FileChange>): FileChange {
  return {
    schemaVersion: 3 as const,
    id: p.path ?? 'p',
    turnId: 't1',
    path: 'p',
    kind: 'modified',
    attribution: 'AGENT',
    confidence: 'high',
    baseline: false,
    evidenceRefs: [],
    ...p,
  } as FileChange
}

/**
 * Build an in-memory ObjectStore that knows a handful of blobs by their
 * sha256-derived name. The dry-run only reads `get` and never calls
 * `put` / `has` / `list`, so the rest can stay undefined; the test passes
 * `as unknown as ObjectStore` to make that explicit.
 */
function makeStubStore(blobs: Record<string, Uint8Array>): ObjectStore {
  const store: ObjectStore = {
    async put() {
      throw new Error('put not used in dry-run tests')
    },
    async get(ref) {
      return blobs[ref] ?? Promise.reject(new Error(`missing blob ${ref}`))
    },
    async has() {
      return true
    },
    async stat(ref): Promise<ObjectRef | undefined> {
      const bytes = blobs[ref]
      if (bytes === undefined) return undefined
      const sha256 = ref.startsWith('sha256:') ? ref.slice(7) : ref
      return { ref: `sha256:${sha256}`, sha256, byteSize: bytes.byteLength }
    },
    async listRefs() {
      return Object.keys(blobs)
    },
  }
  return store
}

describe('runDryRun', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ts-recovery-dryrun-'))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('stages the before bytes for a restore op under the dry-run root', async () => {
    const before = enc.encode('hello world\n')
    const after = enc.encode('HELLO world\n')
    const beforeRef = 'sha256:' + 'a'.repeat(64)
    const afterRef = 'sha256:' + 'b'.repeat(64)
    const store = makeStubStore({ [beforeRef]: before, [afterRef]: after })

    const snap: PlannerPathSnapshot = {
      path: 'greeting.txt',
      staged: false,
      currentContentHash: 'cur',
      beforeBlobRef: beforeRef,
      afterBlobRef: afterRef,
      existedBefore: true,
      existsNow: true,
    }
    const plan = planRecovery({
      turnId: 't1',
      evaluationId: 'e1',
      verdict: makeVerdict(),
      workspaceId: 'w1',
      git: { headOid: 'h', branch: 'main', worktreePath: '/wt' },
      paths: [snap],
      fileChanges: [makeChange({ path: 'greeting.txt', kind: 'modified', attribution: 'AGENT' })],
      checkpointPathStates: [],
      beforeCheckpointId: 'cp_pre',
      nowMs: NOW,
    })

    const live = {
      async readCurrent(): Promise<Uint8Array> {
        return after
      },
    }
    const out = runDryRun(plan, store, live, tmp)
    void out
    const { ops, stagingRoot } = await out
    expect(stagingRoot.startsWith(tmp)).toBe(true)
    expect(ops[0]?.kind).toBe('ok')
    const written = await readFile(join(stagingRoot, 'greeting.txt'))
    expect(new TextDecoder().decode(written)).toBe('hello world\n')
  })

  it('reports conflict on context-mismatch when the worktree has drifted', async () => {
    const before = enc.encode('a\nb\nc\n')
    const after = enc.encode('a\nB\nc\n')
    const beforeRef = 'sha256:' + 'a'.repeat(64)
    const afterRef = 'sha256:' + 'b'.repeat(64)
    const store = makeStubStore({ [beforeRef]: before, [afterRef]: after })

    const drifted = enc.encode('a\nX\nc\n')
    const snap: PlannerPathSnapshot = {
      path: 'f.txt',
      staged: false,
      currentContentHash: 'cur',
      beforeBlobRef: beforeRef,
      afterBlobRef: afterRef,
      existedBefore: true,
      existsNow: true,
    }
    const plan = planRecovery({
      turnId: 't1',
      evaluationId: 'e1',
      verdict: makeVerdict(),
      workspaceId: 'w1',
      git: { headOid: 'h', branch: 'main', worktreePath: '/wt' },
      paths: [snap],
      fileChanges: [makeChange({ path: 'f.txt', kind: 'modified', attribution: 'AGENT' })],
      checkpointPathStates: [],
      beforeCheckpointId: 'cp_pre',
      nowMs: NOW,
    })

    const live = {
      async readCurrent(): Promise<Uint8Array> {
        return drifted
      },
    }
    const { ops } = await runDryRun(plan, store, live, tmp)
    expect(ops[0]?.kind).toBe('conflict')
    if (ops[0]?.kind === 'conflict') {
      expect(ops[0].reason).toBe('context-mismatch')
    }
  })

  it('noop paths are reported with their reason, not as ok', async () => {
    const snap: PlannerPathSnapshot = {
      path: 'baseline.txt',
      staged: false,
      currentContentHash: 'b',
      beforeBlobRef: 'sha256:' + 'c'.repeat(64),
      afterBlobRef: 'sha256:' + 'd'.repeat(64),
      existedBefore: true,
      existsNow: true,
    }
    const store = makeStubStore({})
    const plan = planRecovery({
      turnId: 't1',
      evaluationId: 'e1',
      verdict: makeVerdict(),
      workspaceId: 'w1',
      git: { headOid: 'h', branch: 'main', worktreePath: '/wt' },
      paths: [snap],
      fileChanges: [makeChange({ path: 'baseline.txt', attribution: 'BASELINE' })],
      checkpointPathStates: [],
      beforeCheckpointId: 'cp_pre',
      nowMs: NOW,
    })

    const live = { async readCurrent(): Promise<Uint8Array | null> { return null } }
    const { ops } = await runDryRun(plan, store, live, tmp)
    expect(ops[0]?.kind).toBe('noop')
    if (ops[0]?.kind === 'noop') {
      expect(ops[0].reason).toBe('baseline_only')
    }
  })

  it('delete_created_file ops do not stage any bytes (the apply will unlink)', async () => {
    const snap: PlannerPathSnapshot = {
      path: 'new.txt',
      staged: false,
      currentContentHash: 'cur',
      beforeBlobRef: undefined,
      afterBlobRef: undefined,
      existedBefore: false,
      existsNow: true,
    }
    const store = makeStubStore({})
    const plan = planRecovery({
      turnId: 't1',
      evaluationId: 'e1',
      verdict: makeVerdict(),
      workspaceId: 'w1',
      git: { headOid: 'h', branch: 'main', worktreePath: '/wt' },
      paths: [snap],
      fileChanges: [makeChange({ path: 'new.txt', kind: 'created', attribution: 'AGENT' })],
      checkpointPathStates: [],
      beforeCheckpointId: 'cp_pre',
      nowMs: NOW,
    })
    const live = { async readCurrent(): Promise<Uint8Array | null> { return null } }
    const { ops, stagingRoot } = await runDryRun(plan, store, live, tmp)
    expect(ops[0]?.kind).toBe('ok')
    // No bytes written under the staging root.
    expect((await import('node:fs/promises')).stat).toBeTypeOf('function')
    await expect(
      readFile(join(stagingRoot, 'new.txt')).then(
        () => Promise.reject(new Error('should not exist')),
        () => undefined,
      ),
    ).resolves.toBeUndefined()
  })

  it('cleanupDryRun removes the staging directory', async () => {
    const before = enc.encode('x\n')
    const beforeRef = 'sha256:' + 'e'.repeat(64)
    const afterRef = 'sha256:' + 'f'.repeat(64)
    const store = makeStubStore({ [beforeRef]: before, [afterRef]: before })
    const snap: PlannerPathSnapshot = {
      path: 'same.txt',
      staged: false,
      currentContentHash: 'c',
      beforeBlobRef: beforeRef,
      afterBlobRef: afterRef,
      existedBefore: true,
      existsNow: true,
    }
    const plan = planRecovery({
      turnId: 't1',
      evaluationId: 'e1',
      verdict: makeVerdict(),
      workspaceId: 'w1',
      git: { headOid: 'h', branch: 'main', worktreePath: '/wt' },
      paths: [snap],
      fileChanges: [makeChange({ path: 'same.txt', kind: 'modified', attribution: 'AGENT' })],
      checkpointPathStates: [],
      beforeCheckpointId: 'cp_pre',
      nowMs: NOW,
    })
    const live = { async readCurrent(): Promise<Uint8Array> { return before } }
    const { stagingRoot } = await runDryRun(plan, store, live, tmp)
    await cleanupDryRun(stagingRoot)
    await expect(
      readFile(join(stagingRoot, 'same.txt')).then(
        () => Promise.reject(new Error('should be cleaned')),
        () => undefined,
      ),
    ).resolves.toBeUndefined()
  })
})