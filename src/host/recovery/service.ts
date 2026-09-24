/**
 * The host-side recovery service: what a client asks, answered from what was
 * recorded and from what the runner can do.
 *
 * Three entry points, ordered by how much they touch the worktree:
 *
 *   - `previewRewind`  records a plan, runs a dry-run through the runner's
 *                       drift guard, and persists the verdict (`previewed`).
 *                       No file in the worktree is written.
 *   - `applyRewind`    runs the runner's atomic-write + journal path. The
 *                       runner writes the worktree; this service persists the
 *                       plan's terminal status and emits the journal back.
 *   - `listUnfinished` reads the index for plans that did not reach a terminal
 *                       state (the boot-time crash surfacing in §9.1).
 *
 * Like the query service, this module crosses no port directly: it reads
 * through {@link RecoverySink} (a narrow subset of {@link TraceRepository}),
 * calls the runner through {@link RecoveryRunner} (so the runner can be
 * faked in tests), and reads the worktree through {@link WorktreeReader} so
 * the file IO never leaks out of the storage layer.
 */

import type {
  ApplyRewindData,
  ApplyRewindRequest,
  ListRecoveryPlansData,
  ListRecoveryPlansRequest,
  PreviewRewindData,
  PreviewRewindRequest,
} from '../../shared/contracts/api.ts'
import { envelope } from '../../shared/contracts/api.ts'
import type { TurnscopeApiEnvelope } from '../../shared/contracts/api.ts'
import type { CheckpointPathState, SafetyVerdict, TurnRecord, WorkspaceRecord } from '../domain/types.ts'
import { planRecovery, type PlannerPathSnapshot } from './planner.ts'
import { rollbackUnfinished } from './runner/rollback.ts'
import { OBJECT_KINDS } from '../storage/object-store.ts'
import type { GitPort } from '../git/git-port.ts'
import { captureCheckpoint } from '../git/checkpoint.ts'
import { cleanupDryRun, runDryRun } from './runner/dryrun.ts'
import { deleteJournal } from './runner/journal.ts'
import { resolveDryRunRoot } from './runner/paths.ts'
import { runApply, type ApplyClock, type ApplyLiveContext } from './runner/apply.ts'
import { computeStateHash } from './hash.ts'
import type { ObjectStore } from '../storage/object-store.ts'
import type { RecoveryPlan, RecoveryPlanStatus, RecoveryResult } from './types.ts'
import type { TraceRepository } from '../storage/repository.ts'

/**
 * The storage reads and writes the recovery service performs.
 *
 * Narrower than {@link TraceRepository} so a test can hand it an in-memory
 * stand-in without dragging in every other write.
 */
export type RecoverySink = Pick<
  TraceRepository,
  | 'getTurn'
  | 'getWorkspace'
  | 'listFileChanges'
  | 'listCheckpoints'
  | 'listCheckpointPaths'
  | 'getLatestVerdict'
  | 'getRecoveryPlan'
  | 'putRecoveryPlan'
  | 'updateRecoveryPlanStatus'
  | 'listRecoveryPlans'
  | 'listUnfinishedRecoveryPlans'
  | 'putObjectRecord'
  | 'putRecoveryJournalEntry'
  | 'putCheckpoint'
  | 'putCheckpointPath'
>

/**
 * What the runner reads from and writes to in the worktree.
 *
 * Lives at the host boundary so that the runner can be replaced by a fake in
 * tests and so the only module that names `node:fs` is `runner/apply.ts`
 * (`tests/host/architecture.spec.ts`).
 */
export interface WorktreeReader {
  /**
   * Hash the file at `path` in the worktree (sha256-prefixed). Returns
   * `undefined` when the file does not exist.
   */
  hashCurrent(workspaceRoot: string, path: string): Promise<string | undefined>
  /**
   * Read the file at `path` in the worktree. Returns `undefined` when the
   * file does not exist.
   */
  readCurrent(workspaceRoot: string, path: string): Promise<Uint8Array | undefined>
}

/** A clock the runner uses for journal timestamps and seq numbers. */
export interface RecoveryClock extends ApplyClock {}

/** Pulled together so a unit test can fake any of the three. */
export interface RecoveryDeps {
  readonly sink: RecoverySink
  readonly store: ObjectStore
  readonly worktree: WorktreeReader
  readonly clock: RecoveryClock
  /** Where the journal and dryrun staging directories live. */
  readonly homeDir: string
  /**
   * Read-only access to git. The rewind reads the bytes of every relevant path
   * as it stood in `HEAD` so the planner can put a real `beforeBlobRef` on
   * each op; without it, drift detection has nothing to compare the live
   * worktree against, and a rewind would happily overwrite the user's work.
   */
  readonly git: GitPort
}

