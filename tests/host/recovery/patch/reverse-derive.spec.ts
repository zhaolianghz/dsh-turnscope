/**
 * Tests for the V0.2 reverse-derive step, per
 * `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §5.2`.
 *
 * The contract under test is the lazy-diff principle: the bytes are never
 * persisted as a patch — they are re-derived from `checkpoint_paths.blob_ref`
 * every time, so the only thing that has to round-trip is the *content* of the
 * two halves.
 */

import { describe, expect, it } from 'vitest'

import { applyPatch } from '../../../../src/host/recovery/patch/apply.ts'
import { reverseDerive } from '../../../../src/host/recovery/patch/reverse-derive.ts'

const enc = new TextEncoder()

describe('reverseDerive', () => {
  it('round-trips: applying reverseText to POST bytes yields PRE bytes', () => {
    const before = enc.encode('a\nb\nc\nd\n')
    const after = enc.encode('a\nB\nc\nD\n')

    const { reverseText } = reverseDerive({ path: 'f.txt', beforeBytes: before, afterBytes: after })
    expect(reverseText).toContain('--- f.txt')
    expect(reverseText).toContain('+++ f.txt')

    const r = applyPatch({ patch: reverseText, currentBytes: after, path: 'f.txt' })
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(new TextDecoder().decode(r.resultBytes)).toBe('a\nb\nc\nd\n')
    }
  })

  it('forwardText contains add/remove hunks for modified lines', () => {
    const before = enc.encode('a\nb\nc\n')
    const after = enc.encode('a\nB\nc\n')

    const { forwardText, forwardHunkCount } = reverseDerive({ path: 'f.txt', beforeBytes: before, afterBytes: after })
    expect(forwardText).toContain('-b')
    expect(forwardText).toContain('+B')
    expect(forwardHunkCount).toBeGreaterThan(0)
  })

  it('reverse-derive for a created file yields a deletion patch (reverseText removes the new file)', () => {
    const after = enc.encode('hello\n')
    const { reverseText } = reverseDerive({ path: 'new.txt', beforeBytes: null, afterBytes: after })
    expect(reverseText).toMatch(/^--- new\.txt/m)
    // Reverse direction is POST → PRE: the file existed in POST and did not
    // exist in PRE, so the reversal removes every line. The `-hello` line is
    // the wire-format expression of that removal.
    expect(reverseText).toMatch(/^-hello/m)
  })

  it('reverse-derive for a deleted file yields an addition patch (reverseText recreates the file)', () => {
    const before = enc.encode('bye\n')
    const { reverseText } = reverseDerive({ path: 'gone.txt', beforeBytes: before, afterBytes: null })
    expect(reverseText).toMatch(/^--- gone\.txt/m)
    expect(reverseText).toMatch(/^[+].*bye/m)
  })

  it('reverse-derive for an unchanged file emits an empty patch', () => {
    const same = enc.encode('x\ny\n')
    const { forwardText, reverseText, forwardHunkCount } = reverseDerive({
      path: 'same.txt',
      beforeBytes: same,
      afterBytes: same,
    })
    expect(forwardText).toBe('')
    expect(reverseText).toBe('')
    expect(forwardHunkCount).toBe(0)
  })
})