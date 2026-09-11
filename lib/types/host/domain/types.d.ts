/**
 * Version stamped on every record this plugin persists.
 *
 * It is a literal type as well as a value so records can be narrowed on it.
 * Bump only alongside a storage migration in `src/host/storage`.
 */
export declare const SCHEMA_VERSION = 3;
/**
 * Lifecycle of a single turn, per `docs/PRD.md §7.1`.
 *
 * `pending` and `running` are the only non-terminal states; the other five are
 * absorbing, so a late event can never resurrect a finished turn.
 *
 * `cancelled` and `output_limited` are distinct outcomes rather than flavours of
 * `failed`: a turn the user stopped and a turn the model ran out of room on both
 * describe *why* the turn ended, and the safety engine reads that difference.
 */
export type TurnStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'output_limited';
/**
 * How complete the evidence for a turn is, per `docs/ARCHITECTURE.md §7.2`.
 *
 * This is the honest answer to "could we decide safely about this turn?" and
 * safety rule S010 reads it directly: `missing` on a critical input yields
 * UNPROTECTED rather than a guess.
 */
export type EvidenceCompleteness = 'complete' | 'partial' | 'missing';
/** Category of a normalized event. */
export type EventKind = 'turn' | 'model' | 'tool' | 'command' | 'file' | 'approval' | 'test' | 'error' | 'system';
/** Phase within an event's own lifecycle. */
export type EventPhase = 'started' | 'updated' | 'completed' | 'failed' | 'interrupted';
/**
 * Which side of a turn a workspace checkpoint was taken, per
 * `docs/ARCHITECTURE.md §7.3`.
 *
 * `recovery_before` and `recovery_after` are declared now and written by nothing
 * in V0.1, which performs no workspace writes. They are declared because the
 * value is stored as TEXT in a versioned schema: admitting them later would force
 * a migration to relax a constraint, and a value nothing writes costs nothing.
 */
export type CheckpointPhase = 'pre' | 'post' | 'recovery_before' | 'recovery_after';
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
/**
 * One turn, as persisted in the `turns` table.
 *
 * **Timestamps are epoch milliseconds, not the ISO-8601 strings of
 * `docs/ARCHITECTURE.md §7.2`.** The columns are `INTEGER`, which SQLite can
 * sort and index directly and which costs half the bytes of the same instant
 * written out; the ISO form would buy readability in a file no user reads and
 * pay for it with a parse on every comparison. The wire-facing half of the API
 * converts at its own boundary. Every other field follows the document.
 */
