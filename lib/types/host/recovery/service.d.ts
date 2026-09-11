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
import type { ApplyRewindData, ApplyRewindRequest, ListRecoveryPlansData, ListRecoveryPlansRequest, PreviewRewindData, PreviewRewindRequest } from '../../shared/contracts/api.ts';
import type { TurnscopeApiEnvelope } from '../../shared/contracts/api.ts';
import { type ApplyClock } from './runner/apply.ts';
import type { ObjectStore } from '../storage/object-store.ts';
import type { TraceRepository } from '../storage/repository.ts';
/**
 * The storage reads and writes the recovery service performs.
 *
 * Narrower than {@link TraceRepository} so a test can hand it an in-memory
 * stand-in without dragging in every other write.
 */
export type RecoverySink = Pick<TraceRepository, 'getTurn' | 'getWorkspace' | 'listFileChanges' | 'listCheckpoints' | 'listCheckpointPaths' | 'getLatestVerdict' | 'getRecoveryPlan' | 'putRecoveryPlan' | 'updateRecoveryPlanStatus' | 'listRecoveryPlans' | 'listUnfinishedRecoveryPlans'>;
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
    hashCurrent(workspaceRoot: string, path: string): Promise<string | undefined>;
    /**
     * Read the file at `path` in the worktree. Returns `undefined` when the
     * file does not exist.
     */
    readCurrent(workspaceRoot: string, path: string): Promise<Uint8Array | undefined>;
}
/** A clock the runner uses for journal timestamps and seq numbers. */
export interface RecoveryClock extends ApplyClock {
}
/** Pulled together so a unit test can fake any of the three. */
export interface RecoveryDeps {
    readonly sink: RecoverySink;
    readonly store: ObjectStore;
    readonly worktree: WorktreeReader;
    readonly clock: RecoveryClock;
    /** Where the journal and dryrun staging directories live. */
    readonly homeDir: string;
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
    previewRewind(request: PreviewRewindRequest): Promise<TurnscopeApiEnvelope<PreviewRewindData>>;
    applyRewind(request: ApplyRewindRequest): Promise<TurnscopeApiEnvelope<ApplyRewindData>>;
    listUnfinished(request: ListRecoveryPlansRequest): Promise<TurnscopeApiEnvelope<ListRecoveryPlansData>>;
}
/**
 * Build a recovery service.
 *
 * `applyRewind` rolls back to the user's pre-apply state when any op fails the
 * runner's drift guard; that means the runner is the single owner of the
 * worktree side-effects, and the only thing the service has to do on
 * `applyRewind` is persist the terminal status.
 */
export declare function createRecoveryService(deps: RecoveryDeps): RecoveryService;
/**
 * One round-trip into the recovery root: list plan ids whose journal exists,
 * and run the rollback walker for each. Used by the boot-time probe; not on
 * the client-facing API yet (`docs/PRD.md` keeps the rollback user-triggered
 * in V0.2). Pulled out so the same logic is reusable from a future CLI.
 */
export declare function rollbackAllUnfinished(sink: RecoverySink, worktree: WorktreeReader, homeDir: string, turnIds: readonly string[]): Promise<readonly {
    planId: string;
    path: string;
    seq: number;
}[]>;
//# sourceMappingURL=service.d.ts.map