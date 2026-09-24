/**
 * Safe Rewind, end to end, over a real repository and a real index.
 *
 * Everything below the service is real: a real Git repository, real PRE/POST
 * checkpoints captured by the real inspector, real recovery blobs in the real
 * object store, a real SQLite index with schema 003, and the real runner
 * writing the real worktree. `tests/host/recovery/service.spec.ts` tests the
 * same service against a fake sink and a hand-built store, which is the right
 * shape for pinning the glue — but a fake sink cannot notice that the bytes the
 * service hands the planner are not the bytes it thinks they are. This file
 * exists because V0.2 is the first version that writes a user's files, and the
 * thing being verified is not "does the code run" but "does the file on disk
 * end up holding the user's own bytes again".
 *
 * The two scenarios are the two ways this can go wrong in front of a user:
 *
 *   1. it works — the modified file comes back, the created file goes away, the
 *      deleted file returns, and the record in SQLite says so;
 *   2. the user kept editing — the apply refuses to overwrite their work.
 *
 * The second one is the reason the first one is allowed to exist.
 */
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { API_VERSION } from '../../../src/shared/contracts/api.ts'
import { SCHEMA_VERSION } from '../../../src/host/domain/types.ts'
import type { WorkspaceRecord } from '../../../src/host/domain/types.ts'
import { createExecFileRunner } from '../../../src/host/git/command-runner.ts'
import { createGitPort } from '../../../src/host/git/git-port.ts'
import { createTurnInspector } from '../../../src/host/inspection/inspector.ts'
import { createRecoveryService } from '../../../src/host/recovery/service.ts'
import { createObjectStore } from '../../../src/host/storage/object-store.ts'
import { createRepository } from '../../../src/host/storage/repository.ts'
import { openIndex } from '../../../src/host/storage/sqlite-index.ts'
import { createNodeWorktreeReader } from '../../../src/host/storage/worktree-reader.ts'
import { commitAll, createRepo, writeRepoFile } from '../git/support.ts'
import { turnRecord } from '../safety/support.ts'

const git = createGitPort(createExecFileRunner())
const TURN_ID = 's-1:turn:7'
const WORKSPACE_ID = 'sha256:e2e-workspace'
const NOW = 1_700_000_000_000

