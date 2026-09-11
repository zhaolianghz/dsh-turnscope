/**
 * Tests for the boot-time rollback walker
 * (`src/host/recovery/runner/rollback.ts`).
 *
 * The walker is what makes a crashed apply recoverable: every op that
 * landed an `applied` row without a matching `verified` row gets put back
 * from the backup the runner left in the staging directory. The tests
 * below pin both halves — "the right ops get rolled back" and "the worktree
 * is left in the state the user had before the apply started" — because
 * each is a property the runner cannot check for itself.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendJournal } from '../../../../src/host/recovery/runner/journal.ts'
import { resolveDryRunRoot } from '../../../../src/host/recovery/runner/paths.ts'
import { rollbackUnfinished } from '../../../../src/host/recovery/runner/rollback.ts'
import type { RecoveryFileOperation, RecoveryJournalEntry } from '../../../../src/host/recovery/types.ts'

function entry(planId: string, seq: number, op: RecoveryFileOperation, state: RecoveryJournalEntry['state']): RecoveryJournalEntry {
  return { schemaVersion: 3, planId, seq, operation: op, state, occurredAt: 1_700_000_000_000 + seq }
}

describe('rollbackUnfinished', () => {
  let worktree: string
  let homeDir: string
  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'ts-rollback-wt-'))
    homeDir = await mkdtemp(join(tmpdir(), 'ts-rollback-home-'))
  })
  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true })
    await rm(homeDir, { recursive: true, force: true })
  })

  it('returns no rolled-back ops when the journal is empty', async () => {
    expect(await rollbackUnfinished('plan0', worktree, homeDir)).toEqual([])
  })

  it('rolls back an `applied`-without-`verified` op from the backup file', async () => {
    const planId = 'plan-mid'
    const path = 'src/f.ts'
    // Pre-existing worktree file (the user's original content).
    await mkdir(join(worktree, 'src'), { recursive: true })
    await writeFile(join(worktree, path), 'original\n')
    // Backup placed by the runner before the atomic write.
    const backupDir = join(resolveDryRunRoot(homeDir, planId), '.backup')
    await mkdir(join(backupDir, 'src'), { recursive: true })
    await writeFile(join(backupDir, path), 'original\n')
    // The apply's orphan: an `applied` row without a matching `verified`.
    await appendJournal(homeDir, entry(
      planId,
      1,
      { kind: 'restore', path, expectedCurrentHash: 'x', targetBlobRef: 'sha256:y', afterBlobRef: 'sha256:z' },
      'applied',
    ))
    const rolled = await rollbackUnfinished(planId, worktree, homeDir)
    expect(rolled).toEqual([{ planId, path, seq: 1 }])
    expect(await readFile(join(worktree, path), 'utf8')).toBe('original\n')
  })

  it('does NOT roll back ops that already have a `verified` row', async () => {
    const planId = 'plan-done'
    const path = 'src/done.ts'
    await mkdir(join(worktree, 'src'), { recursive: true })
    await writeFile(join(worktree, path), 'rewound\n')
    await appendJournal(homeDir, entry(planId, 1, { kind: 'restore', path, expectedCurrentHash: 'x', targetBlobRef: 'sha256:y', afterBlobRef: 'sha256:z' }, 'applied'))
    await appendJournal(homeDir, entry(planId, 1, { kind: 'restore', path, expectedCurrentHash: 'x', targetBlobRef: 'sha256:y', afterBlobRef: 'sha256:z' }, 'verified'))
    expect(await rollbackUnfinished(planId, worktree, homeDir)).toEqual([])
  })

  it('unlinks a file whose pre-apply did not exist (no backup present)', async () => {
    const planId = 'plan-create'
    const path = 'created.txt'
    // The apply wrote the file (we simulate that), but the file did not exist
    // before the apply, so no backup is in the .backup directory.
    await writeFile(join(worktree, path), 'agent wrote this\n')
    await appendJournal(homeDir, entry(planId, 1, { kind: 'delete_created_file', path, expectedCurrentHash: 'h' }, 'applied'))
    const rolled = await rollbackUnfinished(planId, worktree, homeDir)
    expect(rolled).toEqual([{ planId, path, seq: 1 }])
    await expect(readFile(join(worktree, path))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports per-seq outcomes independently (one rolled back, one verified)', async () => {
    const planId = 'plan-mixed'
    const p1 = 'a.txt'
    const p2 = 'b.txt'
    await mkdir(join(worktree, dirname(p1)), { recursive: true })
    await writeFile(join(worktree, p1), 'originalA\n')
    await writeFile(join(worktree, p2), 'rewoundB\n')
    // Backup only for p1.
    const backupDir = join(resolveDryRunRoot(homeDir, planId), '.backup')
    await mkdir(backupDir, { recursive: true })
    await writeFile(join(backupDir, p1), 'originalA\n')

    await appendJournal(homeDir, entry(planId, 1, { kind: 'restore', path: p1, expectedCurrentHash: 'x', targetBlobRef: 'sha256:y', afterBlobRef: 'sha256:z' }, 'applied'))
    await appendJournal(homeDir, entry(planId, 2, { kind: 'restore', path: p2, expectedCurrentHash: 'x', targetBlobRef: 'sha256:y', afterBlobRef: 'sha256:z' }, 'applied'))
    await appendJournal(homeDir, entry(planId, 2, { kind: 'restore', path: p2, expectedCurrentHash: 'x', targetBlobRef: 'sha256:y', afterBlobRef: 'sha256:z' }, 'verified'))

    const rolled = await rollbackUnfinished(planId, worktree, homeDir)
    expect(rolled).toEqual([{ planId, path: p1, seq: 1 }])
    expect(await readFile(join(worktree, p1), 'utf8')).toBe('originalA\n')
    expect(await readFile(join(worktree, p2), 'utf8')).toBe('rewoundB\n')
  })
})