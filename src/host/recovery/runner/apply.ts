/**
 * The apply runner, per
 * `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §5.5`–§5.7`.
 *
 * The runner validates every target before writing, journals each operation
 * before mutation, and restores all prepared paths if an operation fails.
 * On a crash, startup recovery uses the retained journal and backups.
 *
 * The atomicity comes from `rename`, which is the POSIX renameat(2) call:
 * the kernel guarantees that a successful rename is visible to every
 * concurrent reader as either the old file or the new file, never neither.
 * `fsync` on the directory makes that visibility durable across a crash.
 *
 * The runner refuses to call git. There is no `git apply`, no
 * `git checkout`, no `git reset --hard`. The plan comes from
 * state-checked evidence, and the runner writes the bytes straight from
 * the object store; if the user wants a `git` operation they can do one
 * after the apply has returned.
 */

import { mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

import type { ObjectStore } from '../../storage/object-store.ts'
import { applyPatch } from '../patch/apply.ts'
import { reverseDerive } from '../patch/reverse-derive.ts'
import type {
  RecoveryFileOperation,
  RecoveryJournalEntry,
  RecoveryJournalState,
  RecoveryPlan,
  RecoveryResult,
} from '../types.ts'
import { appendJournal } from './journal.ts'
import { resolveDryRunRoot } from './paths.ts'

/** Counter used to give every journal entry a stable, monotonic `seq`. */
export interface ApplyClock {
  nextSeq(): number
  nowMs(): number
}

/** What the runner needs from the live world. */
export interface ApplyLiveContext {
  /**
   * Hash the bytes that are *currently* on disk at `path`. `null` means the
   * file does not exist (deleted). Used for the drift guard before each
   * `restore` op.
   */
  readonly hashCurrent: (path: string) => Promise<string | null>
  /**
   * Read the bytes currently on disk at `path`. Used for the `applyPatch`
   * structural check that runs after `restore` writes the bytes.
   */
  readonly readCurrent: (path: string) => Promise<Uint8Array | null>
}

/** Result of a single op within the apply. */
export type ApplyOpResult =
  | { kind: 'applied'; op: RecoveryFileOperation }
  | { kind: 'rolled_back'; op: RecoveryFileOperation; reason: string }
  | { kind: 'failed'; op: RecoveryFileOperation; reason: string }

export interface ApplyRunInput {
  readonly plan: RecoveryPlan
  readonly worktreeRoot: string
  /** Data root of the recovery store — the journal lives under this. */
  readonly homeDir: string
  readonly objectStore: ObjectStore
  readonly live: ApplyLiveContext
  readonly clock: ApplyClock
}

/**
 * Atomic write: write `bytes` to a temp file in the same directory as
 * `target`, fsync, then rename on top of `target`. The rename is the
 * atomicity primitive — a crash between the write and the rename leaves the
 * old file in place. The directory is synced after rename for durability.
 *
 * Same-filesystem constraint: the temp file and the target must live on the
 * same filesystem so `rename` is atomic. V0.2's host always satisfies this
 * because the runner's temp files live in the worktree's parent.
 */
async function atomicWrite(target: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  let previousMode: number | undefined
  try {
    previousMode = (await stat(target)).mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const tempPath = `${target}.turnscope-${process.pid}-${randomUUID()}`
  const fh = await open(tempPath, 'wx', 0o600)
  try {
    await fh.writeFile(bytes)
    if (previousMode !== undefined) await fh.chmod(previousMode)
    await fh.sync()
  } finally {
    await fh.close()
  }
  const dirFh = await open(dirname(target), 'r')
  try {
    await dirFh.sync()
  } finally {
    await dirFh.close()
  }
  await rename(tempPath, target)
  const afterRename = await open(dirname(target), 'r')
  try {
    await afterRename.sync()
  } finally {
    await afterRename.close()
  }
}

/**
 * Run the apply. Every op is journaled at three checkpoints:
 *
 * - `prepared` after its backup is durable and before mutation.
 * - `applied` once the bytes are on disk in the worktree.
 * - `verified` once the worktree hash matches the intended bytes.
 * - `rolled_back` if verification fails and we restored the original file
 *   from a backup.
 *
 * The service keeps the journal until it has persisted the terminal plan
 * status, so a crash between runner completion and status update is recoverable.
 */
export async function runApply(input: ApplyRunInput): Promise<RecoveryResult> {
  const { plan, worktreeRoot, homeDir, objectStore, live, clock } = input
  const journal: RecoveryJournalEntry[] = []
  const activeOps = plan.operations.filter(op => op.kind !== 'noop')
  const result = (status: RecoveryResult['status'], failureReason?: string): RecoveryResult => ({
    planId: plan.id, status, afterCheckpointId: null, journal,
    ...(failureReason === undefined ? {} : { failureReason }),
  })
  // Validate every target before the first write, including files we intend to
  // delete. A changed later path must not leave earlier paths half-rewound.
  for (const op of activeOps) {
    if (op.kind === 'restore' || op.kind === 'recreate_deleted_file') {
      if (await objectStore.stat(op.targetBlobRef) === undefined) {
        throw new Error(`${op.path}: missing recovery blob ${op.targetBlobRef}`)
      }
      if (op.kind === 'restore' && await objectStore.stat(op.afterBlobRef) === undefined) {
        throw new Error(`${op.path}: missing recovery blob ${op.afterBlobRef}`)
      }
    }
    const currentHash = await live.hashCurrent(op.path)
    const expected = op.kind === 'recreate_deleted_file' ? null : op.expectedCurrentHash
    if (currentHash !== expected) {
      return result('rolled_back', `${op.path}: changed since preview`)
    }
  }

  const backupRoot = join(resolveDryRunRoot(homeDir, plan.id), '.backup')
  const prepared: Array<{ op: RecoveryFileOperation; original: Uint8Array | null }> = []
  const record = async (op: RecoveryFileOperation, state: RecoveryJournalState,
    error?: { code: string; message: string }): Promise<void> => {
    const entry = makeEntry(plan.id, clock, op, state, error)
    await appendJournal(homeDir, entry)
    journal.push(entry)
  }
  try {
    for (const op of activeOps) {
      const target = join(worktreeRoot, op.path)
      const original = await live.readCurrent(op.path)
      const expected = op.kind === 'recreate_deleted_file' ? null : op.expectedCurrentHash
      if ((original === null ? null : await contentHash(original)) !== expected) {
        throw new Error(`${op.path}: changed during apply`)
      }
      let targetBytes: Uint8Array | undefined
      if (op.kind === 'restore' || op.kind === 'recreate_deleted_file') {
        targetBytes = await objectStore.get(op.targetBlobRef)
      }
      if (op.kind === 'restore' && targetBytes !== undefined) {
        const afterBytes = await objectStore.get(op.afterBlobRef)
        const { reverseText } = reverseDerive({ path: op.path, beforeBytes: targetBytes, afterBytes })
        if (reverseText.length > 0) {
          const check = applyPatch({ patch: reverseText, currentBytes: original ?? new Uint8Array(), path: op.path })
          if (check.kind === 'conflict') {
            await record(op, 'rolled_back', { code: 'PATCH_CONFLICT', message: check.reason })
            throw new Error(`${op.path}: ${check.reason}`)
          }
        }
      }
      if (original !== null) {
        const backupPath = join(backupRoot, op.path)
        await mkdir(dirname(backupPath), { recursive: true })
        const handle = await open(backupPath, 'wx', 0o600)
        try {
          await handle.writeFile(original)
          await handle.chmod((await stat(target)).mode & 0o777)
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      // The durable prepared row precedes the first mutation. A crash between
      // the mutation and `applied` still has enough evidence to undo it.
      await record(op, 'prepared')
      prepared.push({ op, original })
      if (op.kind === 'delete_created_file') await unlink(target)
      else await atomicWrite(target, targetBytes!)
      await record(op, 'applied')
      const actual = await live.hashCurrent(op.path)
      const wanted = targetBytes === undefined ? null : await contentHash(targetBytes)
      if (actual !== wanted) throw new Error(`${op.path}: verify mismatch`)
      await record(op, 'verified')
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    for (const { op, original } of prepared.reverse()) {
      const target = join(worktreeRoot, op.path)
      if (original === null) await unlink(target).catch(e => {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      })
      else await atomicWrite(target, original)
      await record(op, 'rolled_back', { code: 'APPLY_FAILED', message: reason })
    }
    await rm(backupRoot, { recursive: true, force: true })
    return result('rolled_back', reason)
  }
  // The service owns finalization: until it durably marks the plan completed,
  // a crash must still be able to read this journal and restore the backups.
  return result('completed')
}

function makeEntry(
  planId: string,
  clock: ApplyClock,
  op: RecoveryFileOperation,
  state: RecoveryJournalState,
  error?: { code: string; message: string },
): RecoveryJournalEntry {
  return {
    schemaVersion: 3,
    planId,
    seq: clock.nextSeq(),
    operation: op,
    state,
    occurredAt: clock.nowMs(),
    ...(error === undefined ? {} : { error }),
  }
}

async function contentHash(bytes: Uint8Array): Promise<string> {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
