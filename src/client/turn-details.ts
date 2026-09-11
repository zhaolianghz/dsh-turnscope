/**
 * The detail of one turn, fetched when a reader asks for it.
 *
 * Separate from the session list because the two are asked at different times and
 * for different reasons (`docs/ARCHITECTURE.md §44.2`): the list is the screen,
 * and the detail is what a reader opens *after* deciding a turn is interesting.
 * Folding the detail into the list would ship every turn's activities, commands,
 * tests and changes to a panel that renders none of them.
 *
 * The fetched answer is kept, so collapsing a card and opening it again does not
 * re-ask; a refresh replaces it, because a refresh is the reader saying the
 * answers on screen may be older than the host.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { API_VERSION } from '../shared/contracts/api.ts'
import type { TurnDetailData } from '../shared/contracts/api.ts'
import type { TurnscopeHostApi } from './host-api.ts'

/**
 * What a card can say about a turn it opened.
 *
 * `missing` and `failed` are separate because the host distinguishes them: the
 * first is an answer ("I have no such turn"), the second is not an answer at all.
 * A reader told the first when the truth is the second goes looking for a turn
 * somebody deleted.
 */
export type TurnDetailState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly detail: TurnDetailData }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly reason: string }

export interface TurnDetailFeed {
  /** One entry per turn that has been opened at least once, in this generation. */
  readonly states: ReadonlyMap<string, TurnDetailState>
  /** Which cards are open. */
  readonly expanded: ReadonlySet<string>
  readonly toggle: (turnId: string) => void
}

/** One round of asking, so that a refresh can drop all of it at once. */
interface DetailCache {
  readonly generation: number
  readonly states: ReadonlyMap<string, TurnDetailState>
}

const NOTHING: ReadonlyMap<string, TurnDetailState> = new Map()

/**
 * Answer a card's detail, once per turn per generation.
 *
 * `generation` is the reader's refresh counter, and it is carried in the cache
 * rather than cleared by an effect: answers from an older generation are not
 * shown and not reused, so a refreshed list and a stale detail can never sit in
 * the same card. Keeping them in step is the same job `freshness.ts` does for the
 * list, and doing it in two different ways is how the two drift apart.
 *
 * Opening a card only records *intent*; the effect below turns intent into a
 * request. That is what keeps a request from being restarted by a re-render, and
 * what makes "opened but not yet answered" a state rather than a flag on a click.
 */
export function useTurnDetails(host: TurnscopeHostApi, generation: number): TurnDetailFeed {
  const [cache, setCache] = useState<DetailCache>({ generation, states: NOTHING })
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const states = cache.generation === generation ? cache.states : NOTHING

  // The generation a late answer belongs to. A plain effect rather than the
  // effect below's own cleanup, because that cleanup also runs when only the set
  // of open cards changed — and an answer arriving late for card A is still an
  // answer for card A.
  const live = useRef(generation)
  useEffect(() => {
    live.current = generation
    return () => {
      live.current = -1
    }
  }, [generation])

  const toggle = useCallback((turnId: string) => {
    setExpanded(current => {
      const next = new Set(current)
      if (next.delete(turnId)) return next
      next.add(turnId)
      return next
    })
  }, [])

  useEffect(() => {
    const pending = [...expanded].filter(turnId => !states.has(turnId))
    if (pending.length === 0) return
    // Claim the work before starting it, so the re-render this triggers does not
    // start it again.
    claim(setCache, generation, pending)
    for (const turnId of pending) {
      void host
        .getTurnDetail({ apiVersion: API_VERSION, turnId })
        .then(reply => {
          if (live.current !== generation) return
          settle(setCache, generation, turnId, read(reply))
        })
    }
  }, [host, expanded, states, generation])

  return { states, expanded, toggle }
}

const claim = (
  setCache: (update: (current: DetailCache) => DetailCache) => void,
  generation: number,
  turnIds: readonly string[],
): void => {
  setCache(current => {
    const next = new Map(current.generation === generation ? current.states : NOTHING)
    for (const turnId of turnIds) next.set(turnId, { kind: 'loading' })
    return { generation, states: next }
  })
}

const settle = (
  setCache: (update: (current: DetailCache) => DetailCache) => void,
  generation: number,
  turnId: string,
  state: TurnDetailState,
): void => {
  setCache(current => {
    const next = new Map(current.generation === generation ? current.states : NOTHING)
    next.set(turnId, state)
    return { generation, states: next }
  })
}

const read = (reply: Awaited<ReturnType<TurnscopeHostApi['getTurnDetail']>>): TurnDetailState => {
  switch (reply.kind) {
    case 'value':
      return { kind: 'loaded', detail: reply.value }
    case 'absent':
      return { kind: 'missing' }
    case 'unusable':
      return { kind: 'failed', reason: reply.detail }
  }
}
