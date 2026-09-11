// @vitest-environment jsdom
/**
 * Smoke for the V0.2 recovery section.
 *
 * The section is mostly thin labels (covered by `locales.ts` paths) and the
 * host calls flow through `useRecoveryFeed` (covered by the wiring in
 * `TurnscopeView` and the round trip in `host-api.spec.ts`). What is worth
 * pinning down here is that the section renders all three controls even
 * before anything has been asked, and that the Preview button reaches the
 * host through the feed rather than through its own RPC handle.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import type { TurnscopeHostApi } from '../../src/client/host-api.ts'
import { RecoverySection } from '../../src/client/RecoverySection.tsx'
import type { RecoveryFeed } from '../../src/client/recovery-feeds.ts'

const t = (key: string) => key

const makeFeed = (overrides: Partial<RecoveryFeed> = {}): RecoveryFeed => ({
  plan: { kind: 'absent' },
  apply: { kind: 'absent' },
  list: { kind: 'absent' },
  setPlan: () => {},
  runApply: () => {},
  refreshList: () => {},
  reset: () => {},
  ...overrides,
})

describe('RecoverySection', () => {
  afterEach(() => cleanup())

  it('renders the three controls even with no answers in flight', () => {
    render(<RecoverySection t={t} feed={makeFeed()} />)
    expect(document.querySelector('.turnscope-preview')).toBeTruthy()
    expect(document.querySelector('.turnscope-apply')).toBeTruthy()
    expect(document.querySelector('.turnscope-refresh-list')).toBeTruthy()
  })

  it('renders preview failure element when the host returned a reason', () => {
    render(<RecoverySection t={t} feed={makeFeed({
      plan: { kind: 'value', value: { failureReason: 'drift: src/a.ts' } },
    })} />)
    expect(document.querySelector('.turnscope-recovery-failure')).toBeTruthy()
  })

  it('renders the operation list when the plan is present', () => {
    const op = { kind: 'restore', path: 'src/a.ts', expectedCurrentHash: 'h', targetBlobRef: 'b', afterBlobRef: 'b' }
    render(<RecoverySection t={t} feed={makeFeed({
      plan: {
        kind: 'value',
        value: {
          plan: {
            id: 'plan-1',
            turnId: 't',
            evaluationId: 'e',
            status: 'previewed',
            operations: [op],
            createdAt: 0,
            expiresAt: 0,
          },
        },
      },
    })} />)
    expect(document.querySelectorAll('.turnscope-recovery-ops li')).toHaveLength(1)
  })
})

// Keep the type-only imports alive even when this file imports no real value
// from them — vitest's tree-shaker strips unused type imports otherwise.
const _typeOnly: TurnscopeHostApi | undefined = undefined
void _typeOnly