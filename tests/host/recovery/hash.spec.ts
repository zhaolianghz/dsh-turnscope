/**
 * Tests for {@link computeStateHash}, the V0.2 drift guard between Preview
 * and Apply (`docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §5.4`).
 *
 * The hash is the *only* protection against the "user edited the file after
 * preview" race, so the contract here is non-negotiable: any change in any
 * field must produce a different hash, and identical inputs must produce
 * identical hashes regardless of the order paths arrive in.
 */

import { describe, expect, it } from 'vitest'

import { computeStateHash } from '../../../src/host/recovery/hash.ts'

const git = { headOid: 'abc123', branch: 'main', worktreePath: '/wt' }

describe('computeStateHash', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeStateHash({
      workspaceId: 'w1',
      git,
      relevantPaths: [
        { path: 'a.txt', contentHash: 'h1', staged: false },
        { path: 'b.txt', contentHash: 'h2', staged: true },
      ],
    })
    const b = computeStateHash({
      workspaceId: 'w1',
      git,
      relevantPaths: [
        { path: 'a.txt', contentHash: 'h1', staged: false },
        { path: 'b.txt', contentHash: 'h2', staged: true },
      ],
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('is order-independent over relevantPaths', () => {
    const fwd = computeStateHash({
      workspaceId: 'w1',
      git,
      relevantPaths: [
        { path: 'a.txt', contentHash: 'h1', staged: false },
        { path: 'b.txt', contentHash: 'h2', staged: false },
      ],
    })
    const rev = computeStateHash({
      workspaceId: 'w1',
      git,
      relevantPaths: [
        { path: 'b.txt', contentHash: 'h2', staged: false },
        { path: 'a.txt', contentHash: 'h1', staged: false },
      ],
    })
    expect(fwd).toBe(rev)
  })

  it('changes when a relevant path content hash changes', () => {
    const before = computeStateHash({
      workspaceId: 'w1',
      git,
      relevantPaths: [{ path: 'a.txt', contentHash: 'h1', staged: false }],
    })
    const after = computeStateHash({
      workspaceId: 'w1',
      git,
      relevantPaths: [{ path: 'a.txt', contentHash: 'h2', staged: false }],
    })
    expect(before).not.toBe(after)
  })

  it('changes when a relevant path is added', () => {
    const before = computeStateHash({
      workspaceId: 'w1',
      git,
      relevantPaths: [{ path: 'a.txt', contentHash: 'h1', staged: false }],
    })
    const after = computeStateHash({
      workspaceId: 'w1',
      git,
      relevantPaths: [
        { path: 'a.txt', contentHash: 'h1', staged: false },
        { path: 'b.txt', contentHash: 'h2', staged: false },
      ],
    })
    expect(before).not.toBe(after)
  })

  it('changes when a path is staged vs. unstaged', () => {
    const unstaged = computeStateHash({
      workspaceId: 'w1',
      git,
      relevantPaths: [{ path: 'a.txt', contentHash: 'h1', staged: false }],
    })
    const staged = computeStateHash({
      workspaceId: 'w1',
      git,
      relevantPaths: [{ path: 'a.txt', contentHash: 'h1', staged: true }],
    })
    expect(unstaged).not.toBe(staged)
  })

  it('changes when HEAD moves', () => {
    const before = computeStateHash({
      workspaceId: 'w1',
      git,
      relevantPaths: [],
    })
    const after = computeStateHash({
      workspaceId: 'w1',
      git: { ...git, headOid: 'def456' },
      relevantPaths: [],
    })
    expect(before).not.toBe(after)
  })

  it('changes when workspaceId changes', () => {
    const a = computeStateHash({ workspaceId: 'w1', git, relevantPaths: [] })
    const b = computeStateHash({ workspaceId: 'w2', git, relevantPaths: [] })
    expect(a).not.toBe(b)
  })

  it('treats absent contentHash (untracked) as empty, distinct from a tracked file', () => {
    const untracked = computeStateHash({
      workspaceId: 'w1',
      git,
      relevantPaths: [{ path: 'a.txt', contentHash: undefined, staged: false }],
    })
    const tracked = computeStateHash({
      workspaceId: 'w1',
      git,
      relevantPaths: [{ path: 'a.txt', contentHash: 'h1', staged: false }],
    })
    expect(untracked).not.toBe(tracked)
  })
})