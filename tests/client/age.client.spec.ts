import { describe, expect, it } from 'vitest'
import { ageOf } from '../../src/client/age.ts'

const at = (ms: number) => ageOf(0, ms)

describe('ageOf', () => {
  it('reports a verdict computed moments ago as now rather than as a number', () => {
    // "0s ago" is a number that means "now", and a reader who sees one will wait
    // for it to change. The point of this label is only "is this verdict still
    // the verdict", and the first few seconds cannot change the answer.
    expect(at(0)).toEqual({ unit: 'now', count: 0 })
    expect(at(9_999)).toEqual({ unit: 'now', count: 0 })
  })

  it('counts seconds, then minutes, hours, and days, at the boundary where the unit is exhausted', () => {
    expect(at(10_000)).toEqual({ unit: 'seconds', count: 10 })
    expect(at(59_999)).toEqual({ unit: 'seconds', count: 59 })
    expect(at(60_000)).toEqual({ unit: 'minutes', count: 1 })
    expect(at(3_599_000)).toEqual({ unit: 'minutes', count: 59 })
    expect(at(3_600_000)).toEqual({ unit: 'hours', count: 1 })
    expect(at(86_399_000)).toEqual({ unit: 'hours', count: 23 })
    expect(at(86_400_000)).toEqual({ unit: 'days', count: 1 })
  })

  it('never reports a negative age, because a verdict cannot be younger than no time at all', () => {
    // A timestamp ahead of the local clock is a disagreement between two clocks,
    // not information about the verdict. Rendering it as "-3 seconds ago" would
    // turn that into a claim about the verdict.
    expect(ageOf(1_000, 0)).toEqual({ unit: 'now', count: 0 })
  })
})
