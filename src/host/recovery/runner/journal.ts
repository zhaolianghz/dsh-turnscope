/**
 * The apply journal: a JSONL file at
 * `<recoveryRoot>/journal/<planId>.jsonl`.
 *
 * Per `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §5.5`,
 * the journal is the **only** way a crashed apply can be detected on next
 * boot. Without it, a half-applied workspace would look indistinguishable
 * from one that was never started, and a subsequent apply would happily
 * rewrite work the previous apply had not finished.
 *
 * The file is JSONL rather than a single JSON blob so the runner can append
 * atomically with a single `writeFile(O_APPEND)` call (or two for the
 * durability guarantee in {@link appendJournal}); it also means a crashed
 * journal that was being written at the moment of the crash is still
 * parsable up to the last complete line.
 *
 * Read side: {@link readJournal} returns the entries in order, ignoring any
 * trailing partial line (a torn write).
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { RecoveryJournalEntry } from '../types.ts'
import { resolveJournalPath } from './paths.ts'

/**
 * Append one entry to the journal, atomically with respect to a concurrent
 * reader.
 *
 * The atomicity guarantee comes from `appendFile`'s POSIX semantics: the
 * kernel writes one record in a single `O_APPEND` write(2) call, and two
 * concurrent writers each land at the previous end-of-file. The crash
 * guarantee is that whatever bytes are on disk at any moment either end in
 * a complete line or in the previous complete line; a torn write would
 * truncate the trailing partial line, which {@link readJournal} discards.
 *
 * The journal directory is created on the first append, so callers do not
 * have to arrange for it.
 */
export async function appendJournal(
  recoveryRoot: string,
  entry: RecoveryJournalEntry,
): Promise<void> {
  const path = resolveJournalPath(recoveryRoot, entry.planId)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(entry) + '\n', { mode: 0o600 })
}

/**
 * Read a plan's journal file, returning the entries in append order.
 *
 * Returns `[]` when the journal does not exist (a freshly-planned plan).
 * Returns the entries that were successfully written when the file is
 * truncated mid-line; the trailing partial JSON is silently dropped.
 */
export async function readJournal(
  recoveryRoot: string,
  planId: string,
): Promise<readonly RecoveryJournalEntry[]> {
  const path = resolveJournalPath(recoveryRoot, planId)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const out: RecoveryJournalEntry[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    try {
      out.push(JSON.parse(line) as RecoveryJournalEntry)
    } catch {
      // A torn line at the end of the file is expected after a crash; drop
      // it rather than fail the boot-time recovery walk.
    }
  }
  return out
}

/**
 * Remove the journal file.
 *
 * Called by the RPC handler when an apply has either completed cleanly or
 * rolled back to completion. A half-written journal that gets deleted is
 * exactly the state we want: the next plan starts with a clean slate.
 */
export async function deleteJournal(recoveryRoot: string, planId: string): Promise<void> {
  const path = resolveJournalPath(recoveryRoot, planId)
  await rename(path, `${path}.bak`).catch(() => undefined)
}

/** Internal helper used by tests: write a journal from scratch. */
export async function writeJournalSnapshot(
  recoveryRoot: string,
  planId: string,
  entries: readonly RecoveryJournalEntry[],
): Promise<void> {
  const path = resolveJournalPath(recoveryRoot, planId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
}