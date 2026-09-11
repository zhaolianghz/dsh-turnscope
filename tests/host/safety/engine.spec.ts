/**
 * Aggregation, the action table, and the two invariants `docs/ARCHITECTURE.md §43`
 * says must never break.
 *
 * The invariants are the reason this file exists separately from the rules: a
 * rule can be right on its own and the verdict still wrong, and these two are the
 * cases where that failure would be unrecoverable.
 */
import { describe, expect, it } from 'vitest'
import {
  evaluateSafety,
  highestSeverity,
  severityAtLeast,
  toSafetyVerdict,
} from '../../../src/host/safety/engine.ts'
import type { SafetyRule } from '../../../src/host/safety/types.ts'
import { change, checkpoint, incompleteness, safetyInput } from './support.ts'

describe('severity order', () => {
  it('takes the worst reason and ignores the rest', () => {
    expect(
      highestSeverity([
        { code: 'A', severity: 'CAUTION', title: '', detail: '', evidenceRefs: [] },
        { code: 'B', severity: 'FORK_ONLY', title: '', detail: '', evidenceRefs: [] },
        { code: 'C', severity: 'CAUTION', title: '', detail: '', evidenceRefs: [] },
      ]),
    ).toBe('FORK_ONLY')
  })

  it('is SAFE when nothing objected', () => {
    expect(highestSeverity([])).toBe('SAFE')
  })

  it('ranks UNPROTECTED above FORK_ONLY, as §15 orders them', () => {
    expect(severityAtLeast('UNPROTECTED', 'FORK_ONLY')).toBe(true)
    expect(severityAtLeast('FORK_ONLY', 'UNPROTECTED')).toBe(false)
    expect(severityAtLeast('CAUTION', 'CAUTION')).toBe(true)
  })
})

describe('a clean turn', () => {
  it('is SAFE and offers everything', () => {
    const verdict = evaluateSafety(safetyInput())
    expect(verdict.level).toBe('SAFE')
    expect(verdict.allowedActions).toEqual(['INSPECT', 'PREVIEW_REWIND', 'REWIND', 'FORK'])
    expect(verdict.recommendedAction).toBe('REWIND')
    expect(verdict.reasons).toEqual([])
  })

  it('carries the engine version so a rule change can be told apart from an old record', () => {
    expect(evaluateSafety(safetyInput()).engineVersion).toBe(1)
  })

  it('fingerprints the state it was computed against', () => {
    const verdict = evaluateSafety(
      safetyInput({ current: checkpoint('recovery_before', { worktreeDigest: 'sha256:live' }) }),
    )
    expect(verdict.currentStateHash).toBe('sha256:live')
  })

  it('falls back to HEAD when there is no worktree digest', () => {
    const verdict = evaluateSafety(
      safetyInput({ current: checkpoint('recovery_before', { headOid: 'c'.repeat(40) }) }),
    )
    expect(verdict.currentStateHash).toBe('c'.repeat(40))
  })
})

