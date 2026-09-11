/**
 * The diff renderer, as a table of cases.
 *
 * Nothing here touches a repository, a store, or a clock: `unifiedDiff` is a
 * function of two line lists, and this file is what proves it. The cases are
 * chosen for the decisions the implementation actually makes — where a hunk
 * starts and ends, how a missing line terminator is represented, and what the
 * caps do when they bite — rather than for coverage of the diff format at large.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DIFF_OPTIONS,
  splitLines,
  unifiedDiff,
  type UnifiedDiffOptions,
} from '../../../src/host/diff/unified.ts'
import type { DiffHunk } from '../../../src/host/diff/types.ts'

const bytes = (text: string): Uint8Array => Buffer.from(text, 'utf8')

/** `l1` … `lN`, so a rendered hunk can be asserted line by line. */
const lines = (count: number, from = 1): string =>
  `${Array.from({ length: count }, (_, i) => `l${i + from}`).join('\n')}\n`

/** The same, without the trailing newline, for a case that needs the last line. */
const numbered = (count: number): string => lines(count).slice(0, -1)

/** A side from a string, so a case can be written the way a file reads. */
const side = (text: string) => {
  const split = splitLines(bytes(text))
  if (split === undefined) throw new Error('the fixture was not text')
  return split
}

const options = (overrides: Partial<UnifiedDiffOptions> = {}): UnifiedDiffOptions => ({
  ...DEFAULT_DIFF_OPTIONS,
  ...overrides,
})

/** The rendered shape of a hunk, as a reader would see it, one string per line. */
const render = (hunk: DiffHunk): readonly string[] =>
  hunk.lines.map(line =>
    `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`,
  )

describe('splitLines', () => {
  it('keeps the lines of a file that ends with a newline', () => {
    expect(side('a\nb\n')).toEqual({ lines: ['a', 'b'], endsWithNewline: true })
  })

  it('records a missing final newline instead of inventing one', () => {
    // The distinction is the whole reason this is not `.split('\n')`: a file
    // that gained a final newline changed, and a renderer that cannot say so
    // makes the change invisible.
    expect(side('a\nb')).toEqual({ lines: ['a', 'b'], endsWithNewline: false })
  })

  it('treats an empty file as no lines at all', () => {
    expect(side('')).toEqual({ lines: [], endsWithNewline: true })
  })

  it('strips carriage returns so a CRLF worktree is not a whole-file change', () => {
    // A file committed with LF and checked out with CRLF is byte-different and
    // semantically identical. Comparing raw lines would show every line as
    // changed, which is the failure this normalization exists to prevent.
    expect(side('a\r\nb\r\n')).toEqual({ lines: ['a', 'b'], endsWithNewline: true })
  })

  it('refuses to call binary content text', () => {
    expect(splitLines(Uint8Array.from([0x41, 0x00, 0x42]))).toBeUndefined()
  })
})

