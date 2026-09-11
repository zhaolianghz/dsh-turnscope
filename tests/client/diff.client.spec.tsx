// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DiffView } from '../../src/client/DiffView.tsx'
import type { GetDiffData } from '../../src/shared/contracts/api.ts'
import type { FileDiffState } from '../../src/client/file-diffs.ts'
import { fileDiff, hunk, line, side, translate } from './support.ts'

afterEach(cleanup)

const show = (state: FileDiffState) =>
  render(<DiffView state={state} t={translate as unknown as Parameters<typeof DiffView>[0]['t']} />)

const available = (diff: Partial<GetDiffData['diff']> = {}): FileDiffState => ({
  kind: 'value',
  value: fileDiff('src/a.ts', diff),
})

describe('DiffView', () => {
  it('draws the comparison with the marks that carry its meaning', () => {
    const view = show(available({
      availability: {
        kind: 'text',
        truncated: false,
        hunks: [
          hunk({
            beforeStart: 10,
            beforeCount: 3,
            afterStart: 10,
            afterCount: 4,
            lines: [
              line('context', 'const a = 1', 10, 10),
              line('remove', 'const b = 2', 11),
              line('add', 'const b = 3', undefined, 11),
              line('add', 'const c = 4', undefined, 12),
            ],
          }),
        ],
      },
    }))

    expect(view.getByText('@@ -10,3 +10,4 @@')).toBeTruthy()
    const lines = [...view.container.querySelectorAll('.turnscope-diff-line')]
    expect(lines.map(element => element.getAttribute('data-kind'))).toEqual([
      'context',
      'remove',
      'add',
      'add',
    ])
    // The `+`/`-`/space is the meaning; the stylesheet may colour it as well, but
    // `docs/PRD.md §14.4` means a reader with no colour still has the diff.
    expect(lines[1]?.querySelector('.turnscope-diff-mark')?.textContent).toBe('-')
    expect(lines[2]?.querySelector('.turnscope-diff-mark')?.textContent).toBe('+')
    // Line numbers are per side, and the side a line does not exist on is blank
    // rather than showing the other side's number.
    expect([...lines[2]!.querySelectorAll('.turnscope-diff-number')].map(n => n.textContent)).toEqual(['', '11'])
    expect(lines[1]?.textContent).toContain('const b = 2')
  })

  it('says a comparison is a prefix rather than letting the last hunk look like the end', () => {
    const view = show(available({
      availability: { kind: 'text', truncated: true, hunks: [hunk()] },
    }))
    expect(view.getByRole('note').textContent).toContain('只显示前一部分')
  })

  it('explains a binary file instead of drawing an empty one', () => {
    const view = show(available({
      availability: { kind: 'binary' },
      before: side({ source: 'recovery-blob', byteSize: 1024, lineCount: 0 }),
      after: side({ source: 'recovery-blob', byteSize: 2048, lineCount: 0 }),
    }))

    expect(view.getByText('二进制文件：只比较体积与摘要，不做逐行对比')).toBeTruthy()
    // The sizes are still offered: for a binary file they are the comparison.
    expect(view.getByText(/1024 字节/)).toBeTruthy()
    expect(view.getByText(/2048 字节/)).toBeTruthy()
    expect(view.container.querySelectorAll('.turnscope-diff-line')).toHaveLength(0)
  })

  it('gives the reason when there is no comparison, and keeps the reason apart from the content', () => {
    // The three reasons are three different problems with three different fixes:
    // capture policy, retention, and the environment. A single "unavailable" would
    // make them the same problem and therefore unsupportable
    // (`docs/ARCHITECTURE.md §28.3`).
    const view = show(available({
      availability: {
        kind: 'unavailable',
        reason: 'not-recorded',
        detail: 'The file was over the size limit when the checkpoint ran.',
      },
    }))

    const note = view.getByRole('note')
    expect(note.textContent).toContain('无法生成差异')
    expect(note.textContent).toContain('未保存内容')
    // The host's sentence, shown as written: it was written where the missing bytes
    // are known to be missing.
    expect(note.textContent).toContain('The file was over the size limit when the checkpoint ran.')
  })

  it('names the reason for each kind of unavailability', () => {
    const reasons = {
      'no-checkpoint': '缺少检查点',
      'not-recorded': '未保存内容',
      'missing-blob': '内容已不可用',
      'git-unavailable': '无法访问仓储',
    } as const
    for (const [reason, label] of Object.entries(reasons)) {
      const view = show(available({
        availability: { kind: 'unavailable', reason: reason as keyof typeof reasons, detail: '.' },
      }))
      expect(view.getByRole('note').textContent).toContain(label)
      cleanup()
    }
  })

  it('distinguishes a side whose bytes are gone from a side that never existed', () => {
    const gone = show(available({ before: side({ source: 'unknown', byteSize: 0, lineCount: 0 }) }))
    expect(gone.getByText(/内容未能读取/)).toBeTruthy()
    cleanup()

    // A created file's before side is `absent`, which is a fact about the turn,
    // not a failure to read anything.
    const created = show(available({ kind: 'created', before: side({ source: 'absent', byteSize: 0, lineCount: 0 }) }))
    expect(created.getByText(/文件不存在/)).toBeTruthy()
  })

  it('notices a file that stopped ending in a newline', () => {
    // Invisible in the hunks themselves, and a real change: a renderer that
    // appends terminators of its own would hide it entirely.
    const view = show(available({ after: side({ endsWithNewline: false }) }))
    expect(view.getByText('末尾无换行')).toBeTruthy()
  })

  it('says what it is doing, and what it could not do, without showing an empty diff', () => {
    expect(show({ kind: 'loading' }).getByRole('status').textContent).toContain('正在读取差异')
    cleanup()
    expect(show({ kind: 'absent' }).getByText('该轮次没有记录到这条路径的差异')).toBeTruthy()
    cleanup()
    const failed = show({ kind: 'failed', reason: 'gateway: no such endpoint' })
    expect(failed.getByRole('note').textContent).toContain('gateway: no such endpoint')
  })

  it('carries the attribution into the diff, because a diff without it invites the wrong conclusion', () => {
    const view = show(available({ attribution: 'BASELINE', baseline: true, confidence: 'medium' }))
    expect(view.getByText('本轮之前就已修改')).toBeTruthy()
    expect(view.container.querySelector('.turnscope-attribution')?.getAttribute('data-attribution')).toBe('BASELINE')
  })
})
