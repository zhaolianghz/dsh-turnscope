// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TurnscopeView, createTurnscopeView } from '../../src/client/TurnscopeView.tsx'
import type { TurnscopeHostApi } from '../../src/client/host-api.ts'
import { API_VERSION } from '../../src/shared/contracts/api.ts'
import type { TurnSummaryDto } from '../../src/shared/contracts/api.ts'
import {
  change,
  connectedProps,
  detail,
  detailWiring,
  fileDiff,
  hunk,
  line,
  hostDouble,
  node,
  props,
  recordedOf,
  row,
  snapshot,
  verdict,
} from './support.ts'

afterEach(cleanup)

const card = (view: ReturnType<typeof render>, ordinal: number): Element =>
  view.getByRole('article', { name: `Turn ${ordinal}` })

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
    expect(card(view, 2).textContent).toContain('运行中')
    expect(view.queryByText(/ms$/)).toBeNull()
  })

  it('labels a turn with the level the host recorded for it', () => {
    const view = render(<TurnscopeView
      {...props(snapshot({ turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]) }))}
      recorded={recordedOf([row(1, { safety: verdict('FORK_ONLY') })])}
    />)

    const badge = card(view, 1).querySelector('.turnscope-safety')
    expect(badge?.textContent).toBe('仅可分叉')
    // The level is on the element as well as in the text: the badge is colour-
    // coded by stylesheet, and a reader that strips presentation still has to be
    // able to tell the levels apart.
    expect(badge?.getAttribute('data-level')).toBe('FORK_ONLY')
  })

  it('says a turn is unjudged rather than calling it safe, and says nothing about a turn the host never recorded', () => {
    const view = render(<TurnscopeView
      {...props(snapshot({
        turnTimings: new Map([[1, { startTime: 100, endTime: 130 }], [2, { startTime: 200, endTime: 230 }]]),
      }))}
      recorded={recordedOf([row(2)])}
    />)

    // The claim this refuses to make: "no verdict" is not "safe". Turn 2 has a
    // host row and no verdict — a fact worth stating. Turn 1 has no row at all,
    // which is the *other* thing: the answer predates it, so there is nothing to
    // label and the freshness chip says so instead.
    expect(card(view, 2).querySelector('.turnscope-safety')?.textContent).toBe('未评估')
    expect(card(view, 2).textContent).not.toContain('安全')
    expect(card(view, 1).querySelector('.turnscope-safety')).toBeNull()
    expect(view.getByText('落后于主进程')).toBeTruthy()
  })

  it('says why the verdicts are missing while still showing the turns', () => {
    const view = render(<TurnscopeView
      {...props(snapshot({ turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]) }))}
      recorded={{ turns: new Map(), problem: 'the host reply carries no data' }}
    />)

    // Which turns happened is local knowledge. Losing the timeline because a
    // remote call failed would be a regression on the thing this panel is for.
    expect(view.getByRole('note').textContent).toContain('the host reply carries no data')
    expect(card(view, 1)).toBeTruthy()
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
    expect(card(view, 1).textContent).toContain('失败')
    expect(card(view, 1).textContent).toContain('工具1')
    expect(card(view, 1).textContent).toContain('异常2')
    expect(card(view, 1).textContent).toContain('Tool: read')
    expect(card(view, 1).textContent).toContain('Turn failed')
  })

  it('shows what the host recorded about the change: files, evidence, and the recommended action', () => {
    const view = render(<TurnscopeView
      {...props(snapshot({ turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]) }))}
      recorded={recordedOf([row(1, {
        changeCount: 3,
        agentChangeCount: 3,
        baselineChangeCount: 0,
        evidenceCompleteness: 'partial',
        safety: verdict('CAUTION', 'PREVIEW_REWIND'),
      })])}
    />)

    // `docs/PRD.md §14.1` puts the verdict, the changed files, and the recommended
    // action on the first screen; `§14.2` wants the action named outright rather
    // than hinted at, and the evidence qualifier said out loud when it is not
    // complete — a verdict shown without it reads as more certain than it is.
    expect(card(view, 1).textContent).toContain('变更文件3')
    expect(card(view, 1).textContent).toContain('证据不完整')
    expect(card(view, 1).textContent).toContain('建议动作')
    expect(card(view, 1).textContent).toContain('回滚前先预览')
  })

  it('shows a baseline-dirty chip next to the agent change count when paths were inherited', () => {
    // The headline count is what the agent did this turn. A dirty worktree at
    // session start contributes baseline paths, and they must be visible as
    // such rather than blending into the headline (the bug V0.1.1 fixed).
    const view = render(<TurnscopeView
      {...props(snapshot({ turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]) }))}
      recorded={recordedOf([row(1, {
        changeCount: 8,
        agentChangeCount: 3,
        baselineChangeCount: 5,
        evidenceCompleteness: 'partial',
        safety: verdict('CAUTION', 'PREVIEW_REWIND'),
      })])}
    />)
    // Headline is the agent's edits; the inherited count is a separate chip.
    expect(card(view, 1).textContent).toContain('变更文件3')
    expect(card(view, 1).textContent).toContain('+5 已脏')
  })

  it('keeps the baseline chip quiet when no paths were inherited', () => {
    const view = render(<TurnscopeView
      {...props(snapshot({ turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]) }))}
      recorded={recordedOf([row(1, {
        changeCount: 3,
        agentChangeCount: 3,
        baselineChangeCount: 0,
        safety: verdict('SAFE', 'REWIND'),
      })])}
    />)
    expect(card(view, 1).textContent).toContain('变更文件3')
    expect(card(view, 1).textContent).not.toContain('已脏')
  })

  it('keeps the evidence qualifier quiet when the evidence is complete', () => {
    const view = render(<TurnscopeView
      {...props(snapshot({ turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]) }))}
      recorded={recordedOf([row(1, { safety: verdict('SAFE', 'REWIND') })])}
    />)
    expect(card(view, 1).querySelector('.turnscope-evidence')).toBeNull()
    expect(card(view, 1).textContent).toContain('可安全回滚')
  })

  it('names the host status when the timeline cannot express it', () => {
    const view = render(<TurnscopeView
      {...props(snapshot({ turnTimings: new Map([[1, { startTime: 100 }]]) }))}
      recorded={recordedOf([row(1, { status: 'interrupted' })])}
    />)

    // The card's own status line is the conversation's. A host status the
    // timeline *cannot* express is a second fact and gets its own words; a host
    // status it *can* express is left out, because "host recorded: running" next
    // to "Running" would be noise dressed as evidence.
    expect(card(view, 1).textContent).toContain('主进程记录：已中断')
    expect(card(view, 1).textContent).toContain('运行中')
    expect(card(view, 1).querySelector('.turnscope-host-status')).toBeTruthy()
  })

  it('describes how far behind the host it is, and offers the way out', () => {
    const onRefresh = vi.fn()
    const view = render(<TurnscopeView
      {...props(snapshot({ turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]) }))}
      recorded={recordedOf([])}
      onRefresh={onRefresh}
    />)

    expect(view.container.querySelector('.turnscope-root')?.getAttribute('data-freshness')).toBe('stale')
    fireEvent.click(view.getByRole('button', { name: '刷新' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('has no way into a turn the host does not know, because there is nothing to open', () => {
    // The detail is a *record*, and only the host has one. A row is what makes an
    // id to ask about; without a row the expander would lead nowhere, and a
    // control that leads nowhere is read as a control that failed.
    const view = render(<TurnscopeView
      {...props(snapshot({
        turnTimings: new Map([[1, { startTime: 100, endTime: 130 }], [2, { startTime: 200, endTime: 230 }]]),
      }))}
      recorded={recordedOf([row(2)])}
      detail={detailWiring()}
    />)

    expect(card(view, 1).querySelector('.turnscope-expand')).toBeNull()
    expect(card(view, 2).querySelector('.turnscope-expand')?.textContent).toBe('展开详情')
  })

  it('opens a turn onto what the host recorded, and closes it again', () => {
    const wiring = detailWiring({
      states: new Map([['t-1', { kind: 'value' as const, value: detail({ changes: [change('src/a.ts')] }) }]]),
      expanded: ['t-1'],
    })
    const view = render(<TurnscopeView
      {...props(snapshot({ turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]) }))}
      recorded={recordedOf([row(1)])}
      detail={wiring}
    />)

    expect(card(view, 1).querySelector('.turnscope-expand')?.getAttribute('aria-expanded')).toBe('true')
    expect(card(view, 1).querySelector('.turnscope-detail')).toBeTruthy()
    expect(card(view, 1).textContent).toContain('src/a.ts')

    fireEvent.click(card(view, 1).querySelector('.turnscope-expand') as Element)
    expect(wiring.feed.toggle).toHaveBeenCalledWith('t-1')
  })

  it('cannot be refreshed before the first answer, because there is nothing to refresh', () => {
    const view = render(<TurnscopeView
      {...props(snapshot({ turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]) }))}
      onRefresh={vi.fn()}
    />)
    expect(view.getByText('正在查询主进程')).toBeTruthy()
    expect((view.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('createTurnscopeView', () => {
  it('asks the host about the session the panel is showing', async () => {
    const { host, listTurns } = hostDouble({
      kind: 'value',
      value: { turns: [row(1, { safety: verdict('UNPROTECTED') })] },
    })
    const View = createTurnscopeView(host)
    const view = render(<View {...connectedProps(snapshot({
      turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]),
    }))} />)

    await waitFor(() => {
      expect(card(view, 1).textContent).toContain('无保护')
    })
    // The session id comes from the conversation snapshot the framework hands
    // the view, not from a prop: an owner never passes one.
    expect(listTurns).toHaveBeenCalledWith({ apiVersion: API_VERSION, sessionId: 's-1', limit: 30 })
    expect(view.container.querySelector('.turnscope-root')?.getAttribute('data-freshness')).toBe('stable')
  })

  it('shows the reason when the host cannot be reached', async () => {
    const { host } = hostDouble({ kind: 'unusable', detail: 'turnscope: offline' })
    const View = createTurnscopeView(host)
    const view = render(<View {...connectedProps(snapshot({
      turnTimings: new Map([[1, { startTime: 100 }]]),
    }))} />)

    await waitFor(() => {
      expect(view.getByRole('note').textContent).toContain('turnscope: offline')
    })
    expect(view.container.querySelector('.turnscope-root')?.getAttribute('data-freshness')).toBe('error')
  })

  it('asks again when the reader asks it to', async () => {
    const first = hostDouble({ kind: 'value', value: { turns: [row(1)] } })
    const View = createTurnscopeView(first.host)
    const view = render(<View {...connectedProps(snapshot({
      turnTimings: new Map([[1, { startTime: 100, endTime: 130 }], [2, { startTime: 200, endTime: 230 }]]),
    }))} />)

    // The timeline is one turn ahead of the answer, which is what a turn that
    // started after the fetch looks like. Nothing will fix that by itself: the
    // panel has one request per session, so the button *is* the refresh policy
    // until a subscription replaces it.
    await waitFor(() => {
      expect(view.getByText('落后于主进程')).toBeTruthy()
    })
    first.listTurns.mockResolvedValueOnce({
      kind: 'value',
      value: { turns: [row(1), row(2)] },
    })
    fireEvent.click(view.getByRole('button', { name: '刷新' }))

    await waitFor(() => {
      expect(view.getByText('与主进程一致')).toBeTruthy()
    })
    expect(first.listTurns).toHaveBeenCalledTimes(2)
  })

  it('asks for a turn only when a reader opens it', async () => {
    const { host, getTurnDetail } = hostDouble(
      { kind: 'value', value: { turns: [row(1)] } },
      { kind: 'value', value: detail({ changes: [change('src/a.ts')] }) },
    )
    const View = createTurnscopeView(host)
    const view = render(<View {...connectedProps(snapshot({
      turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]),
    }))} />)

    await waitFor(() => {
      expect(view.getByRole('button', { name: '展开详情' })).toBeTruthy()
    })
    // The list is the screen; the detail is a side trip. Asking for every turn's
    // detail up front would ship activities, commands, tests and changes for
    // turns nobody is going to look at (`docs/ARCHITECTURE.md §44.2`).
    expect(getTurnDetail).not.toHaveBeenCalled()

    fireEvent.click(view.getByRole('button', { name: '展开详情' }))
    await waitFor(() => {
      expect(view.getByText('src/a.ts')).toBeTruthy()
    })
    expect(getTurnDetail).toHaveBeenCalledWith({ apiVersion: API_VERSION, turnId: 't-1' })

    // Collapsing and opening again shows the same answer without asking twice:
    // the record of a finished turn does not change on the timescale of a
    // reader's clicking, and a second round trip would only be able to differ
    // from the first by being newer.
    fireEvent.click(view.getByRole('button', { name: '收起详情' }))
    fireEvent.click(view.getByRole('button', { name: '展开详情' }))
    expect(view.getByText('src/a.ts')).toBeTruthy()
    expect(getTurnDetail).toHaveBeenCalledTimes(1)
  })

  it('re-asks for an open detail when the reader refreshes, because the cache is one round of asking', async () => {
    const { host, getTurnDetail } = hostDouble(
      { kind: 'value', value: { turns: [row(1)] } },
      { kind: 'value', value: detail() },
    )
    const View = createTurnscopeView(host)
    const view = render(<View {...connectedProps(snapshot({
      turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]),
    }))} />)

    await waitFor(() => {
      expect(view.getByRole('button', { name: '展开详情' })).toBeTruthy()
    })
    fireEvent.click(view.getByRole('button', { name: '展开详情' }))
    await waitFor(() => {
      expect(getTurnDetail).toHaveBeenCalledTimes(1)
    })

    // A refresh is the reader saying the answers on screen may be older than the
    // host. That is as true of an opened detail as it is of the list, and a panel
    // whose list refreshed while its detail did not would be two answers about
    // two different moments, shown as one turn.
    fireEvent.click(view.getByRole('button', { name: '刷新' }))
    await waitFor(() => {
      expect(getTurnDetail).toHaveBeenCalledTimes(2)
    })
  })

  it('asks for a path’s diff when the reader clicks it, and not before', async () => {
    const { host, getDiff } = hostDouble(
      { kind: 'value', value: { turns: [row(1)] } },
      { kind: 'value', value: detail({ changes: [change('src/a.ts')] }) },
      {
        kind: 'value',
        value: {
          diff: fileDiff('src/a.ts', {
            availability: {
              kind: 'text',
              truncated: false,
              hunks: [hunk({ lines: [line('add', 'const a = 1', undefined, 1)] })],
            },
          }),
        },
      },
    )
    const View = createTurnscopeView(host)
    const view = render(<View {...connectedProps(snapshot({
      turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]),
    }))} />)

    await waitFor(() => {
      expect(view.getByRole('button', { name: '展开详情' })).toBeTruthy()
    })
    fireEvent.click(view.getByRole('button', { name: '展开详情' }))
    await waitFor(() => {
      expect(view.getByRole('button', { name: 'src/a.ts' })).toBeTruthy()
    })
    // A diff is the largest thing this panel can ask for and the least often
    // wanted (`docs/ARCHITECTURE.md §44.2`): fetching one per change would be the
    // most expensive possible way to render none of them.
    expect(getDiff).not.toHaveBeenCalled()

    fireEvent.click(view.getByRole('button', { name: 'src/a.ts' }))
    await waitFor(() => {
      expect(view.container.querySelector('.turnscope-hunk')).toBeTruthy()
    })
    // The request carries the *recorded* path — the one the host reported — so a
    // path that arrived from the browser can only ever select a change, never
    // become one (see `GetDiffRequest`).
    expect(getDiff).toHaveBeenCalledWith({ apiVersion: API_VERSION, turnId: 't-1', path: 'src/a.ts' })
    expect(view.getByText('const a = 1')).toBeTruthy()

    // Clicking the open path closes it, and asking again would be asking the same
    // question about a turn that has already finished.
    fireEvent.click(view.getByRole('button', { name: 'src/a.ts' }))
    expect(view.container.querySelector('.turnscope-hunk')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'src/a.ts' }))
    await waitFor(() => {
      expect(view.container.querySelector('.turnscope-hunk')).toBeTruthy()
    })
    expect(getDiff).toHaveBeenCalledTimes(1)
  })

  it('reports a diff it could not read inside the turn, not in place of it', async () => {
    const { host } = hostDouble(
      { kind: 'value', value: { turns: [row(1)] } },
      { kind: 'value', value: detail({ changes: [change('src/a.ts')] }) },
      { kind: 'unusable', detail: 'gateway: no such endpoint' },
    )
    const View = createTurnscopeView(host)
    const view = render(<View {...connectedProps(snapshot({
      turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]),
    }))} />)

    await waitFor(() => {
      expect(view.getByRole('button', { name: '展开详情' })).toBeTruthy()
    })
    fireEvent.click(view.getByRole('button', { name: '展开详情' }))
    await waitFor(() => {
      expect(view.getByRole('button', { name: 'src/a.ts' })).toBeTruthy()
    })
    fireEvent.click(view.getByRole('button', { name: 'src/a.ts' }))
    await waitFor(() => {
      expect(view.getByRole('note').textContent).toContain('gateway: no such endpoint')
    })
  })

  it('says when a turn it opened cannot be read', async () => {
    const { host } = hostDouble(
      { kind: 'value', value: { turns: [row(1)] } },
      { kind: 'unusable', detail: 'gateway: no such endpoint' },
    )
    const View = createTurnscopeView(host)
    const view = render(<View {...connectedProps(snapshot({
      turnTimings: new Map([[1, { startTime: 100, endTime: 130 }]]),
    }))} />)

    await waitFor(() => {
      expect(view.getByRole('button', { name: '展开详情' })).toBeTruthy()
    })
    fireEvent.click(view.getByRole('button', { name: '展开详情' }))
    await waitFor(() => {
      expect(view.getByRole('note').textContent).toContain('gateway: no such endpoint')
    })
  })

  it('does not keep a stale session in flight from labelling the next one', async () => {
    type Reply = { readonly kind: 'value'; readonly value: { readonly turns: readonly TurnSummaryDto[] } }
    const pending: Array<(reply: Reply) => void> = []
    const listTurns = vi.fn(() => new Promise<Reply>(resolve => pending.push(resolve)))
    const View = createTurnscopeView({ listTurns } as unknown as TurnscopeHostApi)
    const timings = new Map([[1, { startTime: 100, endTime: 130 }]])

    const view = render(<View {...connectedProps(snapshot({ turnTimings: timings }))} />)
    view.rerender(<View {...connectedProps(snapshot({ sessionId: 's-2', turnTimings: timings }))} />)

    // Session one's answer arrives after the switch. The turn numbers overlap, so
    // nothing but the session it was asked about can tell them apart — and a
    // verdict about another conversation is worse than no verdict at all.
    pending[0]?.({ kind: 'value', value: { turns: [row(1, { safety: verdict('UNPROTECTED') })] } })
    await Promise.resolve()
    expect(card(view, 1).querySelector('.turnscope-safety')).toBeNull()

    pending[1]?.({ kind: 'value', value: { turns: [row(1)] } })
    await waitFor(() => {
      expect(card(view, 1).querySelector('.turnscope-safety')?.textContent).toBe('未评估')
    })
    expect(listTurns).toHaveBeenCalledTimes(2)
  })
})