/**
 * The host-side API the client calls into.
 *
 * Reply shapes follow the rest of the API: each method returns an envelope
 * whose `data` is the typed payload. `previewRewind` is the one that can fail
 * without writing anything (a drift conflict, or a plan that never landed);
 * the failure is part of the payload, not an exception, so the UI can show
 * exactly which op rejected.
 */
export interface RecoveryService {
  previewRewind(request: PreviewRewindRequest): Promise<TurnscopeApiEnvelope<PreviewRewindData>>
  applyRewind(request: ApplyRewindRequest): Promise<TurnscopeApiEnvelope<ApplyRewindData>>
  listUnfinished(request: ListRecoveryPlansRequest): Promise<TurnscopeApiEnvelope<ListRecoveryPlansData>>
}

/**
 * Build a recovery service.
 *
 * `applyRewind` rolls back to the user's pre-apply state when any op fails the
 * runner's drift guard; that means the runner is the single owner of the
 * worktree side-effects, and the only thing the service has to do on
 * `applyRewind` is persist the terminal status.
 */
export function createRecoveryService(deps: RecoveryDeps): RecoveryService {
  const { sink, store, worktree, clock, homeDir, git } = deps

  /**
   * Pull a turn, its workspace, its file changes, and the before-checkpoint
   * paths into the shape the planner needs.
   *
   * The checkpoint path reads are independent and run together once the
   * pre/post checkpoint ids have been found.
   */
  const collectPlannerInputs = async (turnId: string) => {
    const turn = await sink.getTurn(turnId)
    if (turn === undefined) return undefined
    const workspace = await sink.getWorkspace(turn.workspaceId)
    if (workspace === undefined) return undefined
    const fileChanges = await sink.listFileChanges(turnId)
    const checkpoints = await sink.listCheckpoints(turnId)
    const pre = checkpoints.find(checkpoint => checkpoint.phase === 'pre')
    const post = checkpoints.find(checkpoint => checkpoint.phase === 'post')
    if (pre === undefined || post === undefined) return undefined
    const [checkpointPaths, postCheckpointPaths] = await Promise.all([
      sink.listCheckpointPaths(pre.id),
      sink.listCheckpointPaths(post.id),
    ])
    return { turn, workspace, fileChanges, checkpointPaths, postCheckpointPaths, pre, beforeCheckpointId: pre.id }
  }

  /**
   * Build the per-path snapshot the planner needs from the live worktree.
   *
   * The worktree reader is invoked per file (rather than carrying a full
   * tree, which would be a re-implementation of `git ls-files`), and the
   * resulting `currentContentHash` is used by the planner to decide whether
   * the live file has drifted since the turn's checkpoint was taken.
   */
  const snapshotPaths = async (
    paths: readonly string[],
    workspace: WorkspaceRecord,
    checkpointPathsByPath: ReadonlyMap<string, CheckpointPathState>,
    postPathsByPath: ReadonlyMap<string, CheckpointPathState>,
    headRef: string,
  ): Promise<readonly PlannerPathSnapshot[]> => {
    return Promise.all(
      paths.map(async path => {
        const currentContentHash = await worktree.hashCurrent(workspace.repoRoot, path)
        const existsNow = currentContentHash !== undefined
        const cp = checkpointPathsByPath.get(path)
        // Prefer the pre-turn snapshot: HEAD would discard a user's uncommitted
        // changes from before the turn. A clean path has no pre blob, so its
        // pre-turn HEAD oid supplies the bytes instead.
        const headBytes = cp?.blobRef === undefined
          ? await git.blobAt(workspace.repoRoot, headRef, path)
          : undefined
        let beforeBlobRef = cp?.blobRef
        if (headBytes !== undefined && beforeBlobRef === undefined) {
          const stored = await store.put(OBJECT_KINDS.RECOVERY_BLOB, headBytes, {
            redaction: 'raw-bytes',
          })
          await sink.putObjectRecord?.({
            schemaVersion: 3,
            ref: stored.ref,
            kind: OBJECT_KINDS.RECOVERY_BLOB,
            byteSize: stored.byteSize,
            sha256: stored.sha256,
            createdAt: clock.nowMs(),
          })
          beforeBlobRef = stored.ref
        }
        return {
          path,
          staged: false,
          currentContentHash,
          beforeBlobRef,
          afterBlobRef: postPathsByPath.get(path)?.blobRef,
          existedBefore: beforeBlobRef !== undefined,
          existsNow,
        }
      }),
    )
  }

  const liveFor = (workspaceRoot: string): ApplyLiveContext => ({
    async hashCurrent(path: string): Promise<string | null> {
      return (await worktree.hashCurrent(workspaceRoot, path)) ?? null
    },
    async readCurrent(path: string): Promise<Uint8Array | null> {
      return (await worktree.readCurrent(workspaceRoot, path)) ?? null
    },
  })

  const dryrunLiveFor = (workspaceRoot: string) => ({
    readCurrent: async (path: string): Promise<Uint8Array | null> => {
      return (await worktree.readCurrent(workspaceRoot, path)) ?? null
    },
  })

  return {
    previewRewind: async request => {
      const inputs = await collectPlannerInputs(request.turnId)
      if (inputs === undefined) {
        const data: PreviewRewindData = { failureReason: 'turn or workspace not found, or turn has no checkpoints' }
        return envelope<PreviewRewindData>(data)
      }
      const { turn, workspace, fileChanges, checkpointPaths, postCheckpointPaths, pre, beforeCheckpointId } = inputs
      const verdictOrError = await loadVerdictOrFail(sink, turn)
      if (!('level' in verdictOrError)) {
        const data: PreviewRewindData = { failureReason: verdictOrError.message }
        return envelope<PreviewRewindData>(data)
      }
      const verdict: SafetyVerdict = verdictOrError
      const head = await git.head(workspace.repoRoot)
      const headRef = pre.headOid ?? 'HEAD'
      const pathSet = new Set(fileChanges.map(c => c.path))
      for (const cp of checkpointPaths) pathSet.add(cp.path)
      const checkpointPathsByPath = new Map(checkpointPaths.map(cp => [cp.path, cp]))
      const postPathsByPath = new Map(postCheckpointPaths.map(cp => [cp.path, cp]))
      const paths = await snapshotPaths([...pathSet], workspace, checkpointPathsByPath, postPathsByPath, headRef)

      const plan = planRecovery({
        turnId: turn.id,
        evaluationId: request.evaluationId,
        verdict,
        workspaceId: workspace.id,
        git: {
          headOid: head?.oid ?? 'pending',
          branch: head?.branch ?? 'detached',
          worktreePath: workspace.repoRoot,
        },
        paths,
        fileChanges,
        checkpointPathStates: checkpointPaths,
        beforeCheckpointId,
        nowMs: clock.nowMs(),
      })

      // Drift guard: rewind only makes sense if the live file still matches
      // the post state we recorded. The dryrun uses the same apply path as
      // apply, so a conflict here is the same conflict apply would surface.
      const dryrun = await runDryRun(
        plan,
        store,
        dryrunLiveFor(workspace.repoRoot),
        homeDir,
      )
      const dryrunHasConflict = dryrun.ops.some(op => op.kind === 'conflict')
      if (dryrunHasConflict) {
        const reason = dryrun.ops
          .filter(op => op.kind === 'conflict')
          .map(op => `${op.op.path}: ${op.reason}`)
          .join('; ')
        const data: PreviewRewindData = { plan, failureReason: reason }
        return envelope<PreviewRewindData>(data)
      }

      // Persist the plan (status `previewed` with an expiry) so a later
      // `applyRewind` can find it and so the boot-time `listUnfinished`
      // surface can warn if the preview is stale.
      const expiresAt = clock.nowMs() + (request.ttlMs ?? 60_000)
      const previewed: RecoveryPlan = { ...plan, status: 'previewed', expiresAt }
      await sink.putRecoveryPlan(previewed)
      return envelope<PreviewRewindData>({ plan: previewed })
    },

    applyRewind: async request => {
      const stored = await sink.getRecoveryPlan(request.planId)
      if (stored === undefined) {
        const data: ApplyRewindData = { failureReason: `plan ${request.planId} not found` }
        return envelope(data)
      }
      if (stored.status !== 'previewed') {
        return envelope<ApplyRewindData>({ failureReason: `plan is ${stored.status}, not previewed` })
      }
      // Refuse to apply a plan whose preview window has elapsed: the user
      // had `ttlMs` to confirm, after which the live workspace may have
      // moved on (spec §5.6).
      if (stored.status === 'previewed' && (stored.expiresAt ?? 0) < clock.nowMs()) {
        await sink.updateRecoveryPlanStatus(stored.id, 'cancelled')
        const data: ApplyRewindData = { failureReason: 'preview window expired' }
        return envelope(data)
      }
      const workspace = await sink.getWorkspace((await sink.getTurn(stored.turnId))?.workspaceId ?? '')
      if (workspace === undefined) {
        const data: ApplyRewindData = { failureReason: 'workspace no longer exists' }
        return envelope(data)
      }
      const head = await git.head(workspace.repoRoot)
      const relevantPaths = await Promise.all(stored.operations
        .filter(op => op.kind !== 'noop')
        .map(async op => ({
          path: op.path,
          contentHash: await worktree.hashCurrent(workspace.repoRoot, op.path),
          staged: false,
        })))
      const liveStateHash = computeStateHash({
        workspaceId: workspace.id,
        git: {
          headOid: head?.oid ?? 'pending',
          branch: head?.branch ?? 'detached',
          worktreePath: workspace.repoRoot,
        },
        relevantPaths,
      })
      if (liveStateHash !== stored.stateHash) {
        return envelope<ApplyRewindData>({ failureReason: 'workspace changed since preview' })
      }
      const plan: RecoveryPlan = { ...stored, status: 'applying' }
      delete (plan as { completedAt?: number }).completedAt
      await sink.updateRecoveryPlanStatus(plan.id, 'applying')

      const result: RecoveryResult = await runApply({
        plan,
        worktreeRoot: workspace.repoRoot,
        homeDir,
        objectStore: store,
        live: liveFor(workspace.repoRoot),
        clock,
      })

      // Persist the journal the runner produced. Without these rows, a crash
      // surfacing in §9.1 (boot-time `rollbackUnfinished`) has nothing to
      // walk, and the journal's whole reason for being — "honest about what
      // happened" — is unfulfilled.
      for (const entry of result.journal) {
        await sink.putRecoveryJournalEntry(entry)
      }

      // `recovery_after` is the post-rewind snapshot. Capturing it makes the
      // rewind itself undoable (a future "rewind the rewind" sees the workspace
      // as it stood after this one finished), and gives a future drift check
      // something to compare the live file against other than `HEAD`.
      if (result.status === 'completed') {
        await captureCheckpoint(
          { git, store, sink, maxBlobBytes: 1024 * 1024, ignorePaths: [] },
          {
            workspaceId: workspace.id,
            repoRoot: workspace.repoRoot,
            turnId: plan.turnId,
            phase: 'recovery_after',
          },
        )
      }

      const finalStatus: RecoveryPlanStatus = result.status
      await sink.updateRecoveryPlanStatus(plan.id, finalStatus)
      if (finalStatus === 'completed') {
        await deleteJournal(homeDir, plan.id).catch(() => undefined)
        await cleanupDryRun(resolveDryRunRoot(homeDir, plan.id))
      }
      const data: ApplyRewindData = {
        result,
        ...(result.status === 'completed' ? {} : { failureReason: result.failureReason ?? 'apply failed' }),
      }
      return envelope(data)
    },

    listUnfinished: async request => {
      const plans = await sink.listUnfinishedRecoveryPlans(clock.nowMs())
      return envelope<ListRecoveryPlansData>({
        plans,
        ...(request.includeFinished === true ? {} : {}),
      })
    },
  }
}

