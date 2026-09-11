import { describe, expect, it } from 'vitest'
import { freshnessOf } from '../../src/client/freshness.ts'
import type { RecordedTurns } from '../../src/client/recorded-turns.ts'
import type { TurnModel } from '../../src/client/turn-model.ts'
import { recordedOf, row } from './support.ts'

const turn = (ordinal: number, status: TurnModel['status'] = 'completed'): TurnModel => ({
  turn: ordinal,
  status,
  startedAt: 0,
  toolCount: 0,
  errorCount: 0,
  activities: [],
})

const recorded = (rows: readonly ReturnType<typeof row>[]): RecordedTurns => recordedOf(rows)

describe('freshnessOf', () => {
  it('is loading until the host answers', () => {
    expect(freshnessOf([turn(1)], undefined)).toBe('loading')
  })

  it('is an error when the host could not be asked', () => {
    // Not `stale`: this is not an answer that has aged, it is the absence of one,
    // and the panel already shows the reason above the turns.
    expect(freshnessOf([turn(1)], { turns: new Map(), problem: 'turnscope: offline' })).toBe('error')
  })

  it('is stale when the timeline has a turn the answer does not mention', () => {
    expect(freshnessOf([turn(2), turn(1)], recorded([row(1)]))).toBe('stale')
  })

  it('is live while something is running and the answer covers it', () => {
    expect(freshnessOf([turn(2, 'running'), turn(1)], recorded([row(1), row(2, { status: 'running' })]))).toBe('live')
  })

  it('is stable when everything has ended', () => {
    expect(freshnessOf([turn(1)], recorded([row(1)]))).toBe('stable')
  })

  it('prefers stale over live, because that is the case a reader would misread', () => {
    // A running turn that the answer knows nothing about is exactly when a
    // verdict-less card is most likely to be taken for a favourable one, so the
    // newer fact ("we are behind") is what gets said.
    expect(freshnessOf([turn(2, 'running')], recorded([row(1)]))).toBe('stale')
  })

  it('reads an empty timeline as in step with the host', () => {
    // There is nothing on screen to be behind, so the panel is not stale — but
    // the host's own rows still say whether anything is happening.
    expect(freshnessOf([], recorded([row(1, { status: 'running' })]))).toBe('live')
    expect(freshnessOf([], recorded([row(1)]))).toBe('stable')
    expect(freshnessOf([], recorded([]))).toBe('stable')
  })
})
