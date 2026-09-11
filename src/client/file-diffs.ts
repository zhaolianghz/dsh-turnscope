/**
 * One path's diff, fetched when a reader clicks it.
 *
 * A diff is the largest thing this panel can ask for and the least often wanted —
 * a reader looks at the files that explain the verdict, not at all of them — so
 * it is asked for per path, on the click, and never bundled into the turn detail
 * (`docs/ARCHITECTURE.md §44.2`, `§28.3`).
 *
 * One selection at a time, deliberately. Two open diffs would be two scrolling
 * panes in a side panel, and the comparison a reader actually makes is between a
 * diff and the verdict above it, not between two files.
 */
import { useCallback, useState } from 'react'
import { API_VERSION } from '../shared/contracts/api.ts'
import type { GetDiffData, ReplyRead } from '../shared/contracts/api.ts'
import type { TurnscopeHostApi } from './host-api.ts'
import { useRemoteAnswers, type Answer } from './remote-answers.ts'

export type FileDiffState = Answer<GetDiffData['diff']>

/** A path inside a turn, as one key: a path cannot contain a NUL. */
export const diffKey = (turnId: string, path: string): string => `${turnId}\u0000${path}`

export interface FileDiffFeed {
  readonly states: ReadonlyMap<string, FileDiffState>
  /** The open diff, by `diffKey`. Absent when nothing is open. */
  readonly selected: string | undefined
  readonly select: (turnId: string, path: string) => void
}

export function useFileDiffs(host: TurnscopeHostApi, generation: number): FileDiffFeed {
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const ask = useCallback(
    async (key: string): Promise<ReplyRead<GetDiffData['diff']>> => {
      // The key is split back into the request here rather than carried around as
      // a pair: the selection is one value, and a request assembled from a value
      // the reader selected cannot drift from the value that is displayed.
      const [turnId = '', path = ''] = key.split('\u0000')
      const reply = await host.getDiff({ apiVersion: API_VERSION, turnId, path })
      // Unwrapped here so the state is "a diff", not "an answer that contains a
      // diff": the envelope is a property of the transport, and nothing above this
      // line should have to know it has a wrapper.
      switch (reply.kind) {
        case 'value':
          return { kind: 'value', value: reply.value.diff }
        case 'absent':
          return { kind: 'absent' }
        case 'unusable':
          return { kind: 'unusable', detail: reply.detail }
      }
    },
    [host],
  )
  const states = useRemoteAnswers(ask, selected === undefined ? [] : [selected], generation)

  const select = useCallback((turnId: string, path: string) => {
    const key = diffKey(turnId, path)
    // Clicking the open path closes it. Same answer as before, so nothing is
    // refetched: `useRemoteAnswers` only asks for keys it has no entry for.
    setSelected(current => (current === key ? undefined : key))
  }, [])

  return { states, selected, select }
}
