/**
 * A unified diff, computed from two lists of lines.
 *
 * Pure by construction: no IO, no clock, no workspace. The bytes are somebody
 * else's problem (`reader.ts` fetches them, and has to explain itself when it
 * cannot), which is what makes this file testable as prose — every case below is
 * a table row rather than a fixture repository.
 *
 * ## What this is for, and what it is not
 *
 * It renders a diff for a human. It is **not** the source of a patch: V0.1 does
 * not write to the workspace, and V0.2's inverse patch will be built from the
 * recorded bytes, not from rendered text. That distinction buys a real
 * simplification here — line endings are normalized for comparison (see
 * {@link splitLines}), because a worktree with CRLF line endings and a git blob
 * with LF are the *same change* to a reader and a whole-file rewrite to a
 * byte-comparing differ.
 *
 * ## Why the caps exist
 *
 * A diff is the one output whose size is not bounded by its input: a one-line
 * change to a large file is small, but a rewritten large file produces every
 * line twice. The reply crosses a process boundary into a browser, so it needs a
 * ceiling, and the ceiling has to be *visible* rather than silent — a diff that
 * stopped early without saying so would be a lie about the turn.
 */
import type { DiffHunk, DiffLine } from './types.ts'

/** How many unchanged lines surround a change, per unified diff convention. */
export const DIFF_CONTEXT_LINES = 3

/**
 * Ceiling on the number of diff lines in one reply.
 *
 * Large enough for a real edit in a large file, small enough that a rewritten
 * vendored bundle does not cross the API boundary. When it bites, the reply says
 * so (`truncated`) instead of quietly ending.
 */
export const DIFF_MAX_LINES = 2000

/**
 * How far the two sides may be apart before the minimal script is abandoned.
 *
 * The search is Myers' `O(ND)`, where `D` is the number of lines that differ,
 * and the backtracking trace costs `D²`. A normal edit is single-digit `D`
 * however large the file is — changing one line in a fifty-thousand line file is
 * `D = 2`, because the common prefix and suffix are trimmed first. Only a
 * rewrite reaches this, and the right answer then is one replace hunk and a
 * `truncated` flag rather than a trace that would not fit in memory.
 */
export const DIFF_MAX_EDITS = 1024

/** One side of a comparison: its lines, and whether it ended with a newline. */
export interface DiffText {
  readonly lines: readonly string[]
  /**
   * False when the last line has no line terminator.
   *
   * Worth carrying separately rather than folding into the line list: "the file
   * ends without a newline" is a real change a reader wants to see (a diff tool
   * prints `\ No newline at end of file`) and it is invisible if the splitter
   * appends one to make the shapes uniform.
   */
  readonly endsWithNewline: boolean
}

export interface UnifiedDiffOptions {
  readonly contextLines: number
  readonly maxLines: number
  readonly maxEdits: number
}

/** Defaults for {@link unifiedDiff}, exposed so a caller can deviate knowingly. */
export const DEFAULT_DIFF_OPTIONS: UnifiedDiffOptions = Object.freeze({
  contextLines: DIFF_CONTEXT_LINES,
  maxLines: DIFF_MAX_LINES,
  maxEdits: DIFF_MAX_EDITS,
})

export interface UnifiedDiff {
  readonly hunks: readonly DiffHunk[]
  /** True when {@link UnifiedDiff.hunks} is not the whole story. */
  readonly truncated: boolean
}

/**
 * Split raw bytes into lines, or report that they are not text.
 *
 * `undefined` means binary, using git's own heuristic — a NUL byte in the first
 * part of the file — because the alternative (an encoding guess) would show a
 * reader mojibake and call it a diff.
 *
 * A trailing `\r` is stripped from every line. That is deliberate and is the one
 * lossy step in this module: `git cat-file` returns LF for a file that the
 * worktree holds as CRLF under `core.autocrlf`, so without it a one-line edit
 * would render as a whole-file rewrite. The cost is that the rendered diff
 * cannot distinguish a line-ending change from no change at all; the safety
 * engine never sees a diff, so nothing downstream inherits the imprecision.
 */
export function splitLines(bytes: Uint8Array): DiffText | undefined {
  // Only the head is scanned for NUL, matching git's own binary detection: a
  // large file with a stray NUL at the end is not text for display purposes, but
  // scanning a hundred megabytes to find it would be paid on every diff.
  const probe = bytes.subarray(0, 8000)
  if (probe.includes(0)) return undefined

  const text = Buffer.from(bytes).toString('utf8')
  if (text.length === 0) return { lines: [], endsWithNewline: true }

  const endsWithNewline = text.endsWith('\n')
  const body = endsWithNewline ? text.slice(0, -1) : text
  const lines = body.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
  return { lines, endsWithNewline }
}

/** One step of the edit script, with the line positions it consumes. */
interface Op {
  readonly kind: DiffLine['kind']
  readonly text: string
  /** 0-based index into the before-side lines; the insertion point for `add`. */
  readonly beforeIndex: number
  /** 0-based index into the after-side lines; the insertion point for `remove`. */
  readonly afterIndex: number
}