export interface TurnRecord {
    readonly schemaVersion: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly sessionId: string;
    /** The repository this turn ran against; denormalized from its session. */
    readonly workspaceId: string;
    /** Zero-based position of the turn within its session. */
    readonly ordinal: number;
    readonly status: TurnStatus;
    /** Epoch milliseconds. */
    readonly startedAt: number;
    /** Epoch milliseconds; absent until the turn reaches a terminal status. */
    readonly endedAt: number | undefined;
    readonly activityCount: number;
    readonly errorCount: number;
    /** What the evidence for this turn is worth, per {@link EvidenceCompleteness}. */
    readonly evidenceCompleteness: EvidenceCompleteness;
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
/**
 * One git observation of a workspace around a turn, in the `checkpoints` table.
 *
 * A checkpoint is **not** a commit on the user's branch, and taking one never
 * writes to the repository (`docs/PRD.md §7.5`). It is this plugin's own record
 * of what the workspace looked like at one instant.
 */
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
    /**
     * Whether a merge, rebase, or cherry-pick was in progress at this instant.
     *
     * Recorded rather than inferred later: safety rule S007 needs to know the state
     * *at checkpoint time*, and a repository that has since been cleaned up would
     * otherwise look as though it always was.
     */
    readonly mergeInProgress: boolean;
    readonly rebaseInProgress: boolean;
    readonly cherryPickInProgress: boolean;
    readonly indexDigest?: string;
    readonly worktreeDigest?: string;
    /**
     * Digest per changed path, keyed by repo-relative path.
     *
     * The compact summary, kept alongside {@link CheckpointPathState} rather than
     * replaced by it: comparing two of these answers "did anything change" without
     * reading the per-path rows.
     */
    readonly fileDigests?: Readonly<Record<string, string>>;
    /**
     * What this observation is actually worth.
     *
     * Never optimistic: an observation that could not finish reports `partial` or
     * `failed` even when everything it did manage to read looks fine, because the
     * safety engine treats `complete` as a licence to decide.
     */
    readonly completeness: CheckpointCompleteness;
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
/** What one checkpoint's observation is worth. Mirrors {@link EvidenceCompleteness}. */
export type CheckpointCompleteness = 'complete' | 'partial' | 'failed';
/** One path's git status at checkpoint time, per `docs/ARCHITECTURE.md §7.4`. */
export type PathStatus = 'clean' | 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
/**
 * One path observed by a checkpoint, in the `checkpoint_paths` table.
 *
 * Only *relevant* paths get a row (`docs/ARCHITECTURE.md §12.2`): the ones
 * already dirty before the turn, the ones a tool hint names, and the ones that
 * changed during it. Copying an entire repository per turn is explicitly not the
 * design — a large repository would spend more time being observed than being
 * worked on.
 *
 * `blobRef` is deliberately absent for most rows. It is present only where the
 * bytes are needed to reconstruct the file, and those bytes are stored raw
 * rather than redacted, because a redacted snapshot cannot restore anything.
 */
export interface CheckpointPathState {
    readonly schemaVersion: typeof SCHEMA_VERSION;
    /** Stable id: this checkpoint's id plus the path. */
    readonly id: string;
    readonly checkpointId: string;
    /** Repo-relative, forward-slashed. */
    readonly path: string;
    readonly status: PathStatus;
    readonly staged: boolean;
    readonly binary: boolean;
    /** Where a rename came from; only set when `status` is `renamed`. */
    readonly previousPath?: string;
    readonly contentHash?: string;
    readonly mode?: string;
    /** Reference to the raw bytes in the object store, when they were captured. */
    readonly blobRef?: string;
}
/**
 * Who a change belongs to.
 *
 * The whole product rests on this distinction: `BASELINE` means the file was
 * already dirty when the turn began, and reporting that as `AGENT` is the one
 * error `docs/PRD.md §19.2` gives a zero tolerance to.
 */
export type Attribution = 'AGENT' | 'BASELINE' | 'DRIFT' | 'UNCERTAIN';
/** How much the evidence supports an attribution, per `docs/ARCHITECTURE.md §10.5`. */
export type AttributionConfidence = 'high' | 'medium' | 'low';
/** What happened to a path during a turn. */
export type FileChangeKind = 'created' | 'modified' | 'deleted' | 'renamed' | 'binary_changed';
/**
 * One path's change during a turn, in the `file_changes` table.
 *
 * `baseline` is an addition to the type in `docs/ARCHITECTURE.md §9.2`, which
 * has no field to carry it. It has to exist somewhere: §10.2 defines a file as
 * baseline when it was already dirty before the turn, §10.3 requires the turn's
 * delta to be taken against the *pre* state rather than `HEAD` precisely because
 * of that, and the golden scenario in §62 asserts a baseline file is reported
 * without being attributed to the agent. A reader of a `FileChange` cannot
 * recover that fact from `attribution` alone — a baseline file the agent then
 * edited is `AGENT` *for its delta*, and is still baseline.
 */
export interface FileChange {
    readonly schemaVersion: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly turnId: string;
    readonly path: string;
    readonly kind: FileChangeKind;
    readonly attribution: Attribution;
    readonly confidence: AttributionConfidence;
    /** True when the path was already dirty before this turn began (§10.2). */
    readonly baseline: boolean;
    readonly beforeHash?: string;
    readonly afterHash?: string;
    readonly currentHash?: string;
    /** Where a rename came from; only set when `kind` is `renamed`. */
    readonly previousPath?: string;
    /** Identifiers of the facts this attribution rests on, for the UI to cite. */
    readonly evidenceRefs: readonly string[];
}
/**
 * A path a tool appeared to touch, per `docs/ARCHITECTURE.md §8.1`.
 *
 * A hint, never the truth on its own. The agent can also change files through a
 * shell command, a formatter it ran, a package manager rewriting a lockfile, or
 * codegen — so this narrows where to look and never decides the attribution by
 * itself.
 */
export interface FileToolHint {
    readonly activityId: string;
    readonly path: string;
    readonly operation?: 'read' | 'write' | 'edit' | 'delete';
    /** Epoch milliseconds. */
    readonly occurredAt: number;
}
/** The four-level safety conclusion, ordered by severity in `src/host/safety`. */
export type SafetyLevel = 'SAFE' | 'CAUTION' | 'FORK_ONLY' | 'UNPROTECTED';
/** What the UI may offer for a turn. */
export type RecoveryAction = 'INSPECT' | 'PREVIEW_REWIND' | 'REWIND' | 'FORK' | 'NONE';
/** One specific, citable reason behind a verdict, per `docs/PRD.md FR-10`. */
export interface SafetyReason {
    /** Stable rule code, e.g. `S005_TARGET_FILE_DRIFT`. */
    readonly code: string;
    /** The severity this reason alone would impose. */
    readonly severity: SafetyLevel;
    readonly title: string;
    readonly detail: string;
    /** The path this reason is about, when it is about one. */
    readonly path?: string;
    readonly evidenceRefs: readonly string[];
}
/**
 * The safety conclusion for one turn, in the `safety_verdicts` table.
 *
 * `allowedActions` is computed separately from `level` rather than derived from
 * it: `docs/ARCHITECTURE.md §15` is explicit that FORK_ONLY and UNPROTECTED are
 * not points on one danger scale — the first has a usable historical baseline
 * and the second may not have a usable starting point at all.
 *
 * `currentStateHash` is what makes a preview honest. It fingerprints the
 * workspace state the verdict was computed against, so an apply can refuse a
 * confirmation the user gave before the workspace moved underneath it.
 */
export interface SafetyVerdict {
    readonly schemaVersion: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly turnId: string;
    readonly level: SafetyLevel;
    readonly reasons: readonly SafetyReason[];
    readonly allowedActions: readonly RecoveryAction[];
    readonly recommendedAction: RecoveryAction;
    /** Epoch milliseconds — when this verdict was computed, not when the turn ran. */
    readonly evaluatedAt: number;
    /** Bumped when a rule change could alter a verdict for unchanged input. */
    readonly engineVersion: number;
    readonly currentStateHash?: string;
}
/** One command a turn ran, in the `commands` table. */
export interface CommandRecord {
    readonly schemaVersion: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly turnId: string;
    readonly activityId?: string;
    /** The command as issued. Redacted before it is persisted. */
    readonly command: string;
    readonly exitCode?: number;
    readonly durationMs?: number;
    readonly outputRef?: string;
}
/** What kind of validation a command performed, per `docs/ARCHITECTURE.md §32`. */
export type ValidationKind = 'test' | 'typecheck' | 'lint' | 'build' | 'compile';
/** The outcome of a validation command, at the resolution V0.1 claims. */
export type ValidationStatus = 'passed' | 'failed' | 'unknown';
/** One validation command's result, in the `tests` table. */
export interface TestRecord {
    readonly schemaVersion: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly turnId: string;
    readonly commandId?: string;
    readonly kind: ValidationKind;
    readonly status: ValidationStatus;
    /** Short factual summary for the timeline; never a root-cause claim. */
    readonly summary: string;
}
//# sourceMappingURL=types.d.ts.map