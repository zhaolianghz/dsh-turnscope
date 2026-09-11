/**
 * The V0.2 recovery planner, per
 * `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §5.1`.
 *
 * Pure by construction: the planner's input is the *stored evidence* (the
 * verdict, the file changes, the checkpoint path snapshots) and its output is
 * a {@link RecoveryPlan}. No filesystem, no clock (the host passes `nowMs` in),
 * no git. That constraint buys three things:
 *
 * 1. **Auditability.** The same evidence always yields the same plan, so a
 *    second preview against unchanged state lands on the same plan row in
 *    `recovery_plans` (`id = <turnId>:plan:<evaluationId>`).
 * 2. **Testability.** Every case below is a table row, not a fixture repo.
 * 3. **Drift honesty.** The runner is the only place that touches the
 *    worktree; if the runner detects drift, it can compare its *own* hash
 *    against the planner's `stateHash` and refuse, without the planner
 *    having any chance to lie about what it saw.
 *
 * What the planner refuses to do is just as important as what it does. It
 * does not look at the workspace. It does not call git. It does not call the
 * object store. The runner is the *only* component that does any of those
 * things, because the runner is the only component whose decisions need to be
 * validated against the live world.
 */

import { computeStateHash, type GitContext, type RelevantPath } from './hash.ts'
import type {
  RecoveryFileOperation,
  RecoveryPlan,
} from './types.ts'
import type {
  CheckpointPathState,
  FileChange,
  SafetyVerdict,
} from '../domain/types.ts'

/**
 * What the planner needs about one path's two checkpoints.
 *
 * `beforeBlobRef` is the bytes of the file at the start of the turn; `afterBlobRef`
 * is what the agent left behind. Either may be `undefined` when the side did
 * not capture the file (large file fingerprint, binary, or the file did not
 * exist). `currentContentHash` is what the *current* worktree looks like for
 * this path — passed in by the caller because the planner does not look at
 * the filesystem, but the hash is what the runner will compare against
 * immediately before writing.
 */
export interface PlannerPathSnapshot {
  readonly path: string
  readonly staged: boolean
  readonly currentContentHash: string | undefined
  readonly beforeBlobRef: string | undefined
  readonly afterBlobRef: string | undefined
  /** True when the file existed before the turn (regardless of who dirtied it). */
  readonly existedBefore: boolean
  /** True when the file exists now (the worktree state at preview time). */
  readonly existsNow: boolean
}

/**
 * Everything the planner needs to make a decision.
 *
 * `nowMs` is the only knob that makes the plan time-sensitive: the `createdAt`
 * and `expiresAt` are both computed from it, so a test that wants a stable
 * plan id can pin the clock.
 */
export interface RecoveryPlannerInput {
  readonly turnId: string
  readonly evaluationId: string
  readonly verdict: SafetyVerdict
  readonly workspaceId: string
  readonly git: GitContext
  readonly paths: readonly PlannerPathSnapshot[]
  readonly fileChanges: readonly FileChange[]
  readonly checkpointPathStates: readonly CheckpointPathState[]
  readonly beforeCheckpointId: string
  readonly nowMs: number
  /** Time-to-live, milliseconds. Spec §5.5: default 60 000 (60 seconds). */
  readonly ttlMs?: number
}

const DEFAULT_TTL_MS = 60_000

/**
 * Build the relevant-path list for {@link computeStateHash}.
 *
 * The planner only includes paths it produced an operation for, because
 * unrelated changes in the worktree are not the planner's business. The
 * `noop` cases are listed in the plan for the UI to display, but they do not
 * participate in the drift hash — `noop` cannot fail, so a hash mismatch
 * there would be a false alarm.
 */
function buildRelevantPaths(
  ops: readonly RecoveryFileOperation[],
  snapshots: ReadonlyMap<string, PlannerPathSnapshot>,
): readonly RelevantPath[] {
  const out: RelevantPath[] = []
  for (const op of ops) {
    if (op.kind === 'noop') continue
    const snap = snapshots.get(op.path)
    if (snap === undefined) continue
    out.push({ path: op.path, contentHash: snap.currentContentHash, staged: snap.staged })
  }
  return out
}

/**
 * Pick the per-path operation, one file at a time.
 *
 * The decision is the four-row table the spec promised; each branch is a
 * separate audit point so the UI can tell the user *why* a path was skipped.
 *
 * - `BASELINE` only → `noop baseline_only` (the agent did not touch it).
 * - `DRIFT` only → `noop drift_preserved` (a third party changed it; preserve).
 * - `UNCERTAIN` attribution → `noop unknown` (we do not know who to credit;
 *   the rewind would be a coin flip about whose work to throw away).
 * - `AGENT` with a `kind` we can act on → one of the three rewinding ops.
 * - Everything else (no diff to reverse, file already in target state) →
 *   `noop unchanged`.
 */
