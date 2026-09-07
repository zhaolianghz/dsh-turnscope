import type { ConversationNode, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it } from 'vitest'
import { deriveTurnModels } from '../src/client/turn-model.ts'

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
})