describe('safe rewind, over a real repository', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  /**
   * A real index, a real object store, a real inspector, and a real recovery
   * service whose runner writes a real worktree.
   *
   * The clock is owned by the fixture rather than mocked: the plan's expiry is
   * part of what apply checks, so a test that wants a live preview has to be
   * able to say what "now" is without sleeping.
   */
  const fixture = async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'turnscope-rewind-'))
    const root = await createRepo()
    cleanups.push(async () => {
      await rm(dataRoot, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    })

    const handle = await openIndex(join(dataRoot, 'index.sqlite3'))
    const repo = createRepository(handle)
    cleanups.push(async () => {
      repo.close()
    })
    const store = createObjectStore(join(dataRoot, 'store'))

    let now = NOW
    let seq = 0
    const inspector = createTurnInspector({
      git,
      store,
      sink: repo,
      maxBlobBytes: 1024 * 1024,
      ignorePaths: [],
      now: () => now,
    })
    const recovery = createRecoveryService({
      sink: repo,
      store,
      worktree: createNodeWorktreeReader(),
      clock: { nowMs: () => now, nextSeq: () => (seq += 1) },
      homeDir: dataRoot,
      git,
    })

    const workspace: WorkspaceRecord = {
      schemaVersion: SCHEMA_VERSION,
      id: WORKSPACE_ID,
      repoRoot: root,
      repoRootHash: 'e2e',
      settingsJson: '{}',
      createdAt: NOW,
    }
    await repo.upsertWorkspace(workspace)
    await repo.upsertTurn(turnRecord({ id: TURN_ID, workspaceId: WORKSPACE_ID }))

    return {
      root,
      dataRoot,
      repo,
      inspector,
      recovery,
      workspace: { workspaceId: WORKSPACE_ID, repoRoot: root },
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  const read = (root: string, path: string) => readFile(join(root, path), 'utf8')

  /**
   * Run one turn for real: PRE on the way in, three kinds of file change during
   * the turn, POST plus a verdict on the way out.
   */
  const runTurn = async (f: Awaited<ReturnType<typeof fixture>>) => {
    await writeRepoFile(f.root, 'src/auth.ts', 'version 1\n')
    await writeRepoFile(f.root, 'src/gone.ts', 'the user needs this back\n')
    await commitAll(f.root, 'initial')

    await f.inspector.observe(turnRecord({ id: TURN_ID, workspaceId: WORKSPACE_ID, status: 'running', endedAt: undefined }), f.workspace, undefined)

    // The turn: modify one file, create one, delete one. These are the three
    // operations the planner can reverse, and each one is a different code path
    // in the runner.
    await writeRepoFile(f.root, 'src/auth.ts', 'version 2, by the agent\n')
    await writeRepoFile(f.root, 'tests/auth.test.ts', 'test\n')
    await unlink(join(f.root, 'src/gone.ts'))

    const observed = await f.inspector.observe(
      turnRecord({ id: TURN_ID, workspaceId: WORKSPACE_ID, status: 'completed' }),
      f.workspace,
      'running',
    )
    return observed
  }

  it('puts back what the turn changed, and records that it did', async () => {
    const f = await fixture()
    const observed = await runTurn(f)

    // Preconditions, asserted rather than assumed: a preview is only supposed to
    // happen for a turn the engine actually cleared, and a fixture that got a
    // different verdict would test the blocking path instead of the rewinding
    // one without saying so.
    expect(observed?.verdict.level).toBe('SAFE')
    expect(observed?.verdict.allowedActions).toContain('REWIND')

    const preview = await f.recovery.previewRewind({
      apiVersion: API_VERSION,
      turnId: TURN_ID,
      evaluationId: 'eval-1',
    })
    expect(preview.data?.failureReason).toBeUndefined()
    const plan = preview.data?.plan
    expect(plan).toBeDefined()

    // A preview writes nothing. This is the promise the button makes, and the
    // only way to keep it is to check the files afterwards.
    expect(await read(f.root, 'src/auth.ts')).toBe('version 2, by the agent\n')
    expect(await read(f.root, 'tests/auth.test.ts')).toBe('test\n')

    const ops = new Map(plan!.operations.map(op => [op.path, op]))
    expect(ops.get('src/auth.ts')?.kind).toBe('restore')
    expect(ops.get('tests/auth.test.ts')?.kind).toBe('delete_created_file')
    expect(ops.get('src/gone.ts')?.kind).toBe('recreate_deleted_file')

    const applied = await f.recovery.applyRewind({ apiVersion: API_VERSION, planId: plan!.id })
    expect(applied.data?.failureReason).toBeUndefined()
    expect(applied.data?.result?.status).toBe('completed')

    // The three files, which is the whole point of the version.
    expect(await read(f.root, 'src/auth.ts')).toBe('version 1\n')
    await expect(read(f.root, 'tests/auth.test.ts')).rejects.toThrow()
    expect(await read(f.root, 'src/gone.ts')).toBe('the user needs this back\n')

    // The plan's terminal status and the journal are read back from the index
    // rather than from the return value: a rewind that worked but was not
    // recorded is a rewind the next boot cannot report on.
    const stored = await f.repo.getRecoveryPlan(plan!.id)
    expect(stored?.status).toBe('completed')

    const journal = await f.repo.listRecoveryJournal(plan!.id)
    expect(journal.map(entry => entry.state)).toContain('applied')
    expect(journal.map(entry => entry.state)).toContain('verified')

    // `recovery_after` is what makes the rewind itself undoable later: the
    // checkpoint taken once the files were back in their pre-turn state.
    const checkpoints = await f.repo.listCheckpoints(TURN_ID)
    expect(checkpoints.map(cp => cp.phase)).toContain('recovery_after')
  })

  it('refuses to overwrite work the user did after the preview', async () => {
    const f = await fixture()
    await runTurn(f)

    const preview = await f.recovery.previewRewind({
      apiVersion: API_VERSION,
      turnId: TURN_ID,
      evaluationId: 'eval-2',
    })
    const plan = preview.data?.plan
    expect(plan).toBeDefined()

    // The user reads the preview, then keeps working — on the very file the
    // rewind is about to rewrite. This is the case the whole drift guard exists
    // for, and the case a fake-bytes fixture cannot reach: the guard compares
    // the live file against the bytes the turn left, so a fixture that hands the
    // planner the same ref for both sides makes the comparison trivially pass.
    await writeRepoFile(f.root, 'src/auth.ts', 'version 3, the user again\n')

    const applied = await f.recovery.applyRewind({ apiVersion: API_VERSION, planId: plan!.id })

    // eslint-disable-next-line no-console
    console.log('DEBUG checkpoints', JSON.stringify(await f.repo.listCheckpoints(TURN_ID), null, 1))
    for (const cp of await f.repo.listCheckpoints(TURN_ID)) {
      // eslint-disable-next-line no-console
      console.log('DEBUG paths', cp.phase, cp.id, JSON.stringify(await f.repo.listCheckpointPaths(cp.id)))
    }
    // eslint-disable-next-line no-console
    console.log('DEBUG changes', JSON.stringify(await f.repo.listFileChanges(TURN_ID), null, 1))
    // eslint-disable-next-line no-console
    console.log('DEBUG plan', JSON.stringify(plan, null, 1))

    expect(applied.data?.result?.status).not.toBe('completed')
    expect(await read(f.root, 'src/auth.ts')).toBe('version 3, the user again\n')
  })

  it('preserves a newly created file edited after preview and leaves earlier files untouched', async () => {
    const f = await fixture()
    await runTurn(f)
    const preview = await f.recovery.previewRewind({
      apiVersion: API_VERSION,
      turnId: TURN_ID,
      evaluationId: 'eval-created-drift',
    })
    const plan = preview.data?.plan
    expect(plan).toBeDefined()

    await writeRepoFile(f.root, 'tests/auth.test.ts', 'user changed this after preview\n')
    const applied = await f.recovery.applyRewind({ apiVersion: API_VERSION, planId: plan!.id })

    expect(applied.data?.result?.status).not.toBe('completed')
    expect(await read(f.root, 'tests/auth.test.ts')).toBe('user changed this after preview\n')
    expect(await read(f.root, 'src/auth.ts')).toBe('version 2, by the agent\n')
  })

  it('restores the dirty file bytes from the turn start instead of Git HEAD', async () => {
    const f = await fixture()
    await writeRepoFile(f.root, 'src/auth.ts', 'committed version\n')
    await commitAll(f.root, 'initial')
    await writeRepoFile(f.root, 'src/auth.ts', 'user version before turn\n')
    await f.inspector.observe(
      turnRecord({ id: TURN_ID, workspaceId: WORKSPACE_ID, status: 'running', endedAt: undefined }),
      f.workspace, undefined,
    )
    await writeRepoFile(f.root, 'src/auth.ts', 'agent version\n')
    await f.inspector.observe(
      turnRecord({ id: TURN_ID, workspaceId: WORKSPACE_ID, status: 'completed' }),
      f.workspace, 'running',
    )
    const preview = await f.recovery.previewRewind({
      apiVersion: API_VERSION, turnId: TURN_ID, evaluationId: 'dirty-pre',
    })
    expect(preview.data?.plan).toBeDefined()
    const applied = await f.recovery.applyRewind({
      apiVersion: API_VERSION, planId: preview.data!.plan!.id,
    })
    expect(applied.data?.result?.status).toBe('completed')
    expect(await read(f.root, 'src/auth.ts')).toBe('user version before turn\n')
  })

  it('refuses to apply a preview the user sat on', async () => {
    const f = await fixture()
    await runTurn(f)

    const preview = await f.recovery.previewRewind({
      apiVersion: API_VERSION,
      turnId: TURN_ID,
      evaluationId: 'eval-3',
      ttlMs: 1_000,
    })
    const plan = preview.data?.plan
    expect(plan).toBeDefined()

    f.advance(2_000)
    const applied = await f.recovery.applyRewind({ apiVersion: API_VERSION, planId: plan!.id })

    expect(applied.data?.result).toBeUndefined()
    expect(applied.data?.failureReason).toContain('expired')
    expect(await read(f.root, 'src/auth.ts')).toBe('version 2, by the agent\n')
  })
})
