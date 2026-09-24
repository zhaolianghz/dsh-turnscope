/**
 * Boot-time recovery walk, per
 * `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §5.6`.
 *
 * A previous run may have crashed after preparing or changing one or more
 * files. New journals restore the entire prepared transaction in reverse
 * order; old journals retain their per-operation recovery rule. A file the
 * user changed after the crash is left untouched for manual inspection.
 *
 * The function is pure with respect to the journal and the staging dir:
 * it does not touch the SQLite index, does not re-run the planner, does not
 * call git. It is one of two entry points the host can use to recover from
 * a crash (the other is "ask the user to confirm a fresh apply").
 */

import { copyFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

import type { RecoveryJournalEntry } from '../types.ts'
import { readJournal } from './journal.ts'
import { resolveDryRunRoot } from './paths.ts'

/** One op the boot-time walker decided to roll back. */
export interface RolledBackOp {
  readonly planId: string
  readonly path: string
  /** The seq of the journal entry that identified this operation. */
  readonly seq: number
}

/**
 * Walk the journal for `planId` and restore the interrupted transaction.
 *
 * The "latest entry per (seq, state)" semantics come straight from the
 * three-tuple journal PK: `(plan_id, seq, state)` only collides on the same
 * `state`, so a hunk has at most one entry per state. The walker therefore
 * filters `applied` by checking that no `verified` for the same `seq` is in
 * the journal.
 */
export async function rollbackUnfinished(
  planId: string,
  worktreeRoot: string,
  homeDir: string,
): Promise<readonly RolledBackOp[]> {
  const entries = await readJournal(homeDir, planId)
  // New journals have a durable `prepared` entry before every mutation. If an
  // apply crashes, the entire transaction must be undone, including operations
  // that were verified before the crash. Keep the old per-op rule for journals
  // written by earlier versions.
  const prepared = entries.filter(entry => entry.state === 'prepared')
  if (prepared.length > 0) {
    const completed = new Set(entries.filter(entry => entry.state === 'rolled_back').map(entry => entry.operation.path))
    const rolledBack: RolledBackOp[] = []
    for (const entry of prepared.reverse()) {
      if (completed.has(entry.operation.path)) continue
      const target = join(worktreeRoot, entry.operation.path)
      const backup = join(resolveDryRunRoot(homeDir, planId), '.backup', entry.operation.path)
      const currentHash = await hashIfPresent(target)
      const originalHash = await hashIfPresent(backup)
      const appliedHash = entry.operation.kind === 'delete_created_file'
        ? null
        : entry.operation.kind === 'noop' ? originalHash : entry.operation.targetBlobRef
      if (currentHash !== originalHash && currentHash !== appliedHash) {
        throw new Error(`${entry.operation.path}: changed after interrupted apply`)
      }
      await restoreBackup(planId, entry.operation.path, worktreeRoot, homeDir)
      rolledBack.push({ planId, path: entry.operation.path, seq: entry.seq })
    }
    return rolledBack
  }

  // Legacy journals have no `prepared` entry. An op is unfinished iff it has
  // an `applied` row but no `verified` row.
  const bySeq = new Map<number, RecoveryJournalEntry[]>()
  for (const e of entries) {
    const list = bySeq.get(e.seq) ?? []
    list.push(e)
    bySeq.set(e.seq, list)
  }

  const rolledBack: RolledBackOp[] = []
  for (const [seq, list] of bySeq) {
    const states = new Set(list.map(e => e.state))
    if (states.has('verified')) continue
    const applied = list.find(e => e.state === 'applied')
    if (applied === undefined) continue

    await restoreBackup(planId, applied.operation.path, worktreeRoot, homeDir)

    rolledBack.push({ planId, path: applied.operation.path, seq })
  }

  return rolledBack
}

async function hashIfPresent(path: string): Promise<string | null> {
  try {
    return `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function restoreBackup(planId: string, path: string, worktreeRoot: string, homeDir: string): Promise<void> {
  const backupPath = join(resolveDryRunRoot(homeDir, planId), '.backup', path)
  const target = join(worktreeRoot, path)
  try {
    await stat(backupPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await unlink(target).catch(e => {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    })
    return
  }
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.turnscope-rollback-${randomUUID()}`
  await copyFile(backupPath, temp)
  await rename(temp, target)
}
