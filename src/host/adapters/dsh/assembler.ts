import { SCHEMA_VERSION } from '../../domain/types.ts'
import type { ActivityRecord, TurnRecord, TurnStatus } from '../../domain/types.ts'
import { isTerminal, transitionTurn } from '../../domain/turn-state.ts'
import { turnIdFor } from '../../domain/ids.ts'
import type { NormalizedActivity } from './normalize.ts'
import { UNATTRIBUTED_TURN, unattributedTurnId } from './normalize.ts'

/**
 * How many not-yet-placeable events the assembler holds.
 *
 * Bounded because the buffer is only ever a hand-off delay for events whose
 * `turn/start` is a few milliseconds behind them. An unbounded buffer would
 * turn a session whose turns never open — a plugin that publishes events under
 * an unknown turn number, a malformed upstream — into a memory leak, and a
 * leak in the recorder is a leak in the harness process.
 */
export const BUFFER_CEILING = 256

// `isTerminal` comes from the domain rather than being re-derived here. A second
// copy of the terminal set is a second thing to forget to update: this module
// absorbed turns on a three-name list, and adding `cancelled` and
// `output_limited` to the domain would silently not have reached it.

/** The records one ingested event asks the caller to persist. */
export interface AssemblerOutput {
  /** Turns whose row changed; at most one per event, plus none for a buffered one. */
  readonly turns: readonly TurnRecord[]
  /** Activities to append, in the order they were observed. */
  readonly activities: readonly ActivityRecord[]
  /** True when the event contributed nothing and could not be deferred either. */
  readonly ignored: boolean
  /** Events shed by this call because the buffer was full. */
  readonly dropped: number
}

export interface TurnAssembler {
  /**
   * Fold one normalized event into the turn state and hand back the records to
   * persist. `undefined` — an upstream type this build does not recognise —
   * is an ignored event, not an error.
   */
  ingest(event: NormalizedActivity | undefined): AssemblerOutput
  /** How many events are held for a turn that has not opened yet. */
  pendingCount(): number
}

/** The mutable in-memory state of one turn, projected to a {@link TurnRecord}. */
interface TurnMoment {
  readonly id: string
  readonly sessionId: string
  readonly workspaceId: string
  readonly ordinal: number
  status: TurnStatus
  readonly startedAt: number
  endedAt: number | undefined
  activityCount: number
  errorCount: number
}

/** One event waiting for its turn to open. */
interface Deferred {
  readonly turnId: string
  readonly event: NormalizedActivity
}

const EMPTY: AssemblerOutput = Object.freeze({
  turns: Object.freeze([]),
  activities: Object.freeze([]),
  ignored: true,
  dropped: 0,
})

/**
 * Build a turn assembler: the state machine that turns a stream of normalized
 * events into turn and activity records.
 *
 * Holds only in-memory state and performs no I/O — nothing here awaits, reads
 * or writes — which is what makes the whole state machine testable without a
 * database, and what keeps a slow disk off the harness's synchronous emit path.
 *
 * It is also the layer that *owns* the transition graph rather than merely
 * absorbing post-terminal updates: `transitionTurn` is deliberately permissive
 * (`pending → failed` is allowed there), so this is where the diagram of
 * `docs/ARCHITECTURE.md §3.3` is actually decided. It emits `running` only for
 * a `turn/start` and a terminal status only for a `turn/end`, and never
 * downgrades a turn it has already finished — the same guard `TraceRepository`
 * cannot apply in SQL without discarding the count fields this layer updates.
 */
