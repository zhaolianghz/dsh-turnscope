/**
 * Service-level integration tests for the V0.2 Safe Rewind pipeline.
 *
 * The runner has unit tests (`runner/{apply,dryrun,journal,rollback}.
 * spec.ts`); the planner too. What this file pins down is the glue:
 * Preview persists a plan; Apply reads the plan back, runs the runner,
 * and updates the plan's status; `listUnfinished` returns the plan
 * while it is still in flight and stops once a terminal status lands;
 * a Preview past its TTL refuses to apply and never writes the worktree.
 *
 * The sink is a hand-rolled fake (the `TraceRepository` interface is
 * large enough that a fake is shorter than a real one), and the
 * worktree reader is a `Map` over an in-memory filesystem. That is
 * enough to prove the contracts the architecture guard relies on: the
 * service asks for one plan, hands it to the runner, and writes the
 * result back. The unit tests cover the inside of the runner.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { SCHEMA_VERSION } from '../../../src/host/domain/types.ts'
import type {
  CheckpointPathState,
  CheckpointRecord,
  FileChange,
  SafetyVerdict,
  TurnRecord,
  WorkspaceRecord,
} from '../../../src/host/domain/types.ts'
import type { TraceRepository } from '../../../src/host/storage/repository.ts'
import { createNodeWorktreeReader } from '../../../src/host/storage/worktree-reader.ts'
import { createRecoveryService, type RecoveryDeps, type WorktreeReader } from '../../../src/host/recovery/service.ts'
import type { ApplyClock } from '../../../src/host/recovery/runner/apply.ts'
import type { RecoveryPlan } from '../../../src/host/recovery/types.ts'

const NOW = 1_700_000_000_000
const TURNOUT = 'turnscope-workspace-1'
const TURN_ID = 'turn-1'

const enc = new TextEncoder()
const sha = (content: Uint8Array | string): string =>
  `sha256:${createHash('sha256').update(content).digest('hex')}`

/** Real on-disk worktree reader (the runner writes through node:fs anyway). */
const makeFiles = (workdir: string, initial: Record<string, string> = {}) => {
  const write = (path: string, contents: Buffer | string): void => {
    writeFileSync(join(workdir, path), contents)
  }
  const read = (path: string): string => readFileSync(join(workdir, path), 'utf8')
  return { write, read }
}

/** Fake `ApplyClock` whose `nowMs` advances on demand. */
const makeClock = (start: number): ApplyClock & { advance(ms: number): void } => {
  let now = start
  let seq = 0
  return {
    nowMs: () => now,
    nextSeq: () => { seq += 1; return seq },
    advance: (ms) => { now += ms },
  }
}

const buildTurnRecord = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id: TURN_ID,
  sessionId: 'session-1',
  workspaceId: TURNOUT,
  ordinal: 0,
  status: 'completed',
  startedAt: NOW - 1000,
  endedAt: NOW,
  activityCount: 1,
  errorCount: 0,
  evidenceCompleteness: 'complete',
  ...overrides,
})

const buildWorkspaceRecord = (repoRoot: string): WorkspaceRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id: TURNOUT,
  repoRoot,
  repoRootHash: 'h',
  settingsJson: '{}',
  createdAt: NOW - 5000,
})

/**
 * A minimal `TraceRepository`-shaped fake that the service's sink
 * surface (`Pick<TraceRepository, 11 methods>`) can read and write.
 */
