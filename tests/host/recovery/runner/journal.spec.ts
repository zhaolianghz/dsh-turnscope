/**
 * Tests for the apply journal
 * (`src/host/recovery/runner/journal.ts`).
 *
 * The journal is the only durable record of an apply's progress, so the
 * tests pin two properties: append/read round-trip, and resilience to a
 * torn final line (a crash mid-write leaves the file mid-line, and the
 * reader must still return the complete entries that came before).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  appendJournal,
  deleteJournal,
  readJournal,
  writeJournalSnapshot,
} from '../../../../src/host/recovery/runner/journal.ts'
import { resolveJournalPath } from '../../../../src/host/recovery/runner/paths.ts'
import type { RecoveryJournalEntry } from '../../../../src/host/recovery/types.ts'

function entry(planId: string, seq: number, state: RecoveryJournalEntry['state']): RecoveryJournalEntry {
  return {
    schemaVersion: 3,
    planId,
    seq,
    operation: { kind: 'noop', path: 'a.txt', reason: 'unchanged' },
    state,
    occurredAt: 1_700_000_000_000 + seq,
  }
}

describe('journal', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ts-journal-'))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('returns [] when the journal does not exist', async () => {
    expect(await readJournal(tmp, 'plan1')).toEqual([])
  })

  it('append + read round-trip preserves order and content', async () => {
    await appendJournal(tmp, entry('plan1', 1, 'applied'))
    await appendJournal(tmp, entry('plan1', 2, 'verified'))
    await appendJournal(tmp, entry('plan1', 3, 'rolled_back'))
    const got = await readJournal(tmp, 'plan1')
    expect(got.map(e => [e.seq, e.state])).toEqual([
      [1, 'applied'],
      [2, 'verified'],
      [3, 'rolled_back'],
    ])
  })

  it('discards a torn trailing line (incomplete JSON)', async () => {
    const planId = 'plan-torn'
    await appendJournal(tmp, entry(planId, 1, 'applied'))
    await appendJournal(tmp, entry(planId, 2, 'verified'))
    // Append a half-written JSON object.
    const path = resolveJournalPath(tmp, planId)
    const fh = await import('node:fs/promises').then(m => m.open(path, 'a'))
    try {
      await fh.writeFile('{"planId":"plan-torn","seq":3,"operation":{"kind":"n')
    } finally {
      await fh.close()
    }
    const got = await readJournal(tmp, planId)
    expect(got.map(e => e.seq)).toEqual([1, 2])
  })

  it('handles two plans side-by-side without mixing them up', async () => {
    await appendJournal(tmp, entry('pA', 1, 'applied'))
    await appendJournal(tmp, entry('pB', 1, 'applied'))
    const a = await readJournal(tmp, 'pA')
    const b = await readJournal(tmp, 'pB')
    expect(a.every(e => e.planId === 'pA')).toBe(true)
    expect(b.every(e => e.planId === 'pB')).toBe(true)
  })

  it('deleteJournal removes the file (rename to .bak is the public contract)', async () => {
    await appendJournal(tmp, entry('plan-del', 1, 'applied'))
    await deleteJournal(tmp, 'plan-del')
    await expect(readJournal(tmp, 'plan-del')).resolves.toEqual([])
  })

  it('writeJournalSnapshot overwrites with a single shot (test-only helper)', async () => {
    await appendJournal(tmp, entry('snap', 1, 'applied'))
    await writeJournalSnapshot(tmp, 'snap', [entry('snap', 5, 'rolled_back')])
    const got = await readJournal(tmp, 'snap')
    expect(got.map(e => e.seq)).toEqual([5])
  })

  it('creates the journal directory on first append (caller has nothing to set up)', async () => {
    const subRoot = join(tmp, 'no-such-dir', 'yet')
    await appendJournal(subRoot, entry('lazy', 1, 'applied'))
    const got = await readJournal(subRoot, 'lazy')
    expect(got).toHaveLength(1)
  })

  it('readJournal propagates non-ENOENT errors (permission, IO)', async () => {
    // Force an EBADF-style failure by passing a path whose parent is a file,
    // not a directory: readFile will fail with EISDIR or ENOTDIR depending
    // on platform, both of which must propagate.
    const blocker = join(tmp, 'blocker')
    await mkdir(blocker)
    await writeFile(join(blocker, 'not-a-dir'), 'x')
    await expect(readJournal(join(blocker, 'not-a-dir'), 'planX')).rejects.toBeDefined()
  })
})