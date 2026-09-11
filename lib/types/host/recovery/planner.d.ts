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
import { type GitContext } from './hash.ts';
import type { RecoveryPlan } from './types.ts';
import type { CheckpointPathState, FileChange, SafetyVerdict } from '../domain/types.ts';
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
    readonly path: string;
    readonly staged: boolean;
    readonly currentContentHash: string | undefined;
    readonly beforeBlobRef: string | undefined;
    readonly afterBlobRef: string | undefined;
    /** True when the file existed before the turn (regardless of who dirtied it). */
    readonly existedBefore: boolean;
    /** True when the file exists now (the worktree state at preview time). */
    readonly existsNow: boolean;
}
/**
 * Everything the planner needs to make a decision.
 *
 * `nowMs` is the only knob that makes the plan time-sensitive: the `createdAt`
 * and `expiresAt` are both computed from it, so a test that wants a stable
 * plan id can pin the clock.
 */
export interface RecoveryPlannerInput {
    readonly turnId: string;
    readonly evaluationId: string;
    readonly verdict: SafetyVerdict;
    readonly workspaceId: string;
    readonly git: GitContext;
    readonly paths: readonly PlannerPathSnapshot[];
    readonly fileChanges: readonly FileChange[];
    readonly checkpointPathStates: readonly CheckpointPathState[];
    readonly beforeCheckpointId: string;
    readonly nowMs: number;
    /** Time-to-live, milliseconds. Spec §5.5: default 60 000 (60 seconds). */
    readonly ttlMs?: number;
}
/**
 * Build the plan. Pure: same input, same output, down to the timestamps if
 * the caller pins `nowMs`.
 *
 * The order of operations is stable (sorted by path) so that the same input
 * produces byte-identical plan JSON. That is the property the journal and the
 * `id`-based dedup rely on.
 */
export declare function planRecovery(input: RecoveryPlannerInput): RecoveryPlan;
//# sourceMappingURL=planner.d.ts.map