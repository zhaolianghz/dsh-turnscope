/**
 * Version stamped on every record this plugin persists.
 *
 * It is a literal type as well as a value so records can be narrowed on it.
 * Bump only alongside a storage migration in `src/storage`.
 */
export declare const SCHEMA_VERSION = 1;
/**
 * Lifecycle of a single turn.
 *
 * `pending` and `running` are the only non-terminal states; the other three are
 * absorbing, so a late event can never resurrect a finished turn.
 */
export type TurnStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
/** Category of a normalized event. */
export type EventKind = 'turn' | 'model' | 'tool' | 'command' | 'approval' | 'test' | 'error' | 'system';
/** Phase within an event's own lifecycle. */
export type EventPhase = 'started' | 'updated' | 'completed' | 'failed' | 'interrupted';
/** Which side of a turn a workspace checkpoint was taken. */
export type CheckpointPhase = 'pre' | 'post';
/**
 * Adapter output for one upstream Harness event, per `docs/ARCHITECTURE.md §3.1`.
 *
 * This is the versioned seam between the harness and everything that follows
 * it: the redactor, the assembler and the repository all consume this shape and
 * nothing upstream of it.
 */
export interface NormalizedEvent {
    readonly schemaVersion: typeof SCHEMA_VERSION;
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly activityId: string;
    readonly parentActivityId?: string;
    readonly kind: EventKind;
    readonly phase: EventPhase;
    /** ISO-8601 timestamp of the upstream event, not of normalization. */
    readonly occurredAt: string;
    /** Reference to a stored object; set once payload redaction has run. */
    readonly payloadRef?: string;
}
/** One turn, as persisted in the `turns` table. */
export interface TurnRecord {
    readonly schemaVersion: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly sessionId: string;
    /** Zero-based position of the turn within its session. */
    readonly ordinal: number;
    readonly status: TurnStatus;
    /** Epoch milliseconds. */
    readonly startedAt: number;
    /** Epoch milliseconds; absent until the turn reaches a terminal status. */
    readonly endedAt: number | undefined;
    readonly activityCount: number;
    readonly errorCount: number;
    readonly preCheckpointId?: string;
    readonly postCheckpointId?: string;
}
/** One activity within a turn, as persisted in the `activities` table. */
export interface ActivityRecord {
    readonly schemaVersion: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly turnId: string;
    readonly sessionId: string;
    /** Parent activity id when the activity nests, e.g. a tool call within a model step. */
    readonly parentId?: string;
    readonly kind: EventKind;
    readonly phase: EventPhase;
    /** Upstream sequence number; unique and monotonic per session. */
    readonly seq: number;
    /** Human-readable summary for the timeline. */
    readonly label: string;
    /** Epoch milliseconds. */
    readonly occurredAt: number;
    readonly payloadRef?: string;
    /** True when the stored payload was cut at `maxOutputBytes`. */
    readonly truncated?: boolean;
}
/** One git observation of a workspace around a turn, in the `checkpoints` table. */
export interface CheckpointRecord {
    readonly schemaVersion: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly workspaceId: string;
    readonly turnId: string;
    readonly phase: CheckpointPhase;
    /** Commit the worktree was at, when the repository was readable. */
    readonly headOid?: string;
    readonly branch?: string;
    /** True when the worktree had no pre-existing changes. */
    readonly cleanStart: boolean;
    readonly indexDigest?: string;
    readonly worktreeDigest?: string;
    /** Digest per changed path, keyed by repo-relative path. */
    readonly fileDigests?: Readonly<Record<string, string>>;
    /** Whether this checkpoint can be restored in place; never optimistic. */
    readonly restorable: boolean;
    /** Epoch milliseconds. */
    readonly createdAt: number;
    /** Why the checkpoint is not restorable, when it is not. */
    readonly failureReason?: string;
}
/**
 * One observed repository root, in the `workspaces` table.
 *
 * `repoRootHash` is the sha256 of the canonical root path so the record can be
 * keyed by a value that leaks nothing; `repoRoot` is kept only because the
 * operator-facing features need a display path.
 */
export interface WorkspaceRecord {
    readonly schemaVersion: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly repoRoot: string;
    readonly repoRootHash: string;
    /** JSON-encoded retention settings captured at first observation. */
    readonly settingsJson: string;
    /** Epoch milliseconds. */
    readonly createdAt: number;
}
/** One harness session, in the `sessions` table. */
export interface SessionRecord {
    readonly schemaVersion: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly workspaceId: string;
    /** Session id as issued by the harness, kept for correlation. */
    readonly upstreamSessionId: string;
    readonly parentSessionId?: string;
    /** Epoch milliseconds. */
    readonly createdAt: number;
}
/** Index entry for one immutable stored object, in the `objects` table. */
export interface ObjectRecord {
    readonly schemaVersion: typeof SCHEMA_VERSION;
    /** Content-addressed reference, e.g. `objects/ab/cdef…`. */
    readonly ref: string;
    readonly kind: string;
    readonly byteSize: number;
    readonly sha256: string;
    /** Epoch milliseconds. */
    readonly createdAt: number;
}
//# sourceMappingURL=types.d.ts.map