function classifyPath(
  change: FileChange | undefined,
  snapshot: PlannerPathSnapshot,
): RecoveryFileOperation {
  // No file_change row at all means the path was clean through the whole turn.
  if (change === undefined) {
    return { kind: 'noop', path: snapshot.path, reason: 'unchanged' }
  }

  if (change.attribution === 'BASELINE') {
    return { kind: 'noop', path: snapshot.path, reason: 'baseline_only' }
  }

  if (change.attribution === 'DRIFT') {
    return { kind: 'noop', path: snapshot.path, reason: 'drift_preserved' }
  }

  if (change.attribution === 'UNCERTAIN') {
    return { kind: 'noop', path: snapshot.path, reason: 'unknown' }
  }

  // AGENT — pick the matching op for `kind`.
  switch (change.kind) {
    case 'created':
      return {
        kind: 'delete_created_file',
        path: snapshot.path,
        expectedCurrentHash: snapshot.currentContentHash ?? '',
      }
    case 'deleted':
      if (snapshot.beforeBlobRef === undefined) {
        return { kind: 'noop', path: snapshot.path, reason: 'unknown' }
      }
      return {
        kind: 'recreate_deleted_file',
        path: snapshot.path,
        targetBlobRef: snapshot.beforeBlobRef,
      }
    case 'modified':
    case 'binary_changed':
      if (snapshot.beforeBlobRef === undefined || snapshot.afterBlobRef === undefined) {
        return { kind: 'noop', path: snapshot.path, reason: 'unknown' }
      }
      return {
        kind: 'restore',
        path: snapshot.path,
        expectedCurrentHash: snapshot.currentContentHash ?? '',
        targetBlobRef: snapshot.beforeBlobRef,
        afterBlobRef: snapshot.afterBlobRef,
      }
    case 'renamed': {
      // A rename's reverse is "delete the new file, recreate the old one" —
      // but this planner only handles per-file ops, so a rename becomes two
      // ops in the host wrapper. In isolation this branch is a no-op.
      return { kind: 'noop', path: snapshot.path, reason: 'unchanged' }
    }
  }
}

/**
 * Build the plan. Pure: same input, same output, down to the timestamps if
 * the caller pins `nowMs`.
 *
 * The order of operations is stable (sorted by path) so that the same input
 * produces byte-identical plan JSON. That is the property the journal and the
 * `id`-based dedup rely on.
 */
export function planRecovery(input: RecoveryPlannerInput): RecoveryPlan {
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS
  const snapshots = new Map<string, PlannerPathSnapshot>()
  for (const s of input.paths) snapshots.set(s.path, s)

  const changes = new Map<string, FileChange>()
  for (const c of input.fileChanges) changes.set(c.path, c)

  // Decide on every path the planner has evidence for (either from
  // file_changes or from checkpoint_paths). A path the user sees in the diff
  // but the planner has no evidence for is a noop "unchanged" — the safest
  // possible answer.
  const allPaths = new Set<string>()
  for (const s of input.paths) allPaths.add(s.path)
  for (const cp of input.checkpointPathStates) allPaths.add(cp.path)
  for (const c of input.fileChanges) allPaths.add(c.path)

  const ops: RecoveryFileOperation[] = []
  const sorted = [...allPaths].sort()
  for (const path of sorted) {
    const snapshot = snapshots.get(path)
    const change = changes.get(path)
    if (snapshot === undefined) {
      // No snapshot → we cannot drift-detect; refuse.
      ops.push({ kind: 'noop', path, reason: 'unknown' })
      continue
    }
    ops.push(classifyPath(change, snapshot))
  }

  const relevantPaths = buildRelevantPaths(ops, snapshots)
  const stateHash = computeStateHash({
    workspaceId: input.workspaceId,
    git: input.git,
    relevantPaths,
  })

  return {
    schemaVersion: 3,
    id: `${input.turnId}:plan:${input.evaluationId}`,
    turnId: input.turnId,
    verdict: input.verdict,
    evaluationId: input.evaluationId,
    stateHash,
    operations: ops,
    beforeCheckpointId: input.beforeCheckpointId,
    status: 'planned',
    createdAt: input.nowMs,
    expiresAt: input.nowMs + ttl,
  }
}