const context = (text: string, before: number, after: number): Op => ({
  kind: 'context',
  text,
  beforeIndex: before,
  afterIndex: after,
})

/**
 * Compare two line lists and return unified hunks.
 *
 * The common prefix and suffix are trimmed first, which is what makes the cost
 * proportional to the *change* rather than to the file: the search below only
 * ever sees the lines between the first and last difference.
 */
export function unifiedDiff(
  before: DiffText,
  after: DiffText,
  options: UnifiedDiffOptions = DEFAULT_DIFF_OPTIONS,
): UnifiedDiff {
  const script = editScript(before.lines, after.lines, options.maxEdits)
  const ops = script.list
  const groups = groupChanges(ops, options.contextLines)

  const hunks: DiffHunk[] = []
  let budget = options.maxLines
  let truncated = script.truncated

  for (const group of groups) {
    const from = Math.max(0, group.start - options.contextLines)
    const to = Math.min(ops.length - 1, group.end + options.contextLines)
    const slice = ops.slice(from, to + 1)

    // A single hunk can exceed the whole budget on its own — a rewritten file
    // produces one replace hunk covering everything — so the cut is by line, not
    // by hunk. Cutting mid-hunk is ugly; ending the reply with nothing at all
    // because the first hunk did not fit would be worse.
    const fitted = slice.length > budget ? slice.slice(0, budget) : slice
    if (fitted.length < slice.length) truncated = true
    if (fitted.length === 0) continue

    hunks.push(toHunk(fitted))
    budget -= fitted.length
    if (budget === 0) break
  }

  return { hunks, truncated }
}

/** The edit script, plus whether it was approximated rather than computed. */
interface EditScript {
  readonly list: readonly Op[]
  readonly truncated: boolean
}

/** One step of a script before it is given positions: what happened, and to what. */
interface EditStep {
  readonly kind: DiffLine['kind']
  readonly text: string
}

/**
 * The edit script between two line lists, by Myers' greedy algorithm.
 *
 * The reason this is Myers and not a longest-common-subsequence table is not
 * speed. An LCS table and Myers agree on *how much* can be kept; they differ on
 * *which* maximal script they produce, and the table's walk can consume one side
 * entirely while keeping the same LCS length. Concretely: a file whose first line
 * is new and whose last line was deleted has a maximal script of "remove
 * everything, then add everything", and a diff viewer showing that instead of
 * one insertion and one deletion is not wrong so much as useless. Myers searches
 * by increasing number of edits, so it finds the four-edit script — add, keep,
 * keep, …, delete — because it is looking for the shortest way across rather
 * than for any way across.
 *
 * `maxEdits` bounds the search. Past it the middle is reported as a replacement
 * and the result is flagged `truncated`, which is a true statement about the two
 * sides and a bounded amount of work.
 */
function editScript(before: readonly string[], after: readonly string[], maxEdits: number): EditScript {
  // The trim is worth its two loops: an edit in a fifty-thousand line file leaves
  // the search with the handful of lines around it rather than with the file.
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1

  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1
  }

  const middle = myers(
    before.slice(head, before.length - tail),
    after.slice(head, after.length - tail),
    maxEdits,
  )

  // Positions are assigned while reading the steps back, which is what keeps the
  // search itself free of index arithmetic: it works on two arrays and returns
  // what happened, and only here does any of it become a line number.
  const list: Op[] = []
  let beforeIndex = 0
  let afterIndex = 0
  for (const step of [
    ...before.slice(0, head).map((text): EditStep => ({ kind: 'context', text })),
    ...middle.list,
    ...before.slice(before.length - tail).map((text): EditStep => ({ kind: 'context', text })),
  ]) {
    if (step.kind === 'context') {
      list.push(context(step.text, beforeIndex, afterIndex))
      beforeIndex += 1
      afterIndex += 1
    } else if (step.kind === 'remove') {
      list.push({ kind: 'remove', text: step.text, beforeIndex, afterIndex })
      beforeIndex += 1
    } else {
      list.push({ kind: 'add', text: step.text, beforeIndex, afterIndex })
      afterIndex += 1
    }
  }

  return { list, truncated: middle.truncated }
}

/** A replacement of one side by the other, for when the search gives up. */
const replaceAll = (before: readonly string[], after: readonly string[]): readonly EditStep[] => [
  ...before.map((text): EditStep => ({ kind: 'remove', text })),
  ...after.map((text): EditStep => ({ kind: 'add', text })),
]

/**
 * Myers' `O(ND)` diff, with the backtracking trace kept.
 *
 * `trace[d]` is the furthest-reaching path for each `d`-edit diagonal, as it
 * stood *before* the `d`-th round; backtracking from the end walks those
 * snapshots and recovers the script. The `offset` shifts diagonal numbers
 * (`k = x - y`, which is negative half the time) into array indices, and `x`
 * counts lines consumed from the before side, `y` from the after side.
 *
 * The trace is what costs `D²` memory and is why `maxEdits` exists: without it
 * the script could be recovered by re-running the search, which is a slower
 * trick with the same ceiling.
 */
