/**
 * The shapes of the turn inspection pipeline.
 *
 * This module is the only place where the three parts meet: the observer
 * captures checkpoints, attribution decides who changed what, and safety decides
 * what may be offered. Each of those is pure or nearly so; the pipeline is where
 * they are given real evidence and where their output is persisted, so its types
 * are about *sequencing* — which observation is taken when, and which of them a
 * later re-evaluation is allowed to replace.
 *
 * The reason the seam is here and not inside the engines is
 * `docs/ARCHITECTURE.md §16`: a verdict is only valid for the instant its
 * `CURRENT` was taken. A pipeline that owned the verdict across time would be
 * caching something the document says must never be cached, so this layer
 * re-captures `CURRENT` every time it is asked for a verdict and lets the
 * engines recompute from stored evidence.
 */
import type { ObservedCheckpoint, TurnChangeSet } from '../attribution/types.ts'
import type { FileToolHint, SafetyVerdict, TurnRecord, TurnStatus } from '../domain/types.ts'
import type { GitPort } from '../git/git-port.ts'
import type { ObjectStore } from '../storage/object-store.ts'
import type { TraceRepository } from '../storage/repository.ts'

/**
 * The storage operations an inspection performs.
 *
 * Narrower than the whole repository but wider than {@link CheckpointSink}: the
 * pipeline reads back the checkpoints it wrote, because a re-evaluation has to
 * work from stored evidence rather than from whatever a previous call happened
 * to be holding in memory.
 */
export type InspectionSink = Pick<
  TraceRepository,
  | 'putCheckpoint'
  | 'putCheckpointPath'
  | 'putObjectRecord'
  | 'getCheckpoint'
  | 'listCheckpointPaths'
  | 'putFileChange'
  | 'putSafetyVerdict'
  | 'getLatestVerdict'
>

/** What an inspection needs from its environment. */
export interface InspectionDeps {
  readonly git: GitPort
  readonly store: ObjectStore
  readonly sink: InspectionSink
  /**
   * Files larger than this are fingerprinted but not copied; a checkpoint that
   * had to do that is `partial` rather than `complete`.
   */
  readonly maxBlobBytes: number
  /** Paths never observed, matched by exact path or directory prefix. */
  readonly ignorePaths: readonly string[]
  /**
   * The clock, injected.
   *
   * Timestamps end up in records a user reads and in the ordering of a
   * re-evaluation against the turn it belongs to, so a test has to be able to
   * pin them; and a pipeline that calls `Date.now()` internally cannot be asked
   * "what would this have produced at that moment".
   */
  readonly now?: () => number
}

/** Where a turn happened, resolved once per session by the caller. */
export interface TurnWorkspace {
  /** The stable workspace identity, per `docs/ARCHITECTURE.md §11.2`. */
  readonly workspaceId: string
  /** Symlink-resolved worktree root. */
  readonly repoRoot: string
}

/** What one call to {@link TurnInspector.inspect} found and decided. */
export interface InspectionResult {
  readonly turnId: string
  /** Absent when the turn could not be attributed at all — see `S001`/`S010`. */
  readonly changeSet: TurnChangeSet | undefined
  readonly verdict: SafetyVerdict
  /** The `CURRENT` observation the verdict was computed against. */
  readonly current: ObservedCheckpoint
  /** The `PRE` checkpoint, when one was recorded. */
  readonly pre: ObservedCheckpoint | undefined
  /** The `POST` checkpoint, when one was recorded. */
  readonly post: ObservedCheckpoint | undefined
}

/**
 * The turn-boundary pipeline.
 *
 * Every method resolves rather than rejects. The recorder's contract with the
 * harness is that observation can never fail the agent, and a checkpoint that
 * throws would do exactly that; a capture that cannot be completed records the
 * failure into the checkpoint itself, where the safety rules can then read it as
 * evidence instead of as silence.
 */
export interface TurnInspector {
  /**
   * React to one turn record the assembler just produced.
   *
   * The state machine of "was this a boundary" lives here rather than in the
   * caller, because it is a statement about observation: `PRE` is taken on the
   * way into a turn, `POST` on the way out, and a turn whose opening was never
   * seen has no `POST` to take. `previousStatus` is what the index held before
   * this record was written, which is the only way to tell a boundary from the
   * harness re-publishing a turn that has already ended.
   */
  observe(
    turn: TurnRecord,
    workspace: TurnWorkspace,
    previousStatus: TurnStatus | undefined,
  ): Promise<InspectionResult | undefined>
  /**
   * Re-read the stored evidence, take a fresh `CURRENT`, and judge again.
   *
   * This is the only correct way to answer "may I rewind this turn *now*": the
   * workspace moves between the turn ending and the user acting on it, and a
   * verdict computed at close time is a statement about close time
   * (`docs/ARCHITECTURE.md §16`).
   */
  inspect(
    turn: TurnRecord,
    workspace: TurnWorkspace,
    options?: { readonly hints?: readonly FileToolHint[] },
  ): Promise<InspectionResult | undefined>
  /** The verdict already on record, for a UI that opens before re-evaluating. */
  latestVerdict(turnId: string): Promise<SafetyVerdict | undefined>
}
