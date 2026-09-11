/**
 * Apply a unified-diff text to a byte buffer and report the result.
 *
 * The function is a pure validator: it does no IO, no clock, no workspace
 * touches. Its job is the "still consistent with the recorded evidence?"
 * question the dry-run asks before a rewind goes live — a `conflict` result
 * means the worktree has drifted since the checkpoint, and a blind overwrite
 * would lose the user's work.
 *
 * The function is also deliberately not the production apply path. The real
 * apply writes bytes straight from the object store after a `stateHash` guard
 * has confirmed the worktree still matches what the planner saw. `applyPatch`
 * exists to catch the case where the planner was right at preview time but
 * something changed before apply — a smaller window, but the cost of being
 * wrong is rewriting the user's edits, so we check.
 */

import type { RecoveryFileOperation } from '../types.ts'

/** Reason a patch could not be applied. */
export type ApplyConflictReason = 'hunk-offset' | 'context-mismatch' | 'binary'

/** Result of attempting to apply a unified-diff text to current bytes. */
export type ApplyPatchResult =
  | { kind: 'ok'; resultBytes: Uint8Array }
  | { kind: 'conflict'; path: string; reason: ApplyConflictReason }

export interface ApplyPatchInput {
  readonly patch: string
  readonly currentBytes: Uint8Array
  readonly path: string
}

/** A parsed line from the patch body, with its prefix kind. */
type PatchLine =
  | { kind: 'context'; text: string; noNewline: boolean }
  | { kind: 'remove'; text: string; noNewline: boolean }
  | { kind: 'add'; text: string; noNewline: boolean }

/** A parsed hunk header. */
interface ParsedHunk {
  readonly beforeStart: number
  readonly beforeCount: number
  readonly afterStart: number
  readonly afterCount: number
  readonly body: readonly PatchLine[]
}

/**
 * Parse the textual patch into headers + hunks.
 *
 * The format is git's: `--- a/path`, `+++ b/path`, then zero or more hunks of
 * the form `@@ -before,bc +after,ac @@` followed by ` ` / `-` / `+` lines, with
 * an optional `\ No newline at end of file` marker before each hunk's last
 * line that lacked one.
 */
