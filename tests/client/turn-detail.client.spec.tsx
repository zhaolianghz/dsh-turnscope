// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TurnDetailView } from '../../src/client/TurnDetail.tsx'
import type { TurnDetailState } from '../../src/client/turn-details.ts'
import { change, command, detail, detailProps, fullVerdict, reason, test } from './support.ts'

afterEach(cleanup)

const show = (state: TurnDetailState, now = 0) =>
  render(<TurnDetailView {...detailProps(state, now)} />)

describe('TurnDetailView', () => {
  it('says it is still reading rather than showing an empty turn', () => {
    // An empty changes list and "not read yet" look identical if the loading case
    // renders as nothing, and the difference is the whole reason this component
    // has four states.
    const view = show({ kind: 'loading' })
    expect(view.getByRole('status').textContent).toContain('正在读取')
  })

  it('separates "the host has no such turn" from "the host could not be asked"', () => {
    expect(show({ kind: 'absent' }).getByText('主进程没有该轮次的记录')).toBeTruthy()
    const failed = show({ kind: 'failed', reason: 'turnscope: offline' })
    expect(failed.getByRole('note').textContent).toContain('turnscope: offline')
  })

  it('says the turn has not been judged instead of showing a verdict that does not exist', () => {
    const view = show({ kind: 'value', value: detail() })
    expect(view.getByText('主进程还没有评估该轮次的安全性')).toBeTruthy()
  })

  it('reports what each recorded change was, and how confident the attribution is', () => {
    const view = show({
      kind: 'value',
      value: detail({
        changes: [
          change('src/a.ts'),
          change('src/b.ts', { kind: 'created', attribution: 'BASELINE', baseline: true }),
          change('src/c.ts', { kind: 'deleted', confidence: 'low' }),
          change('src/d.ts', { kind: 'renamed', previousPath: 'src/old.ts' }),
          change('assets/logo.png', { kind: 'binary_changed' }),
        ],
      }),
    })

    const rows = [...view.container.querySelectorAll('.turnscope-change')]
    expect(rows).toHaveLength(5)
    expect(rows[0]?.textContent).toContain('src/a.ts')
    expect(rows[0]?.textContent).toContain('本轮改动')
    expect(rows[1]?.textContent).toContain('本轮之前就已修改')
    expect(rows[1]?.textContent).toContain('本轮开始时已脏')
    // A low-confidence attribution is a different claim, not a quieter version of
    // a confident one, so it is said in words.
    expect(rows[2]?.textContent).toContain('依据不足')
    expect(rows[3]?.textContent).toContain('来自 src/old.ts')
    expect(rows[4]?.textContent).toContain('二进制变更')
    expect(rows[4]?.getAttribute('data-kind')).toBe('binary_changed')
  })

  it('shows the verdict with its reasons, its evidence, and how old it is', () => {
    const view = show(
      {
        kind: 'value',
        value: detail({
          summary: { ...detail().summary, evidenceCompleteness: 'partial' },
          safety: fullVerdict('FORK_ONLY', {
            recommendedAction: 'FORK',
            allowedActions: ['INSPECT', 'FORK'],
            evaluatedAt: 1_000,
            reasons: [
              reason('S005_TARGET_FILE_DRIFT', {
                path: 'src/a.ts',
                title: 'The file changed after the turn',
                detail: 'It was modified 12s after the turn ended.',
                evidenceRefs: ['e-1', 'e-2'],
              }),
            ],
          }),
        }),
      },
      31_000,
    )

    expect(view.container.querySelector('.turnscope-safety')?.getAttribute('data-level')).toBe('FORK_ONLY')
    expect(view.getByText('仅可分叉')).toBeTruthy()
    // `§14.2`: the action is named outright, in the recommended slot, in the
    // words the contract's own vocabulary uses — not hinted at with a verb.
    expect(view.container.querySelector('.turnscope-action')?.textContent).toContain('建议分叉后继续')
    // The evidence qualifier sits with the level: a verdict alone reads as more
    // certain than the evidence behind it.
    expect(view.getByText('证据不完整')).toBeTruthy()

    const cited = view.container.querySelector('.turnscope-reason')
    expect(cited?.getAttribute('data-severity')).toBe('CAUTION')
    expect(cited?.textContent).toContain('S005_TARGET_FILE_DRIFT')
    expect(cited?.textContent).toContain('The file changed after the turn')
    expect(cited?.textContent).toContain('src/a.ts')
    expect(cited?.textContent).toContain('依据 2 项')
    expect(view.getByText('评估于 30 秒前')).toBeTruthy()
    expect(view.getByText(/先人工检查 · 建议分叉后继续/)).toBeTruthy()
  })

  it('shows commands and their outcomes, or says there were none', () => {
    const view = show({
      kind: 'value',
      value: detail({
        commands: [command('pnpm test', { exitCode: 0, durationMs: 1200 }), command('pnpm lint')],
      }),
    })
    const rows = [...view.container.querySelectorAll('.turnscope-command')]
    expect(rows[0]?.textContent).toContain('pnpm test')
    expect(rows[0]?.textContent).toContain('退出码 0')
    expect(rows[0]?.textContent).toContain('1200 ms')
    // A command whose exit is not known says so, rather than defaulting to zero.
    expect(rows[1]?.textContent).toContain('退出码未知')

  })

  it('names each empty section, so that empty does not look like unread', () => {
    const view = show({ kind: 'value', value: detail() })
    expect(view.getByText('该轮次没有记录到命令')).toBeTruthy()
    expect(view.getByText('该轮次没有记录到文件变更')).toBeTruthy()
    expect(view.getByText('该轮次没有记录到验证命令')).toBeTruthy()
  })

  it('shows validation results as the host recorded them', () => {
    const view = show({
      kind: 'value',
      value: detail({
        tests: [test({ kind: 'typecheck', status: 'failed', summary: '2 errors' }), test()],
      }),
    })
    const rows = [...view.container.querySelectorAll('.turnscope-test')]
    expect(rows[0]?.textContent).toContain('类型检查')
    expect(rows[0]?.textContent).toContain('未通过')
    expect(rows[0]?.textContent).toContain('2 errors')
    expect(rows[1]?.getAttribute('data-result')).toBe('passed')
  })

  it('says outright that this version performs no recovery', () => {
    // `docs/PRD.md §14.3` wants the preview named before anything is written. The
    // honest V0.1 form of that is to name the write as absent, not to show a
    // disabled button that implies a future where it works.
    const view = show({ kind: 'value', value: detail() })
    expect(view.getByText('本版本不写入工作区，恢复动作由后续版本提供。')).toBeTruthy()
  })
})