const makeSink = (overrides: { plans?: Map<string, RecoveryPlan>; changes?: FileChange[]; checkpoints?: CheckpointRecord[]; checkpointPaths?: readonly CheckpointPathState[]; verdict?: SafetyVerdict; repoRoot?: string } = {}): TraceRepository => {
  const plans = overrides.plans ?? new Map<string, RecoveryPlan>()
  const turns = new Map<string, TurnRecord>([[TURN_ID, buildTurnRecord()]])
  const workspaces = new Map<string, WorkspaceRecord>([[TURNOUT, buildWorkspaceRecord(overrides.repoRoot ?? '/tmp/turnscope-svc-default-repo')]])
  const changes = overrides.changes ?? []
  const checkpoints = overrides.checkpoints ?? []
  const checkpointPaths = overrides.checkpointPaths ?? []
  const verdict = overrides.verdict

  const sink = {
    getTurn: async (turnId: string) => turns.get(turnId),
    getWorkspace: async (workspaceId: string) => workspaces.get(workspaceId),
    listFileChanges: async () => changes,
    listCheckpoints: async () => checkpoints,
    listCheckpointPaths: async () => checkpointPaths,
    getLatestVerdict: async () => verdict,
    getRecoveryPlan: async (id: string) => plans.get(id),
    putRecoveryPlan: async (plan: RecoveryPlan) => { plans.set(plan.id, plan) },
    updateRecoveryPlanStatus: async (id: string, status: RecoveryPlan['status'], opts?: { completedAt?: number }) => {
      const current = plans.get(id)
      if (current === undefined) return
      plans.set(id, { ...current, status, ...(opts?.completedAt !== undefined ? { completedAt: opts.completedAt } : {}) })
    },
    listRecoveryPlans: async () => Array.from(plans.values()),
    listUnfinishedRecoveryPlans: async () => Array.from(plans.values()).filter(p => p.status !== 'completed' && p.status !== 'failed' && p.status !== 'rolled_back' && p.status !== 'cancelled'),
  }
  return sink as unknown as TraceRepository
}

interface Harness {
  readonly service: ReturnType<typeof createRecoveryService>
  readonly files: ReturnType<typeof makeFiles>
  readonly clock: ApplyClock & { advance(ms: number): void }
}

const buildHarness = (opts: {
  repoRoot: string
  files: ReturnType<typeof makeFiles>
  clock: ApplyClock & { advance(ms: number): void }
  homeDir: string
  changes: FileChange[]
  checkpoints?: CheckpointRecord[]
  checkpointPaths?: readonly CheckpointPathState[]
  verdict: SafetyVerdict
  baselineBytes?: Buffer
}): Harness => {
  const baselineBytes = opts.baselineBytes ?? Buffer.from('export const x = 1\n', 'utf8')
  const fakeStore = {
    put: async () => 'unused',
    get: async (ref: string) => ref === 'before-ref' ? baselineBytes : null,
    stat: async (ref: string) => ref === 'before-ref' ? { kind: 'recovery-blob' as const, ref, bytes: baselineBytes.byteLength, sha256: sha(baselineBytes) } : undefined,
    has: async () => false,
    listRefs: async () => [],
  } as never
  const service = createRecoveryService({
    sink: makeSink({
      changes: opts.changes,
      ...(opts.checkpoints !== undefined ? { checkpoints: opts.checkpoints } : {}),
      ...(opts.checkpointPaths !== undefined ? { checkpointPaths: opts.checkpointPaths } : {}),
      verdict: opts.verdict,
      repoRoot: opts.repoRoot,
    }),
    worktree: createNodeWorktreeReader(),
    store: fakeStore,
    clock: opts.clock,
    homeDir: opts.homeDir,
  } satisfies RecoveryDeps)
  return { service, files: opts.files, clock: opts.clock }
}

const buildSafeVerdict = (): SafetyVerdict => ({
  schemaVersion: SCHEMA_VERSION,
  id: 'v1',
  turnId: TURN_ID,
  level: 'SAFE',
  reasons: [],
  allowedActions: ['PREVIEW_REWIND', 'REWIND'],
  recommendedAction: 'REWIND',
  evaluatedAt: NOW,
  engineVersion: 1,
})

const buildModifiedChange = (opts: { beforeBytes: Buffer; afterBytes: Buffer; baseline?: boolean }): FileChange => ({
  schemaVersion: SCHEMA_VERSION,
  id: 'c1',
  turnId: TURN_ID,
  path: 'src/foo.ts',
  kind: 'modified',
  attribution: 'AGENT',
  confidence: 'high',
  baseline: opts.baseline ?? false,
  beforeHash: sha(opts.beforeBytes),
  afterHash: sha(opts.afterBytes),
  currentHash: sha(opts.afterBytes),
  evidenceRefs: [],
})

