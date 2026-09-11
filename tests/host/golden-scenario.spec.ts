/**
 * The Turnscope Golden Scenario (`docs/ARCHITECTURE.md §62`).
 *
 * > README.md — the user edited it before the turn → BASELINE
 * > src/auth.ts — the agent edited it during the turn, the user edited it again
 * > afterwards → DRIFT
 * > tests/auth.test.ts — the agent created it during the turn → AGENT
 * > Safety → FORK_ONLY, with a reason naming src/auth.ts
 *
 * Every later version has to keep passing this. It is deliberately end-to-end:
 * a real repository, real checkpoints captured through the real observer, and
 * only then the two pure engines. A unit test can show each rule works; this is
 * the one that shows the three parts still agree about what happened.
 *
 * The failure it guards is the worst one the product has. If the second edit to
 * `src/auth.ts` is attributed to the agent, the UI tells the user their own work
 * was the agent's, and if the verdict comes back `SAFE`, the product would offer
 * to undo it.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { attributeChanges } from '../../src/host/attribution/engine.ts'
import { SCHEMA_VERSION } from '../../src/host/domain/types.ts'
import type { FileChange, FileToolHint, TurnRecord } from '../../src/host/domain/types.ts'
import { createExecFileRunner } from '../../src/host/git/command-runner.ts'
import { captureCheckpoint, type CheckpointDeps } from '../../src/host/git/checkpoint.ts'
import { createGitPort } from '../../src/host/git/git-port.ts'
import { evaluateSafety } from '../../src/host/safety/engine.ts'
import { createObjectStore } from '../../src/host/storage/object-store.ts'
import { commitAll, createRecordingSink, createRepo, writeRepoFile } from './git/support.ts'

const TURN_ID = 's-1:turn:1'
const NOW = 1_700_000_000_000

const git = createGitPort(createExecFileRunner())

describe('the golden scenario', () => {
  const cleanups: string[] = []

  afterEach(async () => {
    for (const root of cleanups.splice(0)) await rm(root, { recursive: true, force: true })
  })

  it('separates the user\'s work, the drifted file, and the agent\'s new file', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'turnscope-golden-data-'))
    cleanups.push(dataRoot)
    const root = await createRepo()
    cleanups.push(root)

    // The repository starts with one committed file, so `src/auth.ts` is clean
    // at PRE and its earlier contents are reachable through HEAD.
    await writeRepoFile(root, 'src/auth.ts', 'version 1\n')
    await commitAll(root, 'add auth')

    const sink = createRecordingSink()
    const deps: CheckpointDeps = {
      git,
      store: createObjectStore(join(dataRoot, 'store')),
      sink,
      maxBlobBytes: 1024 * 1024,
      ignorePaths: [],
    }

    const capture = (phase: 'pre' | 'post' | 'recovery_before', hintedPaths: readonly string[]) =>
      captureCheckpoint(deps, {
        workspaceId: 'ws-1',
        repoRoot: root,
        turnId: TURN_ID,
        phase,
        hintedPaths,
        now: NOW,
      })

    // --- the user edits README.md before the turn -----------------------------
    await writeRepoFile(root, 'README.md', 'notes the user wrote\n')
    const pre = await capture('pre', ['README.md'])

    // --- the turn: the agent edits auth.ts and creates a test -----------------
    await writeRepoFile(root, 'src/auth.ts', 'version 2, by the agent\n')
    await writeRepoFile(root, 'tests/auth.test.ts', 'export const ok = true\n')
    const post = await capture('post', ['README.md', 'src/auth.ts', 'tests/auth.test.ts'])

    // --- the user edits auth.ts again after the turn --------------------------
    await writeRepoFile(root, 'src/auth.ts', 'version 3, by the user\n')
    const current = await capture('recovery_before', ['README.md', 'src/auth.ts', 'tests/auth.test.ts'])

    // --- attribution ----------------------------------------------------------
    const hints: FileToolHint[] = [
      hint('README.md'),
      hint('src/auth.ts'),
      hint('tests/auth.test.ts'),
    ]
    const changeSet = attributeChanges({ pre, post, current, hints })
    const byPath = (path: string): FileChange => {
      const found = changeSet.changes.find(change => change.path === path)
      expect(found, `expected a change for ${path}`).toBeDefined()
      return found!
    }

    // The user's own uncommitted work, reported and not claimed by the turn.
    expect(byPath('README.md')).toMatchObject({ attribution: 'BASELINE', baseline: true })

    // The file the agent changed and the user then changed again.
    expect(byPath('src/auth.ts')).toMatchObject({ attribution: 'DRIFT', baseline: false })

    // The file the agent created.
    expect(byPath('tests/auth.test.ts')).toMatchObject({ attribution: 'AGENT', kind: 'created' })

    // --- safety ---------------------------------------------------------------
    const verdict = evaluateSafety({
      turn: turnRecord(),
      pre,
      post,
      current,
      changeSet,
      now: NOW + 1_000,
    })

    expect(verdict.level).toBe('FORK_ONLY')

    // The reason the user sees has to name the file that moved.
    const drift = verdict.reasons.find(reason => reason.code === 'S005_TARGET_FILE_DRIFT')
    expect(drift?.path).toBe('src/auth.ts')
    expect(drift?.detail).toContain('src/auth.ts changed after the recorded turn')

    // And fork-only must not quietly keep the in-place rewind.
    expect(verdict.allowedActions).not.toContain('REWIND')
    expect(verdict.allowedActions).toContain('FORK')
  })
})

function hint(path: string): FileToolHint {
  return { activityId: `s-1:act:${path}`, path, operation: 'edit', occurredAt: NOW }
}

function turnRecord(): TurnRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: TURN_ID,
    sessionId: 's-1',
    workspaceId: 'ws-1',
    ordinal: 1,
    status: 'completed',
    startedAt: NOW,
    endedAt: NOW,
    activityCount: 3,
    errorCount: 0,
    evidenceCompleteness: 'complete',
  }
}
