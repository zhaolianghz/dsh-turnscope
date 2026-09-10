import type { ActivityRecord, CheckpointPathState, CheckpointRecord, CommandRecord, EvidenceCompleteness, FileChange, ObjectRecord, SafetyVerdict, SessionRecord, TestRecord, TurnRecord, TurnStatus, WorkspaceRecord } from '../domain/types.ts';
import type { IndexHandle } from './sqlite-index.ts';
/**
 * The read side of the trace store: the port every other module consumes.
 *
 * It is the seam that keeps `node:sqlite` inside `src/host/storage`. It is also
 * the seam that would let a future backend (a remote store, a different engine)
 * be swapped in without touching the recorder, which is why every method is
 * `async` even though the current driver is synchronous.
 */
export interface TraceRepository {
    upsertWorkspace(record: WorkspaceRecord): Promise<void>;
    upsertSession(record: SessionRecord): Promise<void>;
    upsertTurn(record: TurnRecord): Promise<void>;
    /** Move a turn to a terminal status, unless it already reached one. */
    closeTurn(turnId: string, status: TurnStatus, endedAt: number): Promise<void>;
    /** Record what a turn's evidence turned out to be worth, after the fact. */
    setEvidenceCompleteness(turnId: string, value: EvidenceCompleteness): Promise<void>;
    /** The turns of a session, newest ordinal first. */
    listTurns(sessionId: string, limit: number): Promise<readonly TurnRecord[]>;
    getTurn(turnId: string): Promise<TurnRecord | undefined>;
    appendActivity(record: ActivityRecord): Promise<void>;
    /** The activities of a turn, in upstream `seq` order. */
    getActivities(turnId: string): Promise<readonly ActivityRecord[]>;
    putCheckpoint(record: CheckpointRecord): Promise<void>;
    getCheckpoint(id: string): Promise<CheckpointRecord | undefined>;
    listCheckpoints(turnId: string): Promise<readonly CheckpointRecord[]>;
    /** Record one observed path of a checkpoint. Idempotent on the path id. */
    putCheckpointPath(record: CheckpointPathState): Promise<void>;
    /** The paths a checkpoint observed, ordered by path. */
    listCheckpointPaths(checkpointId: string): Promise<readonly CheckpointPathState[]>;
    /** Record one attributed file change. Idempotent on the change id. */
    putFileChange(record: FileChange): Promise<void>;
    /** The changes attributed to a turn, ordered by path. */
    listFileChanges(turnId: string): Promise<readonly FileChange[]>;
    putCommand(record: CommandRecord): Promise<void>;
    listCommands(turnId: string): Promise<readonly CommandRecord[]>;
    putTest(record: TestRecord): Promise<void>;
    listTests(turnId: string): Promise<readonly TestRecord[]>;
    putSafetyVerdict(record: SafetyVerdict): Promise<void>;
    /** The most recent verdict for a turn, by evaluation time. */
    getLatestVerdict(turnId: string): Promise<SafetyVerdict | undefined>;
    putObjectRecord(record: ObjectRecord): Promise<void>;
    statObject(ref: string): Promise<ObjectRecord | undefined>;
    /** Drop one object's index row. The bytes are the object store's business. */
    deleteObject(ref: string): Promise<void>;
    /** Every object ref still held by a record, sorted; retention pins these. */
    referencedRefs(): Promise<readonly string[]>;
    storageUsage(): Promise<{
        readonly objectBytes: number;
        readonly objectCount: number;
    }>;
    close(): Promise<void>;
}
/**
 * Open a {@link TraceRepository} over an already-migrated index.
 *
 * The driver is synchronous and so is every statement below; the methods are
 * `async` only because the port is. Nothing here awaits between statements, so a
 * caller's `BEGIN IMMEDIATE` cannot have another writer interleaved into it.
 */
export declare function createRepository(handle: IndexHandle): TraceRepository;
//# sourceMappingURL=repository.d.ts.map