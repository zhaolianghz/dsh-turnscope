/**
 * Tests for {@link applyPatch}, the V0.2 sanity-check step.
 *
 * `applyPatch` is not the production apply path — that path writes bytes
 * straight from `checkpoint_paths.blob_ref` after a stateHash guard has
 * confirmed the worktree has not drifted. `applyPatch` is the validator the
 * dry-run uses: given the current bytes of a file and a reverse patch,
 * does the patch actually reverse the change? When the answer is no, the
 * dry-run refuses the rewind.
 */

import { describe, expect, it } from 'vitest'

import { applyPatch } from '../../../../src/host/recovery/patch/apply.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

describe('applyPatch', () => {
  it('applies a clean patch and returns the reconstructed bytes', () => {
    const cur = enc.encode('a\nb\nc\n')
    const patch = [
      '--- f',
      '+++ f',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '',
    ].join('\n')
    const r = applyPatch({ patch, currentBytes: cur, path: 'f' })
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(dec.decode(r.resultBytes)).toBe('a\nB\nc\n')
    }
  })

  it('returns conflict on context-mismatch (a line that should match differs)', () => {
    const cur = enc.encode('a\nX\nc\n')
    const patch = [
      '--- f', '+++ f', '@@ -1,3 +1,3 @@',
      ' a', '-b', '+B', ' c', '',
    ].join('\n')
    const r = applyPatch({ patch, currentBytes: cur, path: 'f' })
    expect(r.kind).toBe('conflict')
    if (r.kind === 'conflict') expect(r.reason).toBe('context-mismatch')
  })

  it('returns conflict on hunk-offset when a prior hunk has consumed past the start of the next hunk', () => {
    // The first hunk consumes a real line ('a' → 'A', ok); the second hunk
    // claims to start at beforeStart=1, but the cursor has already moved past
    // it. Geometrically impossible to honour without rewinding the cursor, so
    // `applyPatch` returns hunk-offset.
    const cur = enc.encode('a\nb\nc\nd\n')
    const patch = [
      '--- f', '+++ f',
      '@@ -1,2 +1,2 @@',
      '-a', '+A', ' b',          // consumes line 1 (a → A), context line 2 ('b')
      '@@ -1,1 +1,1 @@',
      '-X', '+Y',                // claims to act on line 1, but cursor is now 2
      '',
    ].join('\n')
    const r = applyPatch({ patch, currentBytes: cur, path: 'f' })
    expect(r.kind).toBe('conflict')
    if (r.kind === 'conflict') expect(r.reason).toBe('hunk-offset')
  })

  it('returns conflict on binary (header says "Binary files differ")', () => {
    const cur = new Uint8Array([0, 1, 2, 0xff, 0xfe])
    const patch = '--- f\n+++ f\nBinary files differ\n'
    const r = applyPatch({ patch, currentBytes: cur, path: 'f' })
    expect(r.kind).toBe('conflict')
    if (r.kind === 'conflict') expect(r.reason).toBe('binary')
  })

  it('handles "\\ No newline at end of file" without requiring a trailing newline on the source line', () => {
    const cur = enc.encode('only')
    const patch = [
      '--- f', '+++ f', '@@ -1 +1 @@',
      '-only', '+ONLY',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    const r = applyPatch({ patch, currentBytes: cur, path: 'f' })
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(dec.decode(r.resultBytes)).toBe('ONLY')
    }
  })

  it('CR-normalizes source lines before comparing (matches V0.1 splitLines)', () => {
    // Worktree carries CRLF; the diff was produced from LF (the git blob).
    const cur = enc.encode('a\r\nb\r\nc\r\n')
    const patch = [
      '--- f', '+++ f', '@@ -1,3 +1,3 @@',
      ' a', '-b', '+B', ' c', '',
    ].join('\n')
    const r = applyPatch({ patch, currentBytes: cur, path: 'f' })
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      // The apply writes back LF, matching the V0.1 diff convention.
      expect(dec.decode(r.resultBytes)).toBe('a\nB\nc\n')
    }
  })
})