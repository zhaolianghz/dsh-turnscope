// @vitest-environment jsdom
import type { ConversationNode, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TurnscopeView } from '../src/client/TurnscopeView.tsx'
import { zh, type TurnscopeKey } from '../src/client/locales.ts'

afterEach(cleanup)

const node = (value: object): ConversationNode => value as unknown as ConversationNode
const snapshot = (overrides: Partial<ConversationSnapshot>): ConversationSnapshot => ({
  openState: 'open',
  nodes: [],
  turnTimings: new Map(),
  turnEnds: new Map(),
  ...overrides,
} as unknown as ConversationSnapshot)

const props = (value: ConversationSnapshot): Parameters<typeof TurnscopeView>[0] => ({
  useSession: <T,>(selector: (state: ConversationSnapshot) => T) => selector(value),
  t: (key: TurnscopeKey) => zh[key],
} as Parameters<typeof TurnscopeView>[0])

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
