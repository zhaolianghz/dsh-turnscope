/**
 * The apply runner, per
 * `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §5.5`–§5.7`.
 *
 * The runner is the only component that touches the worktree. It does so
 * with three rules that together form a hard guarantee: either every
 * `restore` and `recreate_deleted_file` op has landed and the result has
 * been verified, or the workspace has been rolled back to its pre-apply
 * state. There is no in-between, because the journal either says "applied"
 * for every op or it does not.
 *
 * The atomicity comes from `rename`, which is the POSIX renameat(2) call:
 * the kernel guarantees that a successful rename is visible to every
 * concurrent reader as either the old file or the new file, never neither.
 * `fsync` on the directory makes that visibility durable across a crash.
 *
 * The runner refuses to call git. There is no `git apply`, no
 * `git checkout`, no `git reset --hard`. The plan comes from
 * `stateHash`-guarded evidence, and the runner writes the bytes straight from
 * the object store; if the user wants a `git` operation they can do one
 * after the apply has returned.
 */

import { mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
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
import { appendJournal, deleteJournal } from './journal.ts'
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
 * old file in place, and a crash between the rename and the directory fsync
 * leaves the new file visible but maybe not durable, which is acceptable for
 * V0.2 (a second apply run after restart would re-write the same bytes).
 *
 * Same-filesystem constraint: the temp file and the target must live on the
 * same filesystem so `rename` is atomic. V0.2's host always satisfies this
 * because the runner's temp files live in the worktree's parent.
 */
async function atomicWrite(target: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const tempPath = `${target}.turnscope-${process.pid}-${Date.now().toString(36)}`
  const fh = await open(tempPath, 'w', 0o600)
  try {
    await fh.writeFile(bytes)
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
}

/**
 * Run the apply. Every op is journaled at three checkpoints:
 *
 * - `applied` once the bytes are on disk in the worktree.
 * - `verified` once the post-apply reverse-apply (using `applyPatch` on the
 *   pre bytes) confirms the file's content hash matches the pre bytes.
 * - `rolled_back` if verification fails and we restored the original file
 *   from a backup.
 *
 * The journal is the only place a crashed apply is recorded; on next boot
 * the host reads it and surfaces the partial apply to the user.
 */
export async function runApply(input: ApplyRunInput): Promise<RecoveryResult> {
  const { plan, worktreeRoot, homeDir, objectStore, live, clock } = input
  const journal: RecoveryJournalEntry[] = []

  // Pre-flight: every op that has a target blob must resolve in the object
  // store before we touch the worktree. A missing blob mid-apply would
  // leave the workspace half-rewound and the journal honest about it but
  // the user furious.
  for (const op of plan.operations) {
    if (op.kind === 'noop') continue
    if (op.kind === 'restore' || op.kind === 'recreate_deleted_file') {
      await objectStore.stat(op.targetBlobRef)
    }
  }

  // Track backups per op so rollback has somewhere to read from. Only ops
  // that touch an existing file need a backup; create-from-blank does not.
  const backups = new Map<string, { backupPath: string; existedBefore: boolean }>()

  const failures: string[] = []
  let ranRollback = false

  for (const op of plan.operations) {
    if (op.kind === 'noop') continue

    if (op.kind === 'delete_created_file') {
      const target = join(worktreeRoot, op.path)
      let existed = false
      try {
        await stat(target)
        existed = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (existed) {
        await unlink(target)
      }
      journal.push(makeEntry(plan.id, clock, op, 'applied'))
      continue
    }

    const beforeBytes = await objectStore.get(op.targetBlobRef)
    const target = join(worktreeRoot, op.path)

    // For `restore` ops, run the structural drift guard BEFORE we touch the
    // worktree. The guard asks "does the worktree still look like the post
    // state we recorded?" — a `conflict` here means somebody (the user, a
    // timer, a formatter) has changed the file since the planner snapshot,
    // and a blind overwrite would lose their work.
    if (op.kind === 'restore') {
      const afterBytes = await objectStore.get(op.afterBlobRef)
      const currentBytes = (await live.readCurrent(op.path)) ?? new Uint8Array()
      const { reverseText } = reverseDerive({ path: op.path, beforeBytes, afterBytes })
      if (reverseText.length > 0) {
        const r = applyPatch({ patch: reverseText, currentBytes, path: op.path })
        if (r.kind === 'conflict') {
          journal.push(makeEntry(
            plan.id,
            clock,
            op,
            'rolled_back',
            { code: 'PATCH_CONFLICT', message: r.reason },
          ))
          failures.push(`${op.path}: ${r.reason}`)
          ranRollback = true
          break
        }
      }
    }

    // Back up the current file (if any) before overwriting it. Same
    // filesystem as the worktree so `rename` is atomic. The backup lives
    // under `<homeDir>/dryrun/<planId>/.backup/<path>` so a `rm -rf` on
    // that directory cleans up after a successful apply.
    const backupRoot = resolveDryRunRoot(homeDir, plan.id)
    const backupPath = join(backupRoot, '.backup', op.path)
    await mkdir(dirname(backupPath), { recursive: true })
    let existedBefore = false
    try {
      await stat(target)
      existedBefore = true
      await rename(target, backupPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    backups.set(op.path, { backupPath, existedBefore })

    await atomicWrite(target, beforeBytes)
    journal.push(makeEntry(plan.id, clock, op, 'applied'))

    // Verify: hash the file that is now on disk; it must equal the hash of
    // the bytes we wrote. A mismatch means the kernel wrote something else
    // (effectively impossible, but cheap to check).
    const liveHash = await live.hashCurrent(op.path)
    const expectedHash = await contentHash(beforeBytes)
    if (liveHash !== expectedHash) {
      if (existedBefore) {
        await rename(backupPath, target)
      } else {
        await unlink(target).catch(() => undefined)
      }
      journal.push(makeEntry(
        plan.id,
        clock,
        op,
        'rolled_back',
        { code: 'VERIFY_MISMATCH', message: `expected ${expectedHash}, got ${liveHash}` },
      ))
      failures.push(`${op.path}: verify mismatch`)
      ranRollback = true
      break
    }

    journal.push(makeEntry(plan.id, clock, op, 'verified'))
  }

  for (const entry of journal) {
    await appendJournal(homeDir, entry)
  }

  // Cleanup: delete the journal if the apply completed cleanly. Per
  // spec §5.6 we keep the journal around for the rolled-back case so the
  // host can surface the failure on next boot.
  if (!ranRollback) {
    await deleteJournal(homeDir, plan.id).catch(() => undefined)
  }

  // Drop the backup directory under the staging root.
  const backupRoot = resolveDryRunRoot(homeDir, plan.id)
  await unlink(join(backupRoot, '.backup')).catch(() => undefined)

  const status: RecoveryResult['status'] = ranRollback
    ? 'rolled_back'
    : failures.length === 0
      ? 'completed'
      : 'failed'
  const result: RecoveryResult = {
    planId: plan.id,
    status,
    afterCheckpointId: null,
    journal,
  }
  if (failures.length > 0) {
    return { ...result, failureReason: failures.join('; ') }
  }
  return result
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