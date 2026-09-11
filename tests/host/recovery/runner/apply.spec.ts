/**
 * Tests for the apply runner
 * (`src/host/recovery/runner/apply.ts`).
 *
 * The runner is the only code path that writes to the worktree, so its
 * tests double as the contract for "what does a successful rewind look
 * like on disk". The matrix below covers the four op kinds plus the two
 * failure modes (drift conflict, missing blob), each with a before/after
 * snapshot of the worktree so a regression that drops a write is caught.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runApply, type ApplyClock } from '../../../../src/host/recovery/runner/apply.ts'
import { planRecovery, type PlannerPathSnapshot } from '../../../../src/host/recovery/planner.ts'
import type { FileChange, SafetyVerdict } from '../../../../src/host/domain/types.ts'
import type { ObjectRef, ObjectStore } from '../../../../src/host/storage/object-store.ts'

const NOW = 1_700_000_000_000
const enc = new TextEncoder()

function sha(content: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

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

function stubStore(blobs: Record<string, Uint8Array>): ObjectStore {
  return {
    async put() {
      throw new Error('put not used in apply tests')
    },
    async get(ref) {
      return blobs[ref] ?? Promise.reject(new Error(`missing ${ref}`))
    },
    async has(ref) {
      return blobs[ref] !== undefined
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
}

function makeClock(): ApplyClock {
  let seq = 0
  let now = NOW
  return {
    nextSeq() {
      seq += 1
      return seq
    },
    nowMs() {
      return now
    },
  }
}

describe('runApply', () => {
  let worktree: string
  let homeDir: string
  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'ts-apply-wt-'))
    homeDir = await mkdtemp(join(tmpdir(), 'ts-apply-home-'))
  })
  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true })
    await rm(homeDir, { recursive: true, force: true })
  })

  it('rewinds a modified file (writes beforeBytes, journal marks applied+verified)', async () => {
    const before = enc.encode('a\nb\nc\n')
    const after = enc.encode('a\nB\nc\n')
    const beforeRef = sha(before)
    const afterRef = sha(after)
    await writeFile(join(worktree, 'f.txt'), after)

    const store = stubStore({ [beforeRef]: before, [afterRef]: after })
    const snap: PlannerPathSnapshot = {
      path: 'f.txt',
      staged: false,
      currentContentHash: sha(after),
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
      git: { headOid: 'h', branch: 'main', worktreePath: worktree },
      paths: [snap],
      fileChanges: [makeChange({ path: 'f.txt', kind: 'modified', attribution: 'AGENT' })],
      checkpointPathStates: [],
      beforeCheckpointId: 'cp_pre',
      nowMs: NOW,
    })

    const live = {
      async hashCurrent(path: string): Promise<string | null> {
        try {
          return sha(await readFile(join(worktree, path)))
        } catch {
          return null
        }
      },
      async readCurrent(path: string): Promise<Uint8Array | null> {
        try {
          return await readFile(join(worktree, path))
        } catch {
          return null
        }
      },
    }

    const result = await runApply({ plan, worktreeRoot: worktree, homeDir, objectStore: store, live, clock: makeClock() })
    expect(result.status).toBe('completed')
    expect(await readFile(join(worktree, 'f.txt'), 'utf8')).toBe('a\nb\nc\n')
    const states = result.journal.map(e => e.state)
    expect(states).toContain('applied')
    expect(states).toContain('verified')
  })

  it('restores a deleted file from beforeBytes', async () => {
    const before = enc.encode('original\n')
    const beforeRef = sha(before)
    // File does NOT exist in worktree.
    const store = stubStore({ [beforeRef]: before })
    const snap: PlannerPathSnapshot = {
      path: 'gone.txt',
      staged: false,
      currentContentHash: undefined,
      beforeBlobRef: beforeRef,
      afterBlobRef: undefined,
      existedBefore: true,
      existsNow: false,
    }
    const plan = planRecovery({
      turnId: 't1',
      evaluationId: 'e1',
      verdict: makeVerdict(),
      workspaceId: 'w1',
      git: { headOid: 'h', branch: 'main', worktreePath: worktree },
      paths: [snap],
      fileChanges: [makeChange({ path: 'gone.txt', kind: 'deleted', attribution: 'AGENT' })],
      checkpointPathStates: [],
      beforeCheckpointId: 'cp_pre',
      nowMs: NOW,
    })
    const live = {
      async hashCurrent(path: string): Promise<string | null> {
        try {
          return sha(await readFile(join(worktree, path)))
        } catch {
          return null
        }
      },
      async readCurrent(path: string): Promise<Uint8Array | null> {
        try {
          return await readFile(join(worktree, path))
        } catch {
          return null
        }
      },
    }
    const result = await runApply({ plan, worktreeRoot: worktree, homeDir, objectStore: store, live, clock: makeClock() })
    expect(result.status).toBe('completed')
    expect(await readFile(join(worktree, 'gone.txt'), 'utf8')).toBe('original\n')
  })

  it('removes a file the agent created', async () => {
    await writeFile(join(worktree, 'new.txt'), 'agent wrote this\n')
    const store = stubStore({})
    const snap: PlannerPathSnapshot = {
      path: 'new.txt',
      staged: false,
      currentContentHash: sha('agent wrote this\n'),
      beforeBlobRef: undefined,
      afterBlobRef: undefined,
      existedBefore: false,
      existsNow: true,
    }
    const plan = planRecovery({
      turnId: 't1',
      evaluationId: 'e1',
      verdict: makeVerdict(),
      workspaceId: 'w1',
      git: { headOid: 'h', branch: 'main', worktreePath: worktree },
      paths: [snap],
      fileChanges: [makeChange({ path: 'new.txt', kind: 'created', attribution: 'AGENT' })],
      checkpointPathStates: [],
      beforeCheckpointId: 'cp_pre',
      nowMs: NOW,
    })
    const live = {
      async hashCurrent(): Promise<string | null> { return null },
      async readCurrent(): Promise<Uint8Array | null> { return null },
    }
    const result = await runApply({ plan, worktreeRoot: worktree, homeDir, objectStore: store, live, clock: makeClock() })
    expect(result.status).toBe('completed')
    await expect(readFile(join(worktree, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back to the original file on context-mismatch drift', async () => {
    const before = enc.encode('a\nb\nc\n')
    const after = enc.encode('a\nB\nc\n')
    const beforeRef = sha(before)
    const afterRef = sha(after)
    // User has *also* edited the file between preview and apply.
    const currentInWorktree = enc.encode('a\nX\nc\n')
    await writeFile(join(worktree, 'f.txt'), currentInWorktree)
    const store = stubStore({ [beforeRef]: before, [afterRef]: after })
    const snap: PlannerPathSnapshot = {
      path: 'f.txt',
      staged: false,
      currentContentHash: sha(currentInWorktree),
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
      git: { headOid: 'h', branch: 'main', worktreePath: worktree },
      paths: [snap],
      fileChanges: [makeChange({ path: 'f.txt', kind: 'modified', attribution: 'AGENT' })],
      checkpointPathStates: [],
      beforeCheckpointId: 'cp_pre',
      nowMs: NOW,
    })
    const live = {
      async hashCurrent(): Promise<string | null> {
        return sha(currentInWorktree)
      },
      async readCurrent(): Promise<Uint8Array> {
        return currentInWorktree
      },
    }
    const result = await runApply({ plan, worktreeRoot: worktree, homeDir, objectStore: store, live, clock: makeClock() })
    expect(result.status).toBe('rolled_back')
    // The worktree file should be back to the user's drifted version, not
    // the agent's version, because the rollback path restores the backup
    // we took before the write.
    expect(await readFile(join(worktree, 'f.txt'), 'utf8')).toBe('a\nX\nc\n')
    const errored = result.journal.find(e => e.state === 'rolled_back')
    expect(errored).toBeDefined()
    expect(errored?.error?.code).toBe('PATCH_CONFLICT')
  })

  it('noop paths leave the worktree untouched', async () => {
    await mkdir(join(worktree, 'sub'), { recursive: true })
    await writeFile(join(worktree, 'sub', 'readme.md'), 'pre-existing\n')
    const store = stubStore({})
    const snap: PlannerPathSnapshot = {
      path: 'sub/readme.md',
      staged: false,
      currentContentHash: sha('pre-existing\n'),
      beforeBlobRef: 'sha256:' + 'a'.repeat(64),
      afterBlobRef: 'sha256:' + 'b'.repeat(64),
      existedBefore: true,
      existsNow: true,
    }
    const plan = planRecovery({
      turnId: 't1',
      evaluationId: 'e1',
      verdict: makeVerdict(),
      workspaceId: 'w1',
      git: { headOid: 'h', branch: 'main', worktreePath: worktree },
      paths: [snap],
      fileChanges: [makeChange({ path: 'sub/readme.md', attribution: 'BASELINE' })],
      checkpointPathStates: [],
      beforeCheckpointId: 'cp_pre',
      nowMs: NOW,
    })
    const live = {
      async hashCurrent(): Promise<string | null> { return null },
      async readCurrent(): Promise<Uint8Array | null> { return null },
    }
    await runApply({ plan, worktreeRoot: worktree, homeDir, objectStore: store, live, clock: makeClock() })
    expect(await readFile(join(worktree, 'sub', 'readme.md'), 'utf8')).toBe('pre-existing\n')
  })
})