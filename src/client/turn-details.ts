/**
 * The detail of one turn, fetched when a reader asks for it.
 *
 * Separate from the session list because the two are asked at different times and
 * for different reasons (`docs/ARCHITECTURE.md §44.2`): the list is the screen,
 * and the detail is what a reader opens *after* deciding a turn is interesting.
 * Folding the detail into the list would ship every turn's activities, commands,
 * tests and changes to a panel that renders none of them.
 *
 * Opening a card only records *intent*; `useRemoteAnswers` turns intent into a
 * request. That is what keeps a request from being restarted by a re-render, and
 * what makes "opened but not yet answered" a state rather than a flag on a click.
 */
import { useCallback, useState } from 'react'
import { API_VERSION } from '../shared/contracts/api.ts'
import type { TurnDetailData } from '../shared/contracts/api.ts'
import type { TurnscopeHostApi } from './host-api.ts'
import { useRemoteAnswers, type Answer } from './remote-answers.ts'

/** What a card can say about a turn it opened. */
export type TurnDetailState = Answer<TurnDetailData>

export interface TurnDetailFeed {
  /** One entry per turn that has been opened at least once, in this generation. */
  readonly states: ReadonlyMap<string, TurnDetailState>
  /** Which cards are open. */
  readonly expanded: ReadonlySet<string>
  readonly toggle: (turnId: string) => void
}

export function useTurnDetails(host: TurnscopeHostApi, generation: number): TurnDetailFeed {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const ask = useCallback(
    (turnId: string) => host.getTurnDetail({ apiVersion: API_VERSION, turnId }),
    [host],
  )
  const states = useRemoteAnswers(ask, [...expanded], generation)

  const toggle = useCallback((turnId: string) => {
    setExpanded(current => {
      const next = new Set(current)
      // Collapsing keeps the answer: a card that is reopened re-renders what was
      // already fetched instead of blinking through `loading` again.
      if (next.delete(turnId)) return next
      next.add(turnId)
      return next
    })
  }, [])

  return { states, expanded, toggle }
}
