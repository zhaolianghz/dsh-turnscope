import type { ActivityRecord, CheckpointPathState, CheckpointRecord, CommandRecord, EvidenceCompleteness, FileChange, ObjectRecord, SafetyVerdict, SessionRecord, TestRecord, TurnRecord, TurnStatus, WorkspaceRecord } from '../domain/types.ts';
import type { IndexHandle } from './sqlite-index.ts';
/**
 * How much of a session's turn list to read, and from where.
 *
 * `cursor` is opaque to the caller on purpose — it is the previous page's last
 * `ordinal`, but a client that treated it as an arithmetic offset would break
 * the moment the ordering key changed, so nothing in the contract invites that.
 */
export interface TurnPageQuery {
    readonly limit: number;
    /** Exclusive upper bound on `ordinal`: return turns strictly older than this. */
    readonly cursor?: number;
}
/** One page of turns, plus how to ask for the next one. */
export interface TurnPage {
    readonly turns: readonly TurnRecord[];
    /** Set only when more rows are known to exist, so its absence is trustworthy. */
    readonly nextCursor?: number;
}
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
    getWorkspace(workspaceId: string): Promise<WorkspaceRecord | undefined>;
    upsertSession(record: SessionRecord): Promise<void>;
    upsertTurn(record: TurnRecord): Promise<void>;
    /** Move a turn to a terminal status, unless it already reached one. */
    closeTurn(turnId: string, status: TurnStatus, endedAt: number): Promise<void>;
    /** Record what a turn's evidence turned out to be worth, after the fact. */
    setEvidenceCompleteness(turnId: string, value: EvidenceCompleteness): Promise<void>;
    /**
     * One page of a session's turns, newest ordinal first.
     *
     * Keyset rather than offset, per `docs/ARCHITECTURE.md §44.3`: a session can
     * outlive a thousand turns, and an `OFFSET` page shifts under the reader every
     * time a new turn is appended — which, for a list that is being watched live,
     * is exactly when it must not. The cursor is the `ordinal` of the last row the
     * caller saw, so the next page is "everything older than that" and nothing is
     * ever skipped or repeated.
     */
    listTurns(sessionId: string, query: TurnPageQuery): Promise<TurnPage>;
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
    /**
     * How many changes each of these turns has, in one statement.
     *
     * Bulk for the same reason the verdict lookup below is: the turn list renders
     * a count per row and refreshes while a turn runs, so a per-row query would
     * make the hot path 1 + N (`docs/ARCHITECTURE.md §44.3`).
     */
    countFileChanges(turnIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
    putCommand(record: CommandRecord): Promise<void>;
    listCommands(turnId: string): Promise<readonly CommandRecord[]>;
    putTest(record: TestRecord): Promise<void>;
    listTests(turnId: string): Promise<readonly TestRecord[]>;
    putSafetyVerdict(record: SafetyVerdict): Promise<void>;
    /** The most recent verdict for a turn, by evaluation time. */
    getLatestVerdict(turnId: string): Promise<SafetyVerdict | undefined>;
    /**
     * The most recent verdict for each of these turns, in one statement.
     *
     * "Most recent" is per turn, not per call, so the rows come back newest first
     * and the first one seen for a turn wins. A turn with no verdict is simply
     * absent from the result — which is how the caller tells "never judged" from
     * "judged `SAFE`".
     */
    latestVerdicts(turnIds: readonly string[]): Promise<ReadonlyMap<string, SafetyVerdict>>;
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