function parsePatch(patch: string): { hunks: readonly ParsedHunk[]; binary: boolean } {
  const lines = patch.split('\n')
  let i = 0
  // Skip the file header lines.
  while (i < lines.length && (lines[i]!.startsWith('--- ') || lines[i]!.startsWith('+++ '))) {
    i += 1
  }
  if (i < lines.length && lines[i] === 'Binary files differ') {
    return { hunks: [], binary: true }
  }
  const hunks: ParsedHunk[] = []
  while (i < lines.length) {
    const header = lines[i]!
    if (!header.startsWith('@@ ')) {
      i += 1
      continue
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)
    if (m === null) {
      i += 1
      continue
    }
    i += 1
    const beforeStart = Number(m[1])
    const beforeCount = m[2] === undefined ? 1 : Number(m[2])
    const afterStart = Number(m[3])
    const afterCount = m[4] === undefined ? 1 : Number(m[4])
    const body: PatchLine[] = []
    while (i < lines.length) {
      const raw = lines[i]!
      if (raw.startsWith('@@ ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) break
      if (raw === '\\ No newline at end of file') {
        // Attach to the previous body line.
        const prev = body[body.length - 1]
        if (prev !== undefined) {
          body[body.length - 1] = { kind: prev.kind, text: prev.text, noNewline: true }
        }
        i += 1
        continue
      }
      if (raw.startsWith(' ')) body.push({ kind: 'context', text: raw.slice(1), noNewline: false })
      else if (raw.startsWith('-')) body.push({ kind: 'remove', text: raw.slice(1), noNewline: false })
      else if (raw.startsWith('+')) body.push({ kind: 'add', text: raw.slice(1), noNewline: false })
      i += 1
    }
    hunks.push({ beforeStart, beforeCount, afterStart, afterCount, body })
  }
  return { hunks, binary: false }
}

/**
 * Split bytes into lines and CR-normalize each line, mirroring V0.1's
 * `splitLines` (trailing `\r` stripped so a CRLF worktree matches an LF git
 * blob). The trailing-newline flag is preserved so the apply path can omit
 * the trailing `\n` when the source did not have one.
 */
function splitWithCrlf(bytes: Uint8Array): { lines: string[]; trailingNewline: boolean } {
  if (bytes.length === 0) return { lines: [], trailingNewline: true }
  const text = Buffer.from(bytes).toString('utf8')
  const trailingNewline = text.endsWith('\n')
  const body = trailingNewline ? text.slice(0, -1) : text
  const lines = body.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
  return { lines, trailingNewline }
}

function joinLines(lines: readonly string[], trailingNewline: boolean): Uint8Array {
  if (lines.length === 0) return trailingNewline ? new Uint8Array([0x0a]) : new Uint8Array()
  const sep = '\n'
  const text = lines.join(sep) + (trailingNewline ? sep : '')
  return new Uint8Array(Buffer.from(text, 'utf8'))
}

export function applyPatch(input: ApplyPatchInput): ApplyPatchResult {
  const parsed = parsePatch(input.patch)
  if (parsed.binary) {
    return { kind: 'conflict', path: input.path, reason: 'binary' }
  }

  const split = splitWithCrlf(input.currentBytes)
  const lines = [...split.lines]
  let result: string[] = []

  let cursor = 0
  for (let h = 0; h < parsed.hunks.length; h += 1) {
    const hunk = parsed.hunks[h]!
    const hunkStart = hunk.beforeStart - 1 // 1-based to 0-based
    if (hunkStart < cursor) {
      return { kind: 'conflict', path: input.path, reason: 'hunk-offset' }
    }
    // Copy context / matching lines from current up to the hunk's start.
    while (cursor < hunkStart) {
      result.push(lines[cursor] ?? '')
      cursor += 1
    }
    // Try to position the hunk exactly at `hunkStart`; if the first body line
    // is supposed to be a `context` line and it doesn't match, search ±20 lines
    // for one that does.
    let appliedAt = hunkStart
    let bodyCursor = 0
    while (bodyCursor < hunk.body.length) {
      const line = hunk.body[bodyCursor]!
      if (line.kind === 'context') {
        const current = lines[appliedAt]
        if (current === line.text) {
          result.push(line.text)
          appliedAt += 1
          cursor = appliedAt
          bodyCursor += 1
          continue
        }
        // Search ±20 for a matching context line.
        const search = (start: number, step: number): number => {
          for (let i = start; step > 0 ? i < start + 20 * step && i < lines.length && i >= 0 : i > start + 20 * step && i >= 0; i += step) {
            if (lines[i] === line.text) return i
          }
          return -1
        }
        const nextMatch = search(appliedAt, 1)
        if (nextMatch >= 0) {
          // Copy any unmatched lines between `appliedAt` and `nextMatch` as-is.
          for (let i = appliedAt; i < nextMatch; i += 1) {
            result.push(lines[i] ?? '')
          }
          result.push(line.text)
          appliedAt = nextMatch + 1
          cursor = appliedAt
          bodyCursor += 1
          continue
        }
        // Look backward, but only as a last resort — backward matches usually
        // mean a previous hunk is wrong, so it's a `hunk-offset` not a
        // `context-mismatch`.
        const prevMatch = search(appliedAt, -1)
        if (prevMatch >= 0) {
          return { kind: 'conflict', path: input.path, reason: 'hunk-offset' }
        }
        return { kind: 'conflict', path: input.path, reason: 'context-mismatch' }
      }
      if (line.kind === 'remove') {
        const current = lines[appliedAt]
        if (current !== line.text) {
          return { kind: 'conflict', path: input.path, reason: 'context-mismatch' }
        }
        appliedAt += 1
        cursor = appliedAt
        bodyCursor += 1
        continue
      }
      // `add`: line appears in the new side but not the old.
      result.push(line.text)
      bodyCursor += 1
    }
    // After a hunk, push the remaining context lines (the tail of the hunk
    // body that is all `context` has already been consumed). When the hunk's
    // body ends with adds, no consumption of `lines` happens — that's fine.
    void h // keep linter quiet; `h` used in `hunk.body` indexing.
  }
  // Tail: copy any remaining lines past the last hunk.
  while (cursor < lines.length) {
    result.push(lines[cursor] ?? '')
    cursor += 1
  }
  return { kind: 'ok', resultBytes: joinLines(result, split.trailingNewline) }
}

// Keep the discriminated-union symbol in scope so TypeScript narrows the
// RecoveryFileOperation shape correctly when this module is loaded by a caller
// that imports it transitively through `recovery/types.ts`.
export type { RecoveryFileOperation }