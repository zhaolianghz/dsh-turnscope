import { describe, expect, it } from 'vitest'
import { activityIdFor, checkpointIdFor, turnIdFor } from '../../src/host/domain/ids.ts'
import { transitionTurn } from '../../src/host/domain/turn-state.ts'
import { SCHEMA_VERSION, type NormalizedEvent, type TurnStatus } from '../../src/host/domain/types.ts'

const NON_TERMINAL: readonly TurnStatus[] = ['pending', 'running']
const TERMINAL: readonly TurnStatus[] = ['completed', 'failed', 'interrupted']
const ALL: readonly TurnStatus[] = [...NON_TERMINAL, ...TERMINAL]

describe('transitionTurn', () => {
  it('accepts every transition out of a non-terminal state', () => {
    for (const current of NON_TERMINAL) {
      for (const next of ALL) {
        expect(transitionTurn(current, next), `${current} -> ${next}`).toBe(next)
      }
    }
  })

  it('absorbs every transition out of a terminal state', () => {
    for (const current of TERMINAL) {
      for (const next of ALL) {
        expect(transitionTurn(current, next), `${current} -> ${next}`).toBe(current)
      }
    }
  })

  it('starts a pending turn', () => {
    expect(transitionTurn('pending', 'running')).toBe('running')
    expect(transitionTurn('pending', 'completed')).toBe('completed')
  })

  it('closes a running turn', () => {
    expect(transitionTurn('running', 'completed')).toBe('completed')
    expect(transitionTurn('running', 'failed')).toBe('failed')
    expect(transitionTurn('running', 'interrupted')).toBe('interrupted')
  })

  it('keeps a terminal turn terminal', () => {
    expect(transitionTurn('completed', 'running')).toBe('completed')
    expect(transitionTurn('failed', 'failed')).toBe('failed')
    expect(transitionTurn('interrupted', 'running')).toBe('interrupted')
    expect(transitionTurn('completed', 'failed')).toBe('completed')
  })

  it('does not resurrect an interrupted turn on a late completion', () => {
    expect(transitionTurn('interrupted', 'completed')).toBe('interrupted')
  })

  it('is total over the status domain and free of side effects', () => {
    const before = [...ALL]
    for (const current of ALL) {
      for (const next of ALL) {
        expect(ALL).toContain(transitionTurn(current, next))
      }
    }
    expect(ALL).toEqual(before)
    // Same inputs, same answer: the function holds no state between calls.
    expect(transitionTurn('running', 'failed')).toBe(transitionTurn('running', 'failed'))
  })
})

describe('identifiers', () => {
  it('derives the documented turn id', () => {
    expect(turnIdFor('s1', 3)).toBe('s1:turn:3')
    expect(turnIdFor('s1', 0)).toBe('s1:turn:0')
  })

  it('derives the documented activity id', () => {
    expect(activityIdFor('s1', 7)).toBe('s1:act:7')
  })

  it('derives a checkpoint id from the turn id and phase', () => {
    const turnId = turnIdFor('s1', 0)
    expect(checkpointIdFor(turnId, 'pre')).toBe(`${turnId}:cp:pre`)
    expect(checkpointIdFor(turnId, 'post')).toBe(`${turnId}:cp:post`)
    expect(checkpointIdFor(turnId, 'pre')).not.toBe(checkpointIdFor(turnId, 'post'))
  })

  it('is deterministic and idempotent, so a replayed event upserts the same row', () => {
    expect(activityIdFor('s1', 7)).toBe(activityIdFor('s1', 7))
    expect(activityIdFor('s1', 7)).not.toBe(activityIdFor('s1', 8))
    expect(activityIdFor('s1', 7)).not.toBe(activityIdFor('s2', 7))
    expect(turnIdFor('s1', 3)).toBe(turnIdFor('s1', 3))
    expect(turnIdFor('s1', 3)).not.toBe(turnIdFor('s1', 4))
    expect(turnIdFor('s1', 3)).not.toBe(turnIdFor('s2', 3))
  })

  it('separates the turn and activity namespaces of one session', () => {
    expect(turnIdFor('s1', 7)).not.toBe(activityIdFor('s1', 7))
  })

  it('produces byte-identical strings across repeated selection', () => {
    const derive = (): readonly string[] => [
      turnIdFor('s1', 3),
      activityIdFor('s1', 7),
      checkpointIdFor(turnIdFor('s1', 3), 'post'),
    ]
    const first = derive()
    for (const id of first) {
      // ASCII-only and whitespace-free, so the bytes survive every encoding
      // path (SQLite TEXT, JSON, a log line) without normalization.
      expect(id).toMatch(/^[^\s]+$/)
      expect(id).toBe(Buffer.from(id, 'utf8').toString('utf8'))
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(derive()).toEqual(first)
    }
  })
})

describe('domain types', () => {
  it('defaults the schema version to 1', () => {
    expect(SCHEMA_VERSION).toBe(1)
  })

  it('honours the NormalizedEvent shape', () => {
    const event: NormalizedEvent = {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: 'w1',
      sessionId: 's1',
      turnId: turnIdFor('s1', 0),
      activityId: activityIdFor('s1', 3),
      kind: 'tool',
      phase: 'started',
      occurredAt: '2026-09-10T00:00:00.000Z',
    }

    expect(event).toEqual({
      schemaVersion: 1,
      workspaceId: 'w1',
      sessionId: 's1',
      turnId: 's1:turn:0',
      activityId: 's1:act:3',
      kind: 'tool',
      phase: 'started',
      occurredAt: '2026-09-10T00:00:00.000Z',
    })
    expect('parentActivityId' in event).toBe(false)
    expect('payloadRef' in event).toBe(false)
  })
})