describe('unifiedDiff', () => {
  it('reports no hunks when the two sides are equal', () => {
    // Reachable in practice: a path can be reported as changed for a reason that
    // is not its content (a mode change), and that is not a lie about the bytes.
    expect(unifiedDiff(side('a\n'), side('a\n'))).toEqual({ hunks: [], truncated: false })
  })

  it('numbers a modified line on both sides', () => {
    const { hunks } = unifiedDiff(side('a\nb\nc\n'), side('a\nB\nc\n'))

    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({
      beforeStart: 1,
      beforeCount: 3,
      afterStart: 1,
      afterCount: 3,
    })
    expect(render(hunks[0]!)).toEqual([' a', '-b', '+B', ' c'])
  })

  it('groups two changes that are closer than the context would separate', () => {
    const before = side('1\n2\n3\n4\n5\n6\n7\n8\n9\n')
    const after = side('1\nX\n3\n4\n5\n6\n7\nY\n9\n')

    // Seven lines apart with three lines of context each: git emits one hunk,
    // and so do we, because two hunks here would repeat lines 5 and 6.
    expect(unifiedDiff(before, after).hunks).toHaveLength(1)
  })

  it('keeps an insertion and a deletion apart instead of replacing the file', () => {
    // The regression this exists for: a line added at the top and a line deleted
    // at the end are not trimmable prefix/suffix, and a longest-common-
    // subsequence walk could keep the same number of lines while consuming one
    // side entirely — rendering a two-line change as a whole-file rewrite. Myers
    // searches by edit count, so it does not.
    const lines = numbered(30)
    const { hunks } = unifiedDiff(side(lines), side(`X\n${numbered(28)}\nY\n`))

    expect(hunks).toHaveLength(2)
    expect(render(hunks[0]!)).toEqual(['+X', ' l1', ' l2', ' l3'])
    expect(render(hunks[1]!)).toEqual([' l26', ' l27', ' l28', '-l29', '-l30', '+Y'])
  })

  it('splits changes that are further apart than the context', () => {
    const before = side(lines(30))
    const after = side(`X1\n${lines(28, 2)}Y30\n`)

    const { hunks } = unifiedDiff(before, after)

    expect(hunks).toHaveLength(2)
    expect(hunks[0]!.beforeStart).toBe(1)
    expect(render(hunks[0]!)).toEqual(['-l1', '+X1', ' l2', ' l3', ' l4'])
    // The second hunk opens three lines before its change rather than at it:
    // the change is `l30`, and the context runs back through `l27`.
    expect(hunks[1]!.beforeStart).toBe(27)
    expect(render(hunks[1]!)).toEqual([' l27', ' l28', ' l29', '-l30', '+Y30'])
  })

  it('clamps the context at the ends of the file', () => {
    const { hunks } = unifiedDiff(side('a\nb\n'), side('a\nB\n'))

    expect(hunks[0]).toMatchObject({ beforeStart: 1, beforeCount: 2, afterStart: 1, afterCount: 2 })
  })

  it('writes a creation as additions with an empty before range', () => {
    const { hunks } = unifiedDiff(side(''), side('one\ntwo\n'))

    // `-0,0` is the unified diff convention for "inserted before line 1": with a
    // count of zero the start is the line *before* the insertion point, which is
    // why it is not `1`.
    expect(hunks[0]).toMatchObject({ beforeStart: 0, beforeCount: 0, afterStart: 1, afterCount: 2 })
    expect(render(hunks[0]!)).toEqual(['+one', '+two'])
  })

  it('writes a deletion as removals with an empty after range', () => {
    const { hunks } = unifiedDiff(side('one\ntwo\n'), side(''))

    expect(hunks[0]).toMatchObject({ afterStart: 0, afterCount: 0, beforeStart: 1, beforeCount: 2 })
    expect(render(hunks[0]!)).toEqual(['-one', '-two'])
  })

  it('reports a large rewrite as one replacement and says it is truncated', () => {
    const before = side(`${Array.from({ length: 40 }, (_, i) => `old ${i}`).join('\n')}\n`)
    const after = side(`${Array.from({ length: 40 }, (_, i) => `new ${i}`).join('\n')}\n`)

    // An edit-distance cap of one stops the search immediately, so the middle is
    // reported as replaced rather than searched.
    const { hunks, truncated } = unifiedDiff(before, after, options({ maxEdits: 1 }))

    expect(truncated).toBe(true)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.lines.filter(line => line.kind === 'remove')).toHaveLength(40)
    expect(hunks[0]!.lines.filter(line => line.kind === 'add')).toHaveLength(40)
  })

  it('stops at the output ceiling and flags the cut', () => {
    const before = side(`${Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')}\n`)
    const after = side(`${Array.from({ length: 100 }, (_, i) => `changed ${i}`).join('\n')}\n`)

    const { hunks, truncated } = unifiedDiff(before, after, options({ maxLines: 10 }))

    expect(truncated).toBe(true)
    expect(hunks.flatMap(hunk => hunk.lines)).toHaveLength(10)
  })

  it('does not flag truncation when the whole diff fits', () => {
    const { truncated } = unifiedDiff(side('a\n'), side('b\n'), options({ maxLines: 10 }))
    expect(truncated).toBe(false)
  })
})