export function createTurnAssembler(): TurnAssembler {
  /** Every turn this process has seen, keyed by turn id. */
  const turns = new Map<string, TurnMoment>()
  /** The turn currently open per session, so unattributed events can be placed. */
  const openTurns = new Map<string, number>()
  /** FIFO of events waiting for a turn that has not opened; oldest first. */
  let deferred: Deferred[] = []

  const activityOf = (event: NormalizedActivity, turnId: string): ActivityRecord => ({
    schemaVersion: SCHEMA_VERSION,
    id: event.activityId,
    turnId,
    sessionId: event.sessionId,
    kind: event.kind,
    phase: event.phase,
    seq: event.seq,
    label: event.label,
    occurredAt: Date.parse(event.occurredAt),
    ...(event.payloadRef === undefined ? {} : { payloadRef: event.payloadRef }),
    // `truncated` is absent rather than `false`: the repository maps a `0`
    // column back to an absent property, and a record written with an explicit
    // `false` would not compare equal to the row it reads back as.
    ...(event.payload?.truncated === true ? { truncated: true } : {}),
  })

  const recordOf = (moment: TurnMoment): TurnRecord => ({
    schemaVersion: SCHEMA_VERSION,
    id: moment.id,
    sessionId: moment.sessionId,
    workspaceId: moment.workspaceId,
    ordinal: moment.ordinal,
    status: moment.status,
    startedAt: moment.startedAt,
    endedAt: moment.endedAt,
    activityCount: moment.activityCount,
    errorCount: moment.errorCount,
    // A placeholder. Only an observation of the workspace can say what a turn's
    // evidence is worth, and that happens after the fact; `upsertTurn` is
    // deliberately built not to overwrite what that observation decides.
    evidenceCompleteness: 'missing',
  })

  /** The status an event would apply to its turn, or `undefined` for neither. */
  const requestedStatus = (event: NormalizedActivity): TurnStatus | undefined => {
    if (event.kind !== 'turn') return undefined
    switch (event.phase) {
      case 'started':
        return 'running'
      case 'completed':
      case 'failed':
      case 'interrupted':
        return event.phase
      default:
        return undefined
    }
  }

  /** Place an event by its turn id, resolving the unattributed sentinel. */
  const targetTurnId = (event: NormalizedActivity): string | undefined => {
    if (event.turnId !== unattributedTurnId(event.sessionId)) return event.turnId
    // A message with no turn of its own belongs to the turn the harness has
    // open — the turn that claimed it. With no open turn there is nothing to
    // attribute it to, and inventing one would be worse than ignoring it.
    const open = openTurns.get(event.sessionId)
    return open === undefined ? undefined : turnIdFor(event.sessionId, open)
  }

  const buffer = (turnId: string, event: NormalizedActivity): AssemblerOutput => {
    deferred.push({ turnId, event })
    let dropped = 0
    while (deferred.length > BUFFER_CEILING) {
      deferred.shift()
      dropped += 1
    }
    return {
      turns: Object.freeze([]),
      activities: Object.freeze([]),
      ignored: false,
      dropped,
    }
  }

  /** Remove and return the deferred events of one turn, oldest first. */
  const drain = (turnId: string): readonly NormalizedActivity[] => {
    const kept: Deferred[] = []
    const taken: NormalizedActivity[] = []
    for (const entry of deferred) {
      if (entry.turnId === turnId) taken.push(entry.event)
      else kept.push(entry)
    }
    deferred = kept
    return taken
  }

  const ingest = (event: NormalizedActivity | undefined): AssemblerOutput => {
    if (event === undefined) return EMPTY

    const turnId = targetTurnId(event)
    if (turnId === undefined) return EMPTY

    const requested = requestedStatus(event)
    let moment = turns.get(turnId)
    if (moment === undefined && requested === undefined) return buffer(turnId, event)

    if (moment === undefined) {
      moment = {
        id: turnId,
        sessionId: event.sessionId,
        workspaceId: event.workspaceId,
        ordinal: event.turn ?? UNATTRIBUTED_TURN,
        status: 'pending',
        startedAt: Date.parse(event.occurredAt),
        endedAt: undefined,
        activityCount: 0,
        errorCount: 0,
      }
      turns.set(turnId, moment)
    }

    if (requested !== undefined) {
      const wasTerminal = isTerminal(moment.status)
      // The transition graph lives here: a closed turn absorbs every later
      // status, so a late or replayed `turn/start` cannot reopen it.
      const applied = transitionTurn(moment.status, requested)
      moment.status = applied
      if (!wasTerminal && isTerminal(applied)) {
        // The first end is the real one; a late end must not move the timestamp.
        moment.endedAt = Date.parse(event.occurredAt)
        if (openTurns.get(event.sessionId) === moment.ordinal) {
          openTurns.delete(event.sessionId)
        }
      } else if (requested === 'running' && !isTerminal(applied)) {
        openTurns.set(event.sessionId, moment.ordinal)
      }
    }

    // Deferred events were observed earlier, so they are emitted first; the
    // activity table orders by `seq` regardless, which makes the order here
    // the arrival order rather than a claim about the upstream sequence.
    const activities: ActivityRecord[] = drain(turnId).map(entry => activityOf(entry, turnId))
    activities.push(activityOf(event, turnId))

    for (const activity of activities) {
      moment.activityCount += 1
      if (activity.phase === 'failed') moment.errorCount += 1
    }

    return {
      turns: Object.freeze([recordOf(moment)]),
      activities: Object.freeze(activities),
      ignored: false,
      dropped: 0,
    }
  }

  return {
    ingest,
    pendingCount: () => deferred.length,
  }
}
