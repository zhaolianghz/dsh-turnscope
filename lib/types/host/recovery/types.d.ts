/**
 * The types of the V0.2 Safe Rewind, per
 * `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §4.2`.
 *
 * The planner is a pure function whose input is the stored evidence and whose
 * output is one of these types; the runner is the only thing that consumes
 * them. Nothing in this module touches the filesystem, the database, or git.
 *
 * The {@link RecoveryFileOperation} discriminated union is the single point of
 * truth for what rewind can do: every file in a {@link RecoveryPlan} carries
 * exactly one of these four shapes, and the runner dispatches on `kind`. The
 * `noop` shape encodes the four "do nothing" reasons a planner may pick
 * (baseline, drift, no diff, attribution uncertain) — each is a decision the
 * user can audit, not a hand-wave.
 */
import type { SafetyVerdict } from '../domain/types.ts';
/**
 * One file's rewind instruction.
 *
 * Every operation names the path it concerns and is one of four kinds:
 *
 * - `restore` — the file was modified by the turn; rewrite it from
 *   `targetBlobRef` (the bytes captured at the pre checkpoint). The runner
 *   refuses the operation when the current file's hash has drifted from
 *   `expectedCurrentHash`, because drifting means a third party has touched
 *   it and a blind overwrite would lose their work.
 * - `delete_created_file` — the file did not exist before the turn; remove it
 *   from the worktree. `expectedCurrentHash` plays the same drift guard.
 * - `recreate_deleted_file` — the file existed before the turn and the turn
 *   deleted it; rewrite it from `targetBlobRef`. No drift guard: a missing
 *   file cannot drift.
 * - `noop` — do nothing. `reason` is the audit-trail string the UI shows the
 *   user so they can see why a file they saw in the diff was not rewound.
 */
export type RecoveryFileOperation = {
    kind: 'restore';
    path: string;
    expectedCurrentHash: string;
    /** Bytes the turn started from (write these back to the worktree). */
    targetBlobRef: string;
    /** Bytes the turn left behind — kept so apply can drift-validate without a separate read. */
    afterBlobRef: string;
} | {
    kind: 'delete_created_file';
    path: string;
    expectedCurrentHash: string;
} | {
    kind: 'recreate_deleted_file';
    path: string;
    targetBlobRef: string;
} | {
    kind: 'noop';
    path: string;
    reason: 'baseline_only' | 'drift_preserved' | 'unchanged' | 'unknown';
};
/** Lifecycle of a {@link RecoveryPlan}, per spec §5.5 / §5.6. */
export type RecoveryPlanStatus = 'planned' | 'previewed' | 'applying' | 'completed' | 'failed' | 'cancelled';
/**
 * The rewind instruction for one turn's worth of changes.
 *
 * `id` is deterministic from `<turnId>:plan:<evaluationId>` so the planner and
 * the RPC handler can refer to the same plan without a round trip; a user who
 * re-runs Preview after editing the workspace gets a fresh plan id because the
 * evaluation id is also fresh. `expiresAt` is the deadline at which an apply
 * becomes a no-op (`status` flips to `cancelled`); the planner computes it as
 * `createdAt + ttlMs`.
 */
export interface RecoveryPlan {
    readonly schemaVersion: number;
    readonly id: string;
    readonly turnId: string;
    readonly verdict: SafetyVerdict;
    readonly evaluationId: string;
    /** sha256-prefixed fingerprint of the workspace at preview time, per spec §5.4. */
    readonly stateHash: string;
    readonly operations: readonly RecoveryFileOperation[];
    /** Checkpoint the bytes in `targetBlobRef` references were captured from. */
    readonly beforeCheckpointId: string;
    readonly status: RecoveryPlanStatus;
    readonly createdAt: number;
    readonly expiresAt: number;
}
/** The state machine of one op inside an apply, per spec §5.5. */
export type RecoveryJournalState = 'prepared' | 'temp_written' | 'applied' | 'verified' | 'rolled_back' | 'failed';
/**
 * One step in the apply, written before and after every side effect, per
 * spec §5.5.
 *
 * The journal is the only way a crashed apply can be detected on next boot;
 * without it a half-applied workspace would look indistinguishable from one
 * that was never started. `seq` is monotonic per plan and unique per (plan,
 * seq) — the runner writes at least two entries per op (`applied`, then
 * `verified`) so rollback can pick up at the right granularity.
 */
export interface RecoveryJournalEntry {
    readonly schemaVersion: number;
    readonly planId: string;
    readonly seq: number;
    readonly operation: RecoveryFileOperation;
    readonly state: RecoveryJournalState;
    readonly occurredAt: number;
    readonly error?: {
        code: string;
        message: string;
    };
}
/** What the runner hands back when the apply finishes, per spec §4.2. */
export interface RecoveryResult {
    readonly planId: string;
    readonly status: 'completed' | 'rolled_back' | 'failed';
    readonly afterCheckpointId: string | null;
    readonly journal: readonly RecoveryJournalEntry[];
    readonly failureReason?: string;
}
//# sourceMappingURL=types.d.ts.map