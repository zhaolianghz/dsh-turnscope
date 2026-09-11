/**
 * Ask the host for a bounded set of things, and keep the answers.
 *
 * The panel has two of these — a turn's detail, and one path's diff — and they
 * have the same four interesting properties, which is why they are one piece of
 * code rather than two. Both are asked for *on demand* rather than with the list
 * (`docs/ARCHITECTURE.md §44.2`); both are asked once per key per round of
 * asking; both keep the answer so that closing and reopening does not re-ask; and
 * both must treat an answer that arrives after a refresh as belonging to the
 * previous round, not to this one.
 *
 * The caller supplies the *wanted* keys and the way to ask for one; the hook
 * decides when a wanted key needs a round trip. That split is what makes opening something a
 * state rather than an event: a re-render cannot restart a request, and a request
 * in flight is visible as `loading` to anyone who asks for that key.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReplyRead } from '../shared/contracts/api.ts'

/**
 * What is known about one asked-for key.
 *
 * `absent` and `failed` are deliberately separate: the first is the host's answer
 * ("I have nothing under that key"), the second is the absence of an answer. A
 * reader shown the first when the truth is the second goes looking for something
 * that was deleted.
 */
export type Answer<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly reason: string }

/** One round of asking, so that a refresh can retire all of it at once. */
interface Cache<T> {
  readonly generation: number
  readonly entries: ReadonlyMap<string, Answer<T>>
}

const NOTHING = new Map<never, never>()

/**
 * The keys, as one string an effect can depend on.
 *
 * A key is a host-generated id or a repo-relative path, and a path cannot contain
 * a NUL — git's own formats are NUL-delimited for exactly that reason — so joining
 * on one cannot make two different sets look like the same one.
 */
const join = (keys: readonly string[]): string => keys.join('\u0000')

/**
 * Answer the wanted keys, once each, in this generation.
 *
 * `generation` is carried *in* the cache rather than cleared by an effect, so
 * answers from an older generation are neither shown nor reused: a refreshed list
 * and a stale detail can never sit in the same card. Where the list itself uses
 * `freshness.ts` to reach the same conclusion, this is that conclusion for the
 * things that are only fetched when someone asks for them.
 */
export function useRemoteAnswers<T>(
  // Named `ask` rather than `fetch`, which the source guard reserves for the
  // browser's own network API (`tests/host/architecture.spec.ts`): a local name is
  // not a network call, but a guard that has to tell them apart is a guard that
  // will eventually wave one through.
  ask: (key: string) => Promise<ReplyRead<T>>,
  keys: readonly string[],
  generation: number,
): ReadonlyMap<string, Answer<T>> {
  const [cache, setCache] = useState<Cache<T>>(() => ({ generation, entries: new Map() }))
  const entries =
    cache.generation === generation ? cache.entries : (NOTHING as ReadonlyMap<string, Answer<T>>)

  // The generation a late answer belongs to. A separate effect rather than the
  // one below's cleanup, because that cleanup also runs when the *wanted set*
  // changed — and an answer arriving late for `src/a.ts` is still an answer for
  // `src/a.ts`.
  const live = useRef(generation)
  useEffect(() => {
    live.current = generation
    return () => {
      live.current = -1
    }
  }, [generation])

  // Read through a ref so that the effect can depend on the wanted *value*: the
  // array is rebuilt on every render, and depending on it would run the effect on
  // every render to find nothing to do.
  const latest = useRef(keys)
  latest.current = keys
  const wanted = join(keys)

  useEffect(() => {
    if (wanted === '') return
    const pending = latest.current.filter(key => !entries.has(key))
    if (pending.length === 0) return
    // Claim the work before starting it, so the re-render this triggers does not
    // start it a second time.
    setCache(current => {
      const next = new Map(current.generation === generation ? current.entries : NOTHING)
      for (const key of pending) next.set(key, { kind: 'loading' })
      return { generation, entries: next }
    })
    for (const key of pending) {
      void ask(key).then(reply => {
        if (live.current !== generation) return
        setCache(current => {
          const next = new Map(current.generation === generation ? current.entries : NOTHING)
          next.set(key, read(reply))
          return { generation, entries: next }
        })
      })
    }
  }, [wanted, entries, ask, generation])

  return entries
}

const read = <T,>(reply: ReplyRead<T>): Answer<T> => {
  switch (reply.kind) {
    case 'value':
      return { kind: 'value', value: reply.value }
    case 'absent':
      return { kind: 'absent' }
    case 'unusable':
      return { kind: 'failed', reason: reply.detail }
  }
}
