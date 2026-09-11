/**
 * The turn-boundary pipeline: capture, attribute, judge, persist.
 *
 * The three engines it composes are deliberately ignorant of each other. This is
 * the module that orders them and, more importantly, the module that decides
 * *when* each observation is taken, because that decision is the one the engines
 * cannot check. A verdict is a statement about a `CURRENT` that was true at a
 * moment (`docs/ARCHITECTURE.md §16`), so the moment has to be owned by exactly
 * one place, and this is it.
 *
 * Two observations are taken per turn and one is taken per question:
 *
 * - `PRE`, when the turn is first seen running. Taken then and only then,
 *   because a "before" state that is captured after the fact is not a before
 *   state.
 * - `POST`, on the transition into a terminal status. Taken once per transition
 *   rather than once per terminal event, because the harness re-publishes a
 *   finished turn on every later activity and re-capturing would overwrite the
 *   end of the turn with the state that followed it.
 * - `CURRENT`, every time a verdict is produced. Never reused, because
 *   `docs/ARCHITECTURE.md §16` forbids caching it and because the whole point of
 *   the drift rules is to notice that it moved.
 *
 * A turn that was already terminal the first time it was seen never gets a
 * `POST`. The plugin loads into a session that may have been running for hours,
 * so this is ordinary rather than exceptional — and writing a `POST` for it
 * would claim we watched it end when we did not. Missing `PRE` and `POST` both
 * reach the user as `UNPROTECTED`, which is what they mean.
 *
 * Everything here fails soft. A missing `PRE` is not an error — it is the fact
 * that makes `S001` fire, and it has to reach the user as `UNPROTECTED` rather
 * than as a stack trace in the harness log.
 */
import { applyCurrentState, attributeChanges, summarizeChanges } from '../attribution/engine.ts'
import type { ObservedCheckpoint, TurnChangeSet } from '../attribution/types.ts'
import { checkpointIdFor, safetyVerdictIdFor } from '../domain/ids.ts'
import { isTerminal } from '../domain/turn-state.ts'
import type { FileToolHint, SafetyVerdict, TurnRecord } from '../domain/types.ts'
import { captureCheckpoint } from '../git/checkpoint.ts'
import { evaluateSafety, toSafetyVerdict } from '../safety/engine.ts'
import type { InspectionDeps, InspectionResult, TurnInspector, TurnWorkspace } from './types.ts'

/** The phase each observation is recorded under. */
const PHASE = {
  PRE: 'pre',
  POST: 'post',
  /**
   * `CURRENT` shares the `recovery_before` phase with the checkpoint V0.2 will
   * take immediately before it rewinds anything. That is not a collision: both
   * mean "the workspace as it is at the instant we are about to act on it", so
   * re-taking `CURRENT` and then starting a recovery must land on one record
   * rather than two that disagree.
   */
  CURRENT: 'recovery_before',
} as const

/**
 * Build the pipeline.
 *
 * The returned inspector is safe to call concurrently but is not a
 * synchronization primitive: the recorder drives it from a single ordered queue
 * per session, and that is where mutual exclusion lives. Duplicating the queue
 * here would hide a recorder bug rather than fix one.
 */
