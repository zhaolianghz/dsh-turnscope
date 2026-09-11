// @vitest-environment jsdom
import type { ConversationNode, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TurnscopeView, createTurnscopeView } from '../../src/client/TurnscopeView.tsx'
import type { TurnscopeHostApi } from '../../src/client/host-api.ts'
import { zh, type TurnscopeKey } from '../../src/client/locales.ts'
import { API_VERSION } from '../../src/shared/contracts/api.ts'
import type { SafetySummaryDto } from '../../src/shared/contracts/api.ts'

afterEach(cleanup)

const node = (value: object): ConversationNode => value as unknown as ConversationNode
const snapshot = (overrides: Partial<ConversationSnapshot>): ConversationSnapshot => ({
  openState: 'open',
  sessionId: 's-1',
  nodes: [],
  turnTimings: new Map(),
  turnEnds: new Map(),
  ...overrides,
} as unknown as ConversationSnapshot)

const verdict = (level: SafetySummaryDto['level']): SafetySummaryDto => ({
  level,
  recommendedAction: 'INSPECT',
  evaluatedAt: 0,
})

/**
 * A stand-in for the framework's `t`, mirroring its one behaviour that matters
 * here: `{name}` placeholders are filled from the params, and a name that is not
 * in them is left as written rather than dropped. A fixture that ignored params
 * would let a view ship a message full of placeholders and still test green.
 */
const translate = (key: TurnscopeKey, params?: Record<string, unknown>): string =>
  params === undefined
    ? zh[key]
    : zh[key].replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)

const props = (value: ConversationSnapshot): Parameters<typeof TurnscopeView>[0] => ({
  useSession: <T,>(selector: (state: ConversationSnapshot) => T) => selector(value),
  t: translate,
} as Parameters<typeof TurnscopeView>[0])

/** The same seats, minus the one the connected view supplies itself. */
const connectedProps = (
  value: ConversationSnapshot,
): Parameters<ReturnType<typeof createTurnscopeView>>[0] =>
  props(value) as unknown as Parameters<ReturnType<typeof createTurnscopeView>>[0]

describe('TurnscopeView', () => {
  it('renders the loading state accessibly', () => {
    const view = render(<TurnscopeView {...props(snapshot({ openState: 'loading' }))} />)
    expect(view.getByRole('status').textContent).toContain('正在加载时间线')
  })

  it('renders the empty state', () => {
    const view = render(<TurnscopeView {...props(snapshot({}))} />)
    expect(view.getByText('此会话还没有可显示的轮次')).toBeTruthy()
  })

  it('renders a running turn without a numeric duration', () => {
    const view = render(<TurnscopeView {...props(snapshot({
      turnTimings: new Map([[2, { startTime: 200 }]]),
    }))} />)
    expect(view.getByRole('article', { name: 'Turn 2' }).textContent).toContain('运行中')
    expect(view.queryByText(/ms$/)).toBeNull()
  })

  it('labels a turn with the level the host recorded for it', () => {
    const view = render(<TurnscopeView
      {...props(snapshot({ turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]) }))}
      recorded={{ safety: new Map([[1, verdict('FORK_ONLY')]]) }}
    />)

    const badge = view.getByRole('article', { name: 'Turn 1' }).querySelector('.turnscope-safety')
    expect(badge?.textContent).toBe('仅可分叉')
    // The level is on the element as well as in the text: the badge is colour-
    // coded by stylesheet, and a reader that strips presentation still has to be
    // able to tell the levels apart.
    expect(badge?.getAttribute('data-level')).toBe('FORK_ONLY')
  })

  it('leaves a turn nobody judged unlabelled instead of calling it safe', () => {
    const view = render(<TurnscopeView
      {...props(snapshot({ turnTimings: new Map([[1, { startTime: 100, endTime: 130 }], [2, { startTime: 200, endTime: 230 }]]) }))}
      recorded={{ safety: new Map([[2, verdict('CAUTION')]]) }}
    />)

    // The claim this refuses to make: "no verdict" is not "safe". Only the turn
    // the host actually answered about carries a badge.
    expect(view.container.querySelectorAll('.turnscope-safety')).toHaveLength(1)
    expect(view.getByRole('article', { name: 'Turn 1' }).textContent).not.toContain('安全')
    expect(view.getByRole('article', { name: 'Turn 2' }).textContent).toContain('注意')
  })

  it('says why the verdicts are missing while still showing the turns', () => {
    const view = render(<TurnscopeView
      {...props(snapshot({ turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]) }))}
      recorded={{ safety: new Map(), problem: 'the host reply carries no data' }}
    />)

    // Which turns happened is local knowledge. Losing the timeline because a
    // remote call failed would be a regression on the thing this panel is for.
    expect(view.getByRole('note').textContent).toContain('the host reply carries no data')
    expect(view.getByRole('article', { name: 'Turn 1' })).toBeTruthy()
  })

  it('renders failed status, counts, and activities as visible text', () => {
    const view = render(<TurnscopeView {...props(snapshot({
      nodes: [
        node({ kind: 'tool-result', seq: 2, time: 120, callId: 'c1', call: { name: 'read', argsRaw: '{}' }, isError: true }),
        node({ kind: 'turn-error', seq: 3, time: 130, turn: 1, step: 1, message: 'failed' }),
      ],
      turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]),
      turnEnds: new Map([[1, 3]]),
    }))} />)
    const card = view.getByRole('article', { name: 'Turn 1' })
    expect(card.textContent).toContain('失败')
    expect(card.textContent).toContain('工具1')
    expect(card.textContent).toContain('异常2')
    expect(card.textContent).toContain('Tool: read')
    expect(card.textContent).toContain('Turn failed')
  })
})

describe('createTurnscopeView', () => {
  const hostOf = (turns: readonly unknown[]): { host: TurnscopeHostApi; listTurns: ReturnType<typeof vi.fn> } => {
    const listTurns = vi.fn(async () => ({
      kind: 'value' as const,
      value: { turns } as never,
    }))
    return { host: { listTurns, getTurnDetail: vi.fn(), evaluateSafety: vi.fn() } as unknown as TurnscopeHostApi, listTurns }
  }

  it('asks the host about the session the panel is showing', async () => {
    const { host, listTurns } = hostOf([
      { ordinal: 1, safety: verdict('UNPROTECTED') },
    ])
    const View = createTurnscopeView(host)

    const view = render(<View {...connectedProps(snapshot({ turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]) }))} />)

    await waitFor(() => {
      expect(view.getByRole('article', { name: 'Turn 1' }).textContent).toContain('无保护')
    })
    // The session id comes from the conversation snapshot the framework hands
    // the view, not from a prop: an owner never passes one.
    expect(listTurns).toHaveBeenCalledWith({ apiVersion: API_VERSION, sessionId: 's-1', limit: 30 })
  })

  it('shows the reason when the host cannot be reached', async () => {
    const listTurns = vi.fn(async () => ({ kind: 'unusable' as const, detail: 'turnscope: offline' }))
    const View = createTurnscopeView({ listTurns, getTurnDetail: vi.fn(), evaluateSafety: vi.fn() } as unknown as TurnscopeHostApi)

    const view = render(<View {...connectedProps(snapshot({ turnTimings: new Map([[1, { startTime: 100 }]]) }))} />)

    await waitFor(() => {
      expect(view.getByRole('note').textContent).toContain('turnscope: offline')
    })
  })
})
