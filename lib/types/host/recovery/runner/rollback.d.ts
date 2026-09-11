/**
 * Boot-time recovery walk, per
 * `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §5.6`.
 *
 * A previous run may have crashed between the `applied` journal write and
 * the `verified` journal write. The bytes are on disk in the worktree, but
 * the host never got a chance to confirm them. We surface that as
 * `unfinishedRecoveryPlans` from `listUnfinishedRecoveryPlans`, and this
 * module is the tool the host calls to actually roll the worktree back:
 * for every entry whose latest journal row is `applied` but not
 * `verified`, the file is restored from the backup the runner left in the
 * staging directory.
 *
 * The function is pure with respect to the journal and the staging dir:
 * it does not touch the SQLite index, does not re-run the planner, does not
 * call git. It is one of two entry points the host can use to recover from
 * a crash (the other is "ask the user to confirm a fresh apply").
 */
/** One op the boot-time walker decided to roll back. */
export interface RolledBackOp {
    readonly planId: string;
    readonly path: string;
    /** The seq of the `applied` journal entry that produced the orphan. */
    readonly seq: number;
}
/**
 * Walk the journal for `planId` and roll back every op whose latest entry is
 * `applied` (or `temp_written`) without a matching `verified`.
 *
 * The "latest entry per (seq, state)" semantics come straight from the
 * three-tuple journal PK: `(plan_id, seq, state)` only collides on the same
 * `state`, so a hunk has at most one entry per state. The walker therefore
 * filters `applied` by checking that no `verified` for the same `seq` is in
 * the journal.
 */
export declare function rollbackUnfinished(planId: string, worktreeRoot: string, homeDir: string): Promise<readonly RolledBackOp[]>;
//# sourceMappingURL=rollback.d.ts.map