describe('the action table', () => {
  it('offers no rewind on CAUTION, only a preview', () => {
    const verdict = evaluateSafety(safetyInput({ pre: checkpoint('pre', incompleteness('partial')) }))
    expect(verdict.level).toBe('CAUTION')
    expect(verdict.allowedActions).toContain('PREVIEW_REWIND')
    expect(verdict.allowedActions).not.toContain('REWIND')
    expect(verdict.recommendedAction).toBe('PREVIEW_REWIND')
  })

  it('offers only a fork on FORK_ONLY', () => {
    const verdict = evaluateSafety(
      safetyInput({
        changeSet: {
          turnId: 's-1:turn:3',
          changes: [change({ attribution: 'DRIFT' })],
          summary: { total: 1, agent: 0, baseline: 0, drift: 1, uncertain: 0 },
        },
      }),
    )
    expect(verdict.level).toBe('FORK_ONLY')
    expect(verdict.allowedActions).toEqual(['INSPECT', 'FORK'])
    expect(verdict.recommendedAction).toBe('FORK')
  })

  it('keeps FORK on UNPROTECTED when a starting state exists', () => {
    // §15: UNPROTECTED and FORK_ONLY are not two points on one scale, so this is
    // not "fewer buttons than FORK_ONLY" — the fork survives because the baseline
    // does.
    const verdict = evaluateSafety(safetyInput({ changeSet: undefined }))
    expect(verdict.level).toBe('UNPROTECTED')
    expect(verdict.allowedActions).toEqual(['INSPECT', 'FORK'])
  })

  it('drops the fork too when there is no restorable starting state', () => {
    const verdict = evaluateSafety(safetyInput({ pre: undefined }))
    expect(verdict.level).toBe('UNPROTECTED')
    expect(verdict.allowedActions).toEqual(['INSPECT'])
    expect(verdict.recommendedAction).toBe('INSPECT')
  })

  it('always includes INSPECT, whatever the level', () => {
    // Looking is always allowed: the user can always be shown what happened.
    for (const input of [
      safetyInput(),
      safetyInput({ pre: checkpoint('pre', incompleteness('partial')) }),
      safetyInput({ changeSet: undefined }),
      safetyInput({ pre: undefined }),
    ]) {
      expect(evaluateSafety(input).allowedActions).toContain('INSPECT')
    }
  })

  it('never recommends an action it did not allow', () => {
    // §FR-11 forbids an action that only explains itself after it is taken, and
    // recommending a disabled one is the same failure one step earlier.
    const cases = [
      safetyInput(),
      safetyInput({ pre: checkpoint('pre', incompleteness('partial')) }),
      safetyInput({ changeSet: undefined }),
      safetyInput({ pre: undefined }),
      safetyInput({
        changeSet: {
          turnId: 's-1:turn:3',
          changes: [change({ attribution: 'UNCERTAIN', confidence: 'low' })],
          summary: { total: 1, agent: 0, baseline: 0, drift: 0, uncertain: 1 },
        },
      }),
    ]
    for (const input of cases) {
      const verdict = evaluateSafety(input)
      expect(verdict.allowedActions).toContain(verdict.recommendedAction)
    }
  })
})

describe('§43 invariants', () => {
  it('never returns SAFE + REWIND when a changed file has drifted', () => {
    // The one lie that would discard the user's work.
    const verdict = evaluateSafety(
      safetyInput({
        changeSet: {
          turnId: 's-1:turn:3',
          changes: [change({ path: 'src/auth.ts', attribution: 'DRIFT' })],
          summary: { total: 1, agent: 0, baseline: 0, drift: 1, uncertain: 0 },
        },
      }),
    )
    expect(verdict.level).not.toBe('SAFE')
    expect(verdict.allowedActions).not.toContain('REWIND')
  })

  it('never allows REWIND when a critical checkpoint is missing', () => {
    for (const input of [
      safetyInput({ pre: undefined }),
      safetyInput({ post: undefined }),
      safetyInput({
        post: checkpoint('post', {
          completeness: 'failed',
          restorable: false,
          failureReason: 'git status unavailable',
        }),
      }),
    ]) {
      const verdict = evaluateSafety(input)
      expect(verdict.allowedActions).not.toContain('REWIND')
      expect(verdict.allowedActions).not.toContain('PREVIEW_REWIND')
    }
  })
})

describe('injection and purity', () => {
  it('accepts a rule set, so aggregation can be tested without a scenario', () => {
    const always: SafetyRule = {
      id: 'TEST',
      evaluate: () => [
        { code: 'TEST_RULE', severity: 'CAUTION', title: 't', detail: 'd', evidenceRefs: [] },
      ],
    }
    const verdict = evaluateSafety(safetyInput(), [always])
    expect(verdict.level).toBe('CAUTION')
    expect(verdict.reasons).toHaveLength(1)
  })

  it('is a function of its input: the same evidence gives the same verdict', () => {
    const input = safetyInput()
    expect(evaluateSafety(input)).toEqual(evaluateSafety(input))
  })
})

describe('the persisted verdict', () => {
  it('is keyed by the turn and stamped with the evaluation time it was given', () => {
    const input = safetyInput({ now: 1_700_000_099_000 })
    const verdict = toSafetyVerdict(input, evaluateSafety(input))
    expect(verdict.id).toBe('s-1:turn:3:safety')
    expect(verdict.turnId).toBe('s-1:turn:3')
    expect(verdict.evaluatedAt).toBe(1_700_000_099_000)
    expect(verdict.schemaVersion).toBe(2)
  })
})
