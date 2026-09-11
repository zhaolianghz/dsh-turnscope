/**
 * The recorded turn list, as the view needs it.
 *
 * The distinction the view cares about is not "what did the host say" but "what
 * can I show". Every way of not getting a list — a transport failure, a host
 * speaking another contract version, a session the host never recorded — ends in
 * the same rendering decision, but not in the same *sentence*: the first two are
 * about this page's ability to talk to that host, and a user who is told "no
 * turn was recorded" when the truth is "this bundle is older than that host"
 * will go looking in the wrong place. So the reason is carried, not swallowed.
 */
import { useEffect, useState } from 'react'
import { API_VERSION, TURN_PAGE_LIMIT } from '../shared/contracts/api.ts'
import type { SafetySummaryDto, TurnSummaryDto } from '../shared/contracts/api.ts'
import type { TurnscopeHostApi } from './host-api.ts'

/** What the view hangs off a turn number, and what to say when there is none. */
export interface RecordedTurns {
  /** Keyed by `ordinal`, which is the number the conversation also counts in. */
  readonly safety: ReadonlyMap<number, SafetySummaryDto>
  /** Absent when the host answered. Explanatory, never technical, when it did not. */
  readonly problem?: string
}

/**
 * Ask the host once per session, and again if the session changes.
 *
 * `undefined` while the answer is in flight, so the view renders what it already
 * knows rather than an empty frame that would then fill in — a shift from "no
 * safety information" to "safety information" is worse than a moment of neither.
 */
export function useRecordedTurns(
  host: TurnscopeHostApi,
  sessionId: string,
): RecordedTurns | undefined {
  const [recorded, setRecorded] = useState<RecordedTurns | undefined>(undefined)

  useEffect(() => {
    let live = true
    setRecorded(undefined)
    void host
      .listTurns({ apiVersion: API_VERSION, sessionId, limit: TURN_PAGE_LIMIT.default })
      .then(answer => {
        // A session switch or an unmount during the round trip must not write
        // the previous session's verdicts onto the new one.
        if (live) setRecorded(read(answer))
      })
    return () => {
      live = false
    }
  }, [host, sessionId])

  return recorded
}

const read = (answer: Awaited<ReturnType<TurnscopeHostApi['listTurns']>>): RecordedTurns => {
  switch (answer.kind) {
    case 'value':
      return { safety: safetyOf(answer.value.turns) }
    // Only reachable for a reply whose `data` is `null`, which this endpoint
    // never sends: an empty session is `{ turns: [] }`. Reading it as "nothing
    // recorded yet" is the right accident.
    case 'absent':
      return { safety: new Map() }
    case 'unusable':
      return { safety: new Map(), problem: answer.detail }
  }
}

/**
 * Index the verdicts by turn number.
 *
 * A turn with no verdict is left out rather than defaulted to `SAFE`. "Nobody
 * judged this turn" and "this turn was judged safe" are different claims, and
 * only one of them is worth putting next to a one-click recovery button — which
 * is what the next version of this panel grows.
 */
const safetyOf = (turns: readonly TurnSummaryDto[]): ReadonlyMap<number, SafetySummaryDto> =>
  new Map(
    turns.flatMap(turn => (turn.safety === undefined ? [] : [[turn.ordinal, turn.safety] as const])),
  )
