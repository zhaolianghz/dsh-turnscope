import type { ConversationNode, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it } from 'vitest'
import { deriveTurnModels } from '../../src/client/turn-model.ts'

const snapshotWith = (
  nodes: readonly ConversationNode[],
  turnTimings: ConversationSnapshot['turnTimings'],
  turnEnds: ConversationSnapshot['turnEnds'] = new Map([[1, 5]]),
): ConversationSnapshot => ({ nodes, turnTimings, turnEnds } as unknown as ConversationSnapshot)

const node = (value: object): ConversationNode => value as ConversationNode

describe('deriveTurnModels', () => {
  it('groups activity and marks a turn failed', () => {
    const result = deriveTurnModels(snapshotWith([
      node({ kind: 'assistant', seq: 2, turn: 1, step: 1, time: 120, blocks: [] }),
      node({
        kind: 'tool-result', seq: 4, time: 150, callId: 'c1', call: null,
        callTime: 130, content: [], isError: true, callView: null, resultView: null, subCalls: [],
      }),
      node({ kind: 'turn-error', seq: 5, turn: 1, step: 1, time: 160, message: 'failed' }),
    ], new Map([[1, { startTime: 100, endTime: 160 }]])))

    expect(result).toEqual([expect.objectContaining({
      turn: 1,
      status: 'failed',
      durationMs: 60,
      toolCount: 1,
      errorCount: 2,
    })])
  })

  it('marks an open timing as running', () => {
    const [turn] = deriveTurnModels(snapshotWith([], new Map([[2, { startTime: 200 }]]), new Map()))
    expect(turn).toMatchObject({ turn: 2, status: 'running' })
    expect(turn).not.toHaveProperty('durationMs')
  })

  it('marks a closed timing as completed', () => {
    expect(deriveTurnModels(snapshotWith([], new Map([[1, { startTime: 100, endTime: 120 }]])))[0])
      .toMatchObject({ turn: 1, status: 'completed', durationMs: 20 })
  })

  it('returns newest turns first', () => {
    const result = deriveTurnModels(snapshotWith([], new Map([
      [1, { startTime: 100, endTime: 120 }],
      [2, { startTime: 130 }],
    ]), new Map([[1, 5]])))
    expect(result.map(turn => turn.turn)).toEqual([2, 1])
  })

  it('keeps unknown future nodes visible', () => {
    const future = node({ kind: 'future-event', seq: 1, time: 105 })
    const [turn] = deriveTurnModels(snapshotWith([future], new Map([[1, { startTime: 100, endTime: 110 }]])))
    expect(turn?.activities[0]).toMatchObject({ kind: 'unknown', label: 'Unknown: future-event' })
  })

  it('drops context nodes whose seq is before the first user/assistant node', () => {
    // A session's bootstrap burst — instructions, catalog, recall — lands as
    // `context` nodes with seqs earlier than the first user prompt. Those are
    // session-startup noise, not turn activity, and must not appear in turn 1.
    const result = deriveTurnModels(snapshotWith([
      node({ kind: 'context', seq: 1, time: 100 }),
      node({ kind: 'context', seq: 2, time: 101 }),
      node({
        kind: 'user', seq: 5, time: 110, blocks: [],
        source: { kind: 'user-message' },
      }),
    ], new Map([[1, { startTime: 100, endTime: 120 }]]), new Map([[1, 10]])))

    expect(result).toHaveLength(1)
    const turn = result[0]!
    expect(turn.activities.map(activity => activity.kind)).toEqual(['user'])
    expect(turn.activities.find(activity => activity.kind === 'system')).toBeUndefined()
  })

  it('keeps context nodes that arrive after the first user/assistant node', () => {
    // A `context` node with seq >= the first user/assistant seq is a real
    // in-turn or between-turn event and must stay.
    const result = deriveTurnModels(snapshotWith([
      node({
        kind: 'user', seq: 5, time: 110, blocks: [],
        source: { kind: 'user-message' },
      }),
      node({ kind: 'context', seq: 6, time: 111 }),
      node({
        kind: 'assistant', seq: 7, turn: 1, step: 1, time: 120, blocks: [],
      }),
    ], new Map([[1, { startTime: 100, endTime: 130 }]]), new Map([[1, 10]])))

    expect(result).toHaveLength(1)
    const turn = result[0]!
    expect(turn.activities.map(activity => activity.kind)).toEqual(['user', 'system', 'assistant'])
  })

  it('keeps all context nodes when no user or assistant message exists yet', () => {
    // Without a user/assistant seq to anchor the cutoff, the filter cannot
    // distinguish bootstrap from "the user is composing their first prompt",
    // so it must keep the entries.
    const result = deriveTurnModels(snapshotWith([
      node({ kind: 'context', seq: 1, time: 100 }),
      node({ kind: 'context', seq: 2, time: 101 }),
    ], new Map([[1, { startTime: 100, endTime: 120 }]]), new Map([[1, 10]])))

    expect(result).toHaveLength(1)
    const turn = result[0]!
    expect(turn.activities).toHaveLength(2)
    expect(turn.activities.every(activity => activity.kind === 'system')).toBe(true)
  })

  it('returns an empty list and does not crash when the snapshot is undefined or missing nodes', () => {
    // `useSession` can call the selector on an undefined or stub snapshot
    // before the first real emission. The renderer must not throw on that
    // path; an empty list is the right answer because the view's loading
    // branch will replace it as soon as a real snapshot arrives.
    const empty = deriveTurnModels(undefined as unknown as ConversationSnapshot)
    expect(empty).toEqual([])

    const stub = deriveTurnModels({} as unknown as ConversationSnapshot)
    expect(stub).toEqual([])
  })
})
