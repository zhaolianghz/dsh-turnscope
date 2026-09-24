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
 *
 * The whole host row is carried rather than just its verdict, because the row is
 * where "how many files did this turn change" and "how complete is its evidence"
 * live, and those belong on the same card as the badge: a verdict shown without
 * the evidence it rests on can be read as more certain than it is.
 */
import { useEffect, useState } from 'react'
import { API_VERSION, TURN_PAGE_LIMIT } from '../shared/contracts/api.ts'
import type { TurnSummaryDto } from '../shared/contracts/api.ts'
import type { TurnscopeHostApi } from './host-api.ts'

/** What the host has recorded for this session, keyed by turn number. */
export interface RecordedTurns {
  /** Keyed by `ordinal`, which is the number the conversation also counts in. */
  readonly turns: ReadonlyMap<number, TurnSummaryDto>
  /** Absent when the host answered. Explanatory, never technical, when it did not. */
  readonly problem?: string
}

export interface RecordedTurnsFeed {
  /** Absent until the first answer for *this* session has arrived. */
  readonly state: RecordedTurns | undefined
}

/**
 * Ask the host once per session, and again when asked.
 *
 * The answer is stored with the session it belongs to rather than cleared when
 * the session changes. Two things fall out of that: a swap to another session
 * shows nothing until its own answer lands — the old rows are for a different
 * conversation and their turn numbers mean nothing here — while a **refresh**
 * keeps the badges that are already on screen instead of blinking them out and
 * back for a turn that did not change.
 *
 * `undefined` while the first answer is in flight, so the view renders what it
 * already knows rather than an empty frame that would then fill in — a shift from
 * "no safety information" to "safety information" is worse than a moment of
 * neither.
 *
 * `generation` is the caller's refresh counter: bumping it asks again, and it is
 * owned by the container rather than by this hook because a refresh also has to
 * retire the cached turn details. One counter, so the list and the details are
 * always answers to the same round of asking.
 */
export function useRecordedTurns(
  host: TurnscopeHostApi,
  sessionId: string,
  generation: number,
): RecordedTurnsFeed {
  const [answer, setAnswer] = useState<{ sessionId: string; recorded: RecordedTurns } | undefined>(undefined)

  useEffect(() => {
    let live = true
    void (async () => {
      const rows: TurnSummaryDto[] = []
      const seen = new Set<number>()
      let cursor: number | undefined
      while (live) {
        const reply = await host.listTurns({
          apiVersion: API_VERSION, sessionId, limit: TURN_PAGE_LIMIT.default,
          ...(cursor === undefined ? {} : { cursor }),
        })
        if (!live) return
        if (reply.kind !== 'value') {
          setAnswer({ sessionId, recorded: rows.length === 0
            ? read(reply)
            : { turns: byOrdinal(rows), ...(reply.kind === 'unusable' ? { problem: reply.detail } : {}) },
          })
          return
        }
        rows.push(...reply.value.turns)
        // Publish each page as it arrives so a long session can show its newest
        // verdicts while older pages are still being fetched.
        setAnswer({ sessionId, recorded: { turns: byOrdinal(rows) } })
        const next = reply.value.nextCursor
        if (next === undefined) {
        // A session switch or an unmount during the round trip must not write the
        // previous session's verdicts onto the new one. The session is captured
        // here as well as read at render time, so a late answer is discarded
        // rather than kept as a fact about the wrong conversation.
          return
        }
        if (seen.has(next)) {
          setAnswer({ sessionId, recorded: { turns: byOrdinal(rows), problem: 'host repeated a page cursor' } })
          return
        }
        seen.add(next)
        cursor = next
      }
    })()
    return () => {
      live = false
    }
  }, [host, sessionId, generation])

  const recorded = answer !== undefined && answer.sessionId === sessionId ? answer.recorded : undefined
  return { state: recorded }
}

const read = (answer: Awaited<ReturnType<TurnscopeHostApi['listTurns']>>): RecordedTurns => {
  switch (answer.kind) {
    case 'value':
      return { turns: byOrdinal(answer.value.turns) }
    // Only reachable for a reply whose `data` is `null`, which this endpoint
    // never sends: an empty session is `{ turns: [] }`. Reading it as "nothing
    // recorded yet" is the right accident.
    case 'absent':
      return { turns: new Map() }
    case 'unusable':
      return { turns: new Map(), problem: answer.detail }
  }
}

/**
 * Index the rows by turn number.
 *
 * A turn with no row is left out rather than given a default verdict. "Nobody
 * judged this turn" and "this turn was judged safe" are different claims, and
 * only one of them is worth putting next to a one-click recovery button — which
 * is what the next version of this panel grows.
 */
const byOrdinal = (turns: readonly TurnSummaryDto[]): ReadonlyMap<number, TurnSummaryDto> =>
  new Map(turns.map(turn => [turn.ordinal, turn] as const))