/**
 * At startup, restore each interrupted apply and mark its plan rolled back.
 * A changed file makes the walker throw and keeps the plan `applying`, so
 * startup never overwrites post-crash user edits.
 */
export async function rollbackAllUnfinished(
  sink: RecoverySink,
  homeDir: string,
  turnIds: readonly string[],
): Promise<readonly { planId: string; path: string; seq: number }[]> {
  const results: { planId: string; path: string; seq: number }[] = []
  for (const turnId of turnIds) {
    const plans = await sink.listRecoveryPlans(turnId)
    for (const plan of plans) {
      if (plan.status !== 'applying') continue
      const turn = await sink.getTurn(plan.turnId)
      if (turn === undefined) continue
      const workspace = await sink.getWorkspace(turn.workspaceId)
      if (workspace === undefined) continue
      const out = await rollbackUnfinished(plan.id, workspace.repoRoot, homeDir)
      for (const entry of out) results.push(entry)
      await sink.updateRecoveryPlanStatus(plan.id, 'rolled_back')
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type VerdictOrError = SafetyVerdict | { readonly message: string }

async function loadVerdictOrFail(
  sink: Pick<TraceRepository, 'getLatestVerdict'>,
  turn: TurnRecord,
): Promise<VerdictOrError> {
  const verdict = await sink.getLatestVerdict(turn.id)
  if (verdict === undefined) return { message: 'no verdict recorded for this turn' }
  return verdict
}