export function createTurnInspector(deps: InspectionDeps): TurnInspector {
  const { git, store, sink, maxBlobBytes, ignorePaths } = deps
  const clock = deps.now ?? Date.now

  /** Capture one checkpoint and persist it through the checkpoint sink. */
  const capture = (
    turn: TurnRecord,
    workspace: TurnWorkspace,
    phase: 'pre' | 'post' | 'recovery_before',
    hints: readonly string[],
  ): Promise<ObservedCheckpoint> =>
    captureCheckpoint(
      { git, store, sink, maxBlobBytes, ignorePaths },
      {
        workspaceId: workspace.workspaceId,
        repoRoot: workspace.repoRoot,
        turnId: turn.id,
        phase,
        ...(hints.length === 0 ? {} : { hintedPaths: hints }),
        now: clock(),
      },
    )

  /**
   * Read a checkpoint back out of storage, with its paths.
   *
   * Re-reading rather than reusing the value the caller just captured is what
   * makes a re-evaluation reproducible: the verdict is a function of what is
   * stored, so a second `inspect()` at the same moment produces the same
   * answer, and a restart produces it too.
   */
  const readCheckpoint = async (
    turnId: string,
    phase: 'pre' | 'post',
  ): Promise<ObservedCheckpoint | undefined> => {
    const id = checkpointIdFor(turnId, phase)
    const record = await sink.getCheckpoint(id)
    if (record === undefined) return undefined
    return { record, paths: await sink.listCheckpointPaths(id) }
  }

  /**
   * Read the change set back out of storage, with its current state renewed.
   *
   * Rows come back sorted by path, which is the order the engine writes them in,
   * so a rebuilt change set is indistinguishable from a freshly attributed one.
   * The summary is recounted from the rows rather than trusted to have been kept
   * in step with them.
   *
   * Nothing is written here. {@link evaluate} owns persisting whatever this
   * returns, so the two ways a change set can be produced cannot drift apart in
   * whether they are recorded.
   */
  const readChangeSet = async (
    turnId: string,
    current: ObservedCheckpoint,
  ): Promise<TurnChangeSet | undefined> => {
    const stored = await sink.listFileChanges(turnId)
    if (stored.length === 0) return undefined
    const changes = stored.map(change => applyCurrentState(change, current))
    return { turnId, changes, summary: summarizeChanges(changes) }
  }

  /**
   * Take a fresh `CURRENT`, decide who changed what, and judge.
   *
   * The two public entry points differ only in where the change set comes from,
   * and that is exactly the difference the parameter carries: a writer for
   * `inspect`, which attributes from the checkpoints that are stored, and a
   * reader for `refresh`, which renews the rows it already has. `CURRENT` is
   * taken first and unconditionally, before either of them runs, so that a
   * failure in anything later still leaves on record the observation that was
   * the whole reason for asking.
   *
   * `CURRENT` being available to the resolver is what lets `refresh` renew the
   * one field of a change that is a statement about now; the recorded
   * checkpoints are handed over too, because a resolver is allowed to ignore
   * them but not to be unable to see them.
   */
  const evaluate = async (
    turn: TurnRecord,
    workspace: TurnWorkspace,
    resolveChangeSet: (observed: {
      readonly pre: ObservedCheckpoint | undefined
      readonly post: ObservedCheckpoint | undefined
      readonly current: ObservedCheckpoint
    }) => TurnChangeSet | undefined | Promise<TurnChangeSet | undefined>,
    hintPaths: readonly string[],
  ): Promise<InspectionResult> => {
    const current = await capture(turn, workspace, PHASE.CURRENT, hintPaths)

    const [pre, post] = await Promise.all([
      readCheckpoint(turn.id, PHASE.PRE),
      readCheckpoint(turn.id, PHASE.POST),
    ])

    const changeSet = await resolveChangeSet({ pre, post, current })
    if (changeSet !== undefined) {
      // Ids are derived in the engine from the turn and the path, so a
      // re-evaluation rewrites the same rows instead of appending a second
      // opinion about the same file.
      for (const change of changeSet.changes) await sink.putFileChange(change)
    }

    const input = { turn, pre, post, current, changeSet, now: clock() }
    const verdict = toSafetyVerdict(input, evaluateSafety(input))
    await sink.putSafetyVerdict({ ...verdict, id: safetyVerdictIdFor(turn.id) })

    return { turnId: turn.id, changeSet, verdict, current, pre, post }
  }

  /**
   * Attribute from the checkpoints that are stored, citing the hints.
   *
   * Hints become paths *and* evidence, which is the whole point of
   * `docs/ARCHITECTURE.md §8.1`: naming a path in a hint makes it worth
   * observing even when `git status` says it is clean, and the hint's activity
   * id is then cited on the resulting change. A hint is never allowed to
   * decide the attribution by itself.
   *
   * Attribution needs both ends, and both are read here rather than inside the
   * resolver because a missing end is the *fact* that `S001`/`S002`/`S010`
   * report: inventing `UNCERTAIN` per path would bury it under a list of
   * guesses about a turn that was never observed at all.
   */
  const inspect = (
    turn: TurnRecord,
    workspace: TurnWorkspace,
    hints: readonly FileToolHint[],
  ): Promise<InspectionResult> =>
    evaluate(
      turn,
      workspace,
      ({ pre, post, current }) =>
        pre === undefined || post === undefined
          ? undefined
          : attributeChanges({ pre, post, current, hints }),
      hints.map(hint => hint.path),
    )

  return {
    observe: async (turn, workspace, previousStatus) => {
      const wasRunning = previousStatus !== undefined && !isTerminal(previousStatus)
      const opensNow = previousStatus === undefined && !isTerminal(turn.status)

      if (opensNow) {
        // Nothing is attributed here: at this point the turn has not happened,
        // so there is no question about who changed what to answer.
        await capture(turn, workspace, PHASE.PRE, [])
        return undefined
      }

      if (!wasRunning || !isTerminal(turn.status)) {
        // Neither an opening nor a closing: a mid-turn record, or the harness
        // re-publishing a turn that already ended. Re-capturing `POST` here
        // would replace the end of the turn with the state after it.
        return undefined
      }

      await capture(turn, workspace, PHASE.POST, [])
      // Attribution takes its own `CURRENT` a moment later. Skipping that second
      // capture would be cheaper and would make the first verdict a claim about
      // the end of the turn rather than about the workspace the user is looking
      // at — and the drift rules exist precisely because those two can differ
      // before anyone asks.
      return inspect(turn, workspace, [])
    },

    inspect: (turn, workspace, options) => inspect(turn, workspace, options?.hints ?? []),

    refresh: (turn, workspace) =>
      evaluate(turn, workspace, ({ current }) => readChangeSet(turn.id, current), []),

    latestVerdict: (turnId: string): Promise<SafetyVerdict | undefined> =>
      sink.getLatestVerdict(turnId),
  }
}
