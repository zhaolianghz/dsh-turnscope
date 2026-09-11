/**
 * The shapes the attribution engine reads and returns.
 *
 * Attribution is a pure function of evidence, and these types are what keeps it
 * that way: every input is already-captured data, so the engine can be tested
 * against a hand-written scenario without a repository, a process, or a clock.
 * That is the property `docs/PRD.md §45` is asking for when it calls this the
 * testable core — the rules below are where a wrong answer is most expensive, so
 * they are the part that should be hardest to get wrong silently.
 */
import type {
  Attribution,
  CheckpointPathState,
  CheckpointRecord,
  FileChange,
  FileToolHint,
} from '../domain/types.ts'

/**
 * One checkpoint's record plus the paths it observed.
 *
 * The two live in separate tables, so the caller joins them. Keeping them apart
 * here as well means a caller can pass a checkpoint whose paths were filtered
 * (for a sub-view) without the engine inventing observations that were never
 * taken.
 */
export interface ObservedCheckpoint {
  readonly record: CheckpointRecord
  readonly paths: readonly CheckpointPathState[]
}

/**
 * Everything attribution is allowed to look at.
 *
 * `current` is optional and deliberately separate from `post`: it is a *later*
 * observation, taken when safety is evaluated, and its only job is to reveal
 * that the workspace moved after the turn ended (`docs/ARCHITECTURE.md §10.1`
 * Case C). Passing `post` as `current` is valid and simply means "nothing has
 * happened since".
 */
export interface AttributionInput {
  readonly pre: ObservedCheckpoint
  readonly post: ObservedCheckpoint
  readonly current?: ObservedCheckpoint
  /**
   * Paths tools appeared to touch, per `docs/ARCHITECTURE.md §8.1`.
   *
   * Evidence, never a verdict: a shell command, a formatter, or a lockfile
   * rewrite all change files without any tool naming them, so a hint can raise
   * confidence and can widen what is looked at, but it cannot by itself make a
   * path `AGENT`.
   */
  readonly hints: readonly FileToolHint[]
}

/** How many paths fell into each attribution, for a summary line in the UI. */
export interface AttributionSummary {
  readonly total: number
  readonly agent: number
  readonly baseline: number
  readonly drift: number
  readonly uncertain: number
}

/** One turn's attributed changes, `docs/ARCHITECTURE.md §9.2`. */
export interface TurnChangeSet {
  readonly turnId: string
  /** Sorted by path, so two runs over the same evidence print identically. */
  readonly changes: readonly FileChange[]
  readonly summary: AttributionSummary
}

/** The attribution values, ordered as the UI shows them. */
export const ATTRIBUTIONS: readonly Attribution[] = ['AGENT', 'BASELINE', 'DRIFT', 'UNCERTAIN']