const buildCheckpointPath = (opts: { checkpointId: string; path: string; ref: string; bytes: Buffer }): CheckpointPathState => ({
  schemaVersion: SCHEMA_VERSION,
  id: `${opts.checkpointId}:${opts.path}`,
  checkpointId: opts.checkpointId,
  path: opts.path,
  status: 'modified',
  staged: false,
  binary: false,
  contentHash: sha(opts.bytes),
  blobRef: opts.ref,
})

describe('RecoveryService end-to-end flow', () => {
  let workdir: string
  let homeDir: string
  let files: ReturnType<typeof makeFiles>
  let worktreeReader: WorktreeReader
  let clock: ApplyClock & { advance(ms: number): void }

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'turnscope-svc-workdir-'))
    homeDir = mkdtempSync(join(tmpdir(), 'turnscope-svc-home-'))
    mkdirSync(join(workdir, 'src'), { recursive: true })
    files = makeFiles(workdir, { 'src/foo.ts': 'export const x = 1\n' })
    worktreeReader = createNodeWorktreeReader()
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('preview: persists a plan with status=previewed and does not write the worktree', async () => {
    const verdict = buildSafeVerdict()
    const baseline = Buffer.from('export const x = 1\n', 'utf8')
    const after = Buffer.from('export const x = 2\n', 'utf8')
    const change = buildModifiedChange({ beforeBytes: baseline, afterBytes: after })
    const checkpointPath = buildCheckpointPath({ checkpointId: 'cp1', path: 'src/foo.ts', ref: 'before-ref', bytes: baseline })
    const checkpoint: CheckpointRecord = {
      schemaVersion: SCHEMA_VERSION,
      id: 'cp1',
      workspaceId: TURNOUT,
      turnId: TURN_ID,
      phase: 'pre',
      cleanStart: true,
      mergeInProgress: false,
      rebaseInProgress: false,
      cherryPickInProgress: false,
      completeness: 'complete',
      restorable: true,
      createdAt: NOW - 500,
    }
    files.write('src/foo.ts', 'export const x = 2\n')
    const { service } = buildHarness({
      repoRoot: workdir,
      files,
      clock: clock = makeClock(NOW),
      homeDir,
      changes: [change],
      checkpoints: [checkpoint],
      checkpointPaths: [checkpointPath],
      verdict,
      baselineBytes: baseline,
    })
    const reply = await service.previewRewind({ apiVersion: SCHEMA_VERSION, turnId: TURN_ID, evaluationId: 'e1' })
    expect(reply.data.plan).toBeDefined()
    expect(reply.data.plan?.status).toBe('previewed')
    // Preview is read-only: the worktree still holds the agent's bytes.
    expect(files.read('src/foo.ts')).toBe('export const x = 2\n')
  })

  it('apply: a plan with a restore op rewrites the worktree to the before bytes', async () => {
    const verdict = buildSafeVerdict()
    const baseline = Buffer.from('export const x = 1\n', 'utf8')
    const after = Buffer.from('export const x = 2\n', 'utf8')
    const change = buildModifiedChange({ beforeBytes: baseline, afterBytes: after })
    const checkpointPath = buildCheckpointPath({ checkpointId: 'cp1', path: 'src/foo.ts', ref: 'before-ref', bytes: baseline })
    const checkpoint: CheckpointRecord = {
      schemaVersion: SCHEMA_VERSION,
      id: 'cp1',
      workspaceId: TURNOUT,
      turnId: TURN_ID,
      phase: 'pre',
      cleanStart: true,
      mergeInProgress: false,
      rebaseInProgress: false,
      cherryPickInProgress: false,
      completeness: 'complete',
      restorable: true,
      createdAt: NOW - 500,
    }
    files.write('src/foo.ts', 'export const x = 2\n')
    const { service } = buildHarness({
      repoRoot: workdir,
      files,
      clock: clock = makeClock(NOW),
      homeDir,
      changes: [change],
      checkpoints: [checkpoint],
      checkpointPaths: [checkpointPath],
      verdict,
      baselineBytes: baseline,
    })
    const preview = await service.previewRewind({ apiVersion: SCHEMA_VERSION, turnId: TURN_ID, evaluationId: 'e1' })
    const plan = preview.data.plan!
    const applied = await service.applyRewind({ apiVersion: SCHEMA_VERSION, planId: plan.id })
    expect(applied.data.result?.status).toBe('completed')
    expect(files.read('src/foo.ts')).toBe('export const x = 1\n')
  })

  it('listUnfinished: plan moves through previewed -> applying -> completed', async () => {
    const verdict = buildSafeVerdict()
    const baseline = Buffer.from('export const x = 1\n', 'utf8')
    const after = Buffer.from('export const x = 2\n', 'utf8')
    const change = buildModifiedChange({ beforeBytes: baseline, afterBytes: after })
    const checkpointPath = buildCheckpointPath({ checkpointId: 'cp1', path: 'src/foo.ts', ref: 'before-ref', bytes: baseline })
    const checkpoint: CheckpointRecord = {
      schemaVersion: SCHEMA_VERSION,
      id: 'cp1',
      workspaceId: TURNOUT,
      turnId: TURN_ID,
      phase: 'pre',
      cleanStart: true,
      mergeInProgress: false,
      rebaseInProgress: false,
      cherryPickInProgress: false,
      completeness: 'complete',
      restorable: true,
      createdAt: NOW - 500,
    }
    files.write('src/foo.ts', 'export const x = 2\n')
    const { service } = buildHarness({
      repoRoot: workdir,
      files,
      clock: clock = makeClock(NOW),
      homeDir,
      changes: [change],
      checkpoints: [checkpoint],
      checkpointPaths: [checkpointPath],
      verdict,
      baselineBytes: baseline,
    })
    const preview = await service.previewRewind({ apiVersion: SCHEMA_VERSION, turnId: TURN_ID, evaluationId: 'e1' })
    const plan = preview.data.plan!
    const list1 = await service.listUnfinished({ apiVersion: SCHEMA_VERSION, includeFinished: false })
    expect(list1.data.plans.length).toBe(1)
    await service.applyRewind({ apiVersion: SCHEMA_VERSION, planId: plan.id })
    const list2 = await service.listUnfinished({ apiVersion: SCHEMA_VERSION, includeFinished: false })
    expect(list2.data.plans.length).toBe(0)
  })

  it('expired preview: apply returns failureReason, never writes the worktree', async () => {
    const verdict = buildSafeVerdict()
    const baseline = Buffer.from('export const x = 1\n', 'utf8')
    const after = Buffer.from('export const x = 2\n', 'utf8')
    const change = buildModifiedChange({ beforeBytes: baseline, afterBytes: after })
    const checkpointPath = buildCheckpointPath({ checkpointId: 'cp1', path: 'src/foo.ts', ref: 'before-ref', bytes: baseline })
    const checkpoint: CheckpointRecord = {
      schemaVersion: SCHEMA_VERSION,
      id: 'cp1',
      workspaceId: TURNOUT,
      turnId: TURN_ID,
      phase: 'pre',
      cleanStart: true,
      mergeInProgress: false,
      rebaseInProgress: false,
      cherryPickInProgress: false,
      completeness: 'complete',
      restorable: true,
      createdAt: NOW - 500,
    }
    files.write('src/foo.ts', 'export const x = 2\n')
    const { service } = buildHarness({
      repoRoot: workdir,
      files,
      clock: clock = makeClock(NOW),
      homeDir,
      changes: [change],
      checkpoints: [checkpoint],
      checkpointPaths: [checkpointPath],
      verdict,
      baselineBytes: baseline,
    })
    const preview = await service.previewRewind({ apiVersion: SCHEMA_VERSION, turnId: TURN_ID, evaluationId: 'e1', ttlMs: 1000 })
    const plan = preview.data.plan!
    clock.advance(5_000)
    const applied = await service.applyRewind({ apiVersion: SCHEMA_VERSION, planId: plan.id })
    expect(applied.data.result).toBeUndefined()
    expect(applied.data.failureReason).toMatch(/STALE|expired/i)
    expect(files.read('src/foo.ts')).toBe('export const x = 2\n')
  })
})

void enc