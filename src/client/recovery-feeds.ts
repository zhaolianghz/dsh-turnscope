/**
 * The recovery side of the panel: previews, applies, and the list of plans
 * the host is still working on.
 *
 * Three independent pieces of state so a refresh on the list does not
 * invalidate a preview the user is mid-confirm on. That separation is what
 * makes "preview then look at the list" a sensible action in the UI.
 */

import { useCallback, useState } from 'react'

import { API_VERSION } from '../shared/contracts/api.ts'
import type {
  ApplyRewindData,
  ListRecoveryPlansData,
  PreviewRewindData,
} from '../shared/contracts/api.ts'

import type { TurnscopeHostApi } from './host-api.ts'

/**
 * What is known about the last preview / apply call the user has made.
 *
 * Same shape as `remote-answers`'s `Answer`, re-stated so the file does
 * not import a feed type that exists for a different reason.
 */
export type RecoveryAnswer<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly reason: string }

export interface RecoveryFeed {
  readonly plan: RecoveryAnswer<PreviewRewindData>
  readonly apply: RecoveryAnswer<ApplyRewindData>
  readonly list: RecoveryAnswer<ListRecoveryPlansData>
  readonly setPlan: (evaluationId: string) => void
  readonly runApply: (planId: string) => void
  readonly refreshList: () => void
  /** Drop every cached answer; called by the generation bump on the parent. */
  readonly reset: () => void
}

/**
 * Build the feed for one open card.
 *
 * The generation counter from the parent view is not part of this hook's
 * signature — it is what triggers a `reset` through the parent's effect,
 * because depending on it here would re-create the feed on every refresh
 * and lose the in-flight answer that the refresh was meant to honour.
 */
export function useRecoveryFeed(host: TurnscopeHostApi, turnId: string): RecoveryFeed {
  const [plan, setPlanState] = useState<RecoveryAnswer<PreviewRewindData>>({ kind: 'absent' })
  const [apply, setApply] = useState<RecoveryAnswer<ApplyRewindData>>({ kind: 'absent' })
  const [list, setList] = useState<RecoveryAnswer<ListRecoveryPlansData>>({ kind: 'absent' })

  const setPlan = useCallback((evaluationId: string) => {
    setPlanState({ kind: 'loading' })
    void host.previewRewind({ apiVersion: API_VERSION, turnId, evaluationId }).then(reply => {
      if (reply.kind === 'unusable') {
        setPlanState({ kind: 'failed', reason: reply.detail })
        return
      }
      if (reply.kind === 'absent') {
        setPlanState({ kind: 'absent' })
        return
      }
      setPlanState({ kind: 'value', value: reply.value })
    })
  }, [host, turnId])

  const runApply = useCallback((planId: string) => {
    setApply({ kind: 'loading' })
    void host.applyRewind({ apiVersion: API_VERSION, planId }).then(reply => {
      if (reply.kind === 'unusable') {
        setApply({ kind: 'failed', reason: reply.detail })
        return
      }
      if (reply.kind === 'absent') {
        setApply({ kind: 'absent' })
        return
      }
      setApply({ kind: 'value', value: reply.value })
    })
  }, [host])

  const refreshList = useCallback(() => {
    setList({ kind: 'loading' })
    void host.listRecoveryPlans({ apiVersion: API_VERSION, includeFinished: false }).then(reply => {
      if (reply.kind === 'unusable') {
        setList({ kind: 'failed', reason: reply.detail })
        return
      }
      if (reply.kind === 'absent') {
        setList({ kind: 'absent' })
        return
      }
      setList({ kind: 'value', value: reply.value })
    })
  }, [host])

  const reset = useCallback(() => {
    setPlanState({ kind: 'absent' })
    setApply({ kind: 'absent' })
    setList({ kind: 'absent' })
  }, [])

  return { plan, apply, list, setPlan, runApply, refreshList, reset }
}