function myers(
  before: readonly string[],
  after: readonly string[],
  maxEdits: number,
): { readonly list: readonly EditStep[]; readonly truncated: boolean } {
  const n = before.length
  const m = after.length
  // One side empty is a pure insertion or deletion, which needs no search.
  if (n === 0 || m === 0) return { list: replaceAll(before, after), truncated: false }

  const limit = Math.min(n + m, maxEdits)
  const offset = limit + 1
  const furthest = new Int32Array(2 * offset + 1)
  const trace: Int32Array[] = []
  let found = -1

  for (let d = 0; d <= limit && found < 0; d += 1) {
    trace.push(furthest.slice())
    for (let k = -d; k <= d; k += 2) {
      // Step off the previous round's diagonal, then slide along equal lines.
      // Ties prefer deletion, which is what keeps the script's ordering stable.
      let x: number
      if (k === -d || (k !== d && furthest[offset + k - 1]! < furthest[offset + k + 1]!)) {
        x = furthest[offset + k + 1]!
      } else {
        x = furthest[offset + k - 1]! + 1
      }
      let y = x - k
      while (x < n && y < m && before[x] === after[y]) {
        x += 1
        y += 1
      }
      furthest[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
  }

  if (found < 0) return { list: replaceAll(before, after), truncated: true }
  return { list: backtrack(before, after, trace, found, offset), truncated: false }
}

/** Walk the trace backwards into the script, then read it forwards. */
function backtrack(
  before: readonly string[],
  after: readonly string[],
  trace: readonly Int32Array[],
  distance: number,
  offset: number,
): readonly EditStep[] {
  const reversed: EditStep[] = []
  let x = before.length
  let y = after.length

  for (let d = distance; d > 0; d -= 1) {
    // `trace[d]` is where the search stood before this round, so the diagonal
    // this step came from is the one the same choice rule picks out of it.
    const previous = trace[d]!
    const k = x - y
    const prevK =
      k === -d || (k !== d && previous[offset + k - 1]! < previous[offset + k + 1]!)
        ? k + 1
        : k - 1
    const prevX = previous[offset + prevK]!
    const prevY = prevX - prevK

    // The snake: every line this step kept, walked back one at a time.
    while (x > prevX && y > prevY) {
      x -= 1
      y -= 1
      reversed.push({ kind: 'context', text: before[x]! })
    }
    if (x === prevX) {
      y -= 1
      reversed.push({ kind: 'add', text: after[y]! })
    } else {
      x -= 1
      reversed.push({ kind: 'remove', text: before[x]! })
    }
  }

  // Whatever the edit distance did not account for is context at the head.
  while (x > 0 && y > 0) {
    x -= 1
    y -= 1
    reversed.push({ kind: 'context', text: before[x]! })
  }

  return reversed.reverse()
}

/** A run of changes, as positions in the edit script. */
interface ChangeGroup {
  readonly start: number
  readonly end: number
}

/**
 * Find the changed runs, merging those closer together than the surrounding
 * context would render separately.
 *
 * Two runs separated by four unchanged lines with three lines of context each
 * would produce two hunks sharing two lines; git merges them into one, and so
 * does this.
 */
function groupChanges(ops: readonly Op[], contextLines: number): readonly ChangeGroup[] {
  const groups: ChangeGroup[] = []
  let start = -1
  let lastChange = -1

  for (const [index, op] of ops.entries()) {
    if (op.kind === 'context') {
      if (start >= 0 && index - lastChange > 2 * contextLines) {
        groups.push({ start, end: lastChange })
        start = -1
      }
      continue
    }
    if (start < 0) start = index
    lastChange = index
  }
  if (start >= 0) groups.push({ start, end: lastChange })
  return groups
}

/** Turn one slice of the edit script into a hunk with a header. */
function toHunk(slice: readonly Op[]): DiffHunk {
  const lines: DiffLine[] = slice.map(op =>
    op.kind === 'context'
      ? { kind: op.kind, text: op.text, beforeLine: op.beforeIndex + 1, afterLine: op.afterIndex + 1 }
      : op.kind === 'remove'
        ? { kind: op.kind, text: op.text, beforeLine: op.beforeIndex + 1 }
        : { kind: op.kind, text: op.text, afterLine: op.afterIndex + 1 },
  )

  const first = slice[0]!
  const beforeCount = lines.filter(line => line.kind !== 'add').length
  const afterCount = lines.filter(line => line.kind !== 'remove').length

  // Unified diff's empty-range convention: a count of zero means the range
  // starts at the line *before* the insertion point, which is the 0-based index
  // the op already carries. With lines present the start is 1-based.
  return {
    beforeStart: beforeCount === 0 ? first.beforeIndex : first.beforeIndex + 1,
    beforeCount,
    afterStart: afterCount === 0 ? first.afterIndex : first.afterIndex + 1,
    afterCount,
    lines: Object.freeze(lines),
  }
}
