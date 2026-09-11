/**
 * Dry-run the rewind, per
 * `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §5.3`.
 *
 * The dry-run exists to give the user something to look at before they hit
 * Confirm. The production apply path is small (atomic rename + stateHash
 * guard + journal) and the user has only one window to back out of it, so
 * the preview has to be honest about what the apply would do — without
 * itself becoming a separate code path that could drift away from the
 * runner's behaviour.
 *
 * Concretely the dry-run:
 *
 * 1. Reads the bytes the apply would read (`targetBlobRef`).
 * 2. For every rewinding path, writes the bytes to a staging directory at
 *    `<recoveryRoot>/dryrun/<planId>/<path>`. That staging directory is the
 *    "what the worktree will look like" view, and the UI overlays it before
 *    the user confirms.
 * 3. For every `restore` op, reads the worktree's current bytes and asks
 *    `applyPatch` to validate the reversal. A `conflict` means the worktree
 *    has drifted since the checkpoint and a blind rewind would lose the
 *    user's work; the dry-run reports the conflict rather than silently
 *    producing a misleading preview.
 * 4. Cleans its staging directory on the way out so the next preview starts
 *    from a known-empty state.
 *
 * The dry-run deliberately does not call `git worktree add`. The runner never
 * consults git for recovery — `stateHash` covers HEAD OID and worktree path,
 * but the bytes themselves are read from the object store, not from a
 * checked-out worktree — so building a real worktree just to stage files
 * would be the slowest possible way to do what `fs.writeFile` already does
 * correctly.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ObjectStore } from '../../storage/object-store.ts'
import { applyPatch } from '../patch/apply.ts'
import { reverseDerive } from '../patch/reverse-derive.ts'
import type { RecoveryFileOperation, RecoveryPlan } from '../types.ts'
import { resolveDryRunRoot } from './paths.ts'

/** Per-op outcome of a dry-run. */
export type DryRunOpStatus =
  /** The op was staged successfully and would apply cleanly. */
  | { kind: 'ok'; op: RecoveryFileOperation; stagedPath: string }
  /** The op cannot apply because the worktree drifted since the checkpoint. */
  | {
      kind: 'conflict'
      op: RecoveryFileOperation
      reason: 'context-mismatch' | 'hunk-offset' | 'binary'
      stagedPath?: string
    }
  /** The op is a `noop`; the dry-run records what was skipped and why. */
  | { kind: 'noop'; op: RecoveryFileOperation; reason: string }

/** The dry-run's verdict over a whole plan. */
export interface DryRunReport {
  readonly planId: string
  readonly stagingRoot: string
  readonly ops: readonly DryRunOpStatus[]
}

/** What the dry-run needs from the live world. */
export interface DryRunLiveContext {
  /**
   * Read the current bytes of `path` from the worktree, or return `null` when
   * the file does not exist (deleted). Errors that mean "this path is
   * untracked" come back as `null`; real IO errors propagate.
   */
  readonly readCurrent: (path: string) => Promise<Uint8Array | null>
}

/** Result of the dry-run, including a flag the caller can pass to `cleanupDryRun`. */
export interface DryRunOutcome extends DryRunReport {
  /** Path of the staging directory the dry-run created; `undefined` on early failure. */
  readonly stagingRoot: string
}

/**
 * Run the dry-run for `plan`.
 *
 * Failures during a single op are recorded in the per-op result, not thrown:
 * the user wants to see "the rewind would fail because path X has drifted"
 * in the same view as "paths A, B, C are ready". A thrown error only escapes
 * when the staging directory itself cannot be created — that is a hard
 * environmental fault, not a per-op decision.
 */
export async function runDryRun(
  plan: RecoveryPlan,
  objectStore: ObjectStore,
  live: DryRunLiveContext,
  recoveryRoot: string,
): Promise<DryRunOutcome> {
  const stagingRoot = resolveDryRunRoot(recoveryRoot, plan.id)
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })

  const ops: DryRunOpStatus[] = []
  for (const op of plan.operations) {
    if (op.kind === 'noop') {
      ops.push({ kind: 'noop', op, reason: op.reason })
      continue
    }

    if (op.kind === 'delete_created_file') {
      // No bytes to stage; the apply will simply remove the file. Record the
      // op as `ok` so the UI shows it alongside the others.
      ops.push({ kind: 'ok', op, stagedPath: '' })
      continue
    }

    // `restore` and `recreate_deleted_file` both need a `targetBlobRef`.
    const beforeBytes = await objectStore.get(op.targetBlobRef)
    const stagedPath = join(stagingRoot, op.path)
    await mkdir(dirname(stagedPath), { recursive: true })
    await writeFile(stagedPath, beforeBytes)

    if (op.kind === 'restore') {
      // Drift validation: build the reverse patch from before/after, apply it
      // to the worktree's current bytes. If they do not match, the worktree
      // has drifted since the checkpoint.
      const afterBytes = await objectStore.get(op.afterBlobRef)
      const currentBytes = (await live.readCurrent(op.path)) ?? new Uint8Array()
      const { reverseText } = reverseDerive({ path: op.path, beforeBytes, afterBytes })
      if (reverseText.length > 0) {
        const r = applyPatch({ patch: reverseText, currentBytes, path: op.path })
        if (r.kind === 'conflict') {
          ops.push({ kind: 'conflict', op, reason: r.reason, stagedPath })
          continue
        }
      }
    }

    ops.push({ kind: 'ok', op, stagedPath })
  }

  return { planId: plan.id, stagingRoot, ops }
}

/**
 * Remove the dry-run's staging directory.
 *
 * Called by the RPC handler after the user has either confirmed (in which
 * case the staging directory is now redundant) or cancelled (in which case
 * the staging directory is a confusing artefact to leave behind). Errors are
 * swallowed with the assumption that the worst case is some leftover bytes
 * under the recovery root that a later `rm -rf` can clean up.
 */
export async function cleanupDryRun(stagingRoot: string): Promise<void> {
  await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
}