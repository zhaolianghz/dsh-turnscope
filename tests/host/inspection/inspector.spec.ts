/**
 * The turn-boundary pipeline, over a real index and a real repository.
 *
 * The engines are tested against hand-built evidence; the point of this file is
 * the part they cannot see — *when* each observation is taken, and that the
 * result survives a round trip through storage. Every assertion that matters
 * here reads the answer back out of the database rather than out of the object
 * the call returned, because "the verdict was computed" and "the verdict is on
 * record" are different claims and only the second one is user-visible.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkpointIdFor, safetyVerdictIdFor } from '../../../src/host/domain/ids.ts'
import { createExecFileRunner } from '../../../src/host/git/command-runner.ts'
import { CHECKPOINT_FAILURE } from '../../../src/host/git/checkpoint.ts'
import { createGitPort } from '../../../src/host/git/git-port.ts'
import { createTurnInspector } from '../../../src/host/inspection/inspector.ts'
import type { TurnWorkspace } from '../../../src/host/inspection/types.ts'
import { createObjectStore } from '../../../src/host/storage/object-store.ts'
import { createRepository } from '../../../src/host/storage/repository.ts'
import type { TraceRepository } from '../../../src/host/storage/repository.ts'
import { openIndex } from '../../../src/host/storage/sqlite-index.ts'
import { commitAll, createRepo, writeRepoFile } from '../git/support.ts'
import { turnRecord } from '../safety/support.ts'

const git = createGitPort(createExecFileRunner())
const TURN_ID = 's-1:turn:3'

describe('createTurnInspector', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  /** A real index, a real object store, and a real repository to observe. */
  const fixture = async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'turnscope-inspect-'))
    const root = await createRepo()
    cleanups.push(async () => {
      await rm(dataRoot, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    })
    const handle = await openIndex(join(dataRoot, 'index.sqlite3'))
    const repo = createRepository(handle)
    let tick = 1_700_000_000_000
    const inspector = createTurnInspector({
      git,
      store: createObjectStore(join(dataRoot, 'store')),
      sink: repo,
      maxBlobBytes: 1024 * 1024,
      ignorePaths: [],
      // A clock that moves on every read, so "was this re-captured" is
      // answerable from the record's own timestamp.
      now: () => (tick += 1_000),
    })
    return {
      root,
      repo,
      inspector,
      workspace: { workspaceId: 'sha256:ws', repoRoot: root },
      close: async () => {
        repo.close()
      },
    }
  }

  const running = () => turnRecord({ status: 'running', endedAt: undefined })
  const completed = () => turnRecord({ status: 'completed' })

  it('takes PRE on the way in and decides nothing yet', async () => {
    const f = await fixture()

    const result = await f.inspector.observe(running(), f.workspace, undefined)

    // A turn that has not happened cannot be attributed, so no verdict is
    // invented for it.
    expect(result).toBeUndefined()
    const pre = await f.repo.getCheckpoint(checkpointIdFor(TURN_ID, 'pre'))
    expect(pre?.completeness).toBe('complete')
    expect(pre?.phase).toBe('pre')
    await f.close()
  })

  it('takes POST and produces the verdict on the way out', async () => {
    const f = await fixture()
    await writeRepoFile(f.root, 'src/auth.ts', 'version 1\n')
    await commitAll(f.root, 'add auth')

    // The user's own uncommitted work exists before the turn starts.
    await writeRepoFile(f.root, 'README.md', 'notes\n')
    await f.inspector.observe(running(), f.workspace, undefined)

    // The turn: the agent edits one file and creates another.
    await writeRepoFile(f.root, 'src/auth.ts', 'version 2\n')
    await writeRepoFile(f.root, 'tests/auth.test.ts', 'test\n')
    const result = await f.inspector.observe(completed(), f.workspace, 'running')

    expect(result).toBeDefined()
    expect(await f.repo.getCheckpoint(checkpointIdFor(TURN_ID, 'post'))).toBeDefined()

    // The verdict is read back from storage, not from the return value: the
    // return value is a convenience, the row is the product.
    const verdict = await f.repo.getLatestVerdict(TURN_ID)
    expect(verdict?.id).toBe(safetyVerdictIdFor(TURN_ID))
    expect(verdict?.level).toBe('SAFE')
    expect(verdict?.allowedActions).toContain('REWIND')

    const changes = await f.repo.listFileChanges(TURN_ID)
    const byPath = new Map(changes.map(change => [change.path, change]))
    expect(byPath.get('README.md')?.attribution).toBe('BASELINE')
    expect(byPath.get('src/auth.ts')?.attribution).toBe('AGENT')
    expect(byPath.get('tests/auth.test.ts')?.attribution).toBe('AGENT')
    await f.close()
  })

  it('notices a file that moved after the turn and withdraws the rewind', async () => {
    const f = await fixture()
    await writeRepoFile(f.root, 'src/auth.ts', 'version 1\n')
    await commitAll(f.root, 'add auth')

    await f.inspector.observe(running(), f.workspace, undefined)
    await writeRepoFile(f.root, 'src/auth.ts', 'version 2, agent\n')
    await f.inspector.observe(completed(), f.workspace, 'running')
    expect((await f.repo.getLatestVerdict(TURN_ID))?.level).toBe('SAFE')

    // The user keeps working on the file the agent changed.
    await writeRepoFile(f.root, 'src/auth.ts', 'version 3, user\n')
    const refreshed = await f.inspector.inspect(completed(), f.workspace)

    expect(refreshed?.changeSet?.changes.find(c => c.path === 'src/auth.ts')?.attribution).toBe(
      'DRIFT',
    )

    // §16: the stored verdict is replaced, not appended to. A verdict is about
    // the workspace now, so keeping the old one would be keeping a stale answer.
    const verdict = await f.repo.getLatestVerdict(TURN_ID)
    expect(verdict?.level).toBe('FORK_ONLY')
    expect(verdict?.allowedActions).not.toContain('REWIND')
    expect(verdict?.reasons.some(reason => reason.code === 'S005_TARGET_FILE_DRIFT')).toBe(true)

    // Re-evaluating must rewrite the same file-change rows rather than add a
    // second opinion about the same path.
    const changes = await f.repo.listFileChanges(TURN_ID)
    expect(changes).toHaveLength(1)
    expect(changes.filter(change => change.path === 'src/auth.ts')).toHaveLength(1)
    await f.close()
  })

  it('does not re-take POST when a finished turn is published again', async () => {
    const f = await fixture()
    await f.inspector.observe(running(), f.workspace, undefined)
    await writeRepoFile(f.root, 'a.txt', 'agent\n')
    await f.inspector.observe(completed(), f.workspace, 'running')
    const first = await f.repo.getCheckpoint(checkpointIdFor(TURN_ID, 'post'))

    // The harness re-publishes a finished turn on every later activity. Writing
    // POST again would replace the end of the turn with the state after it.
    const again = await f.inspector.observe(completed(), f.workspace, 'completed')

    expect(again).toBeUndefined()
    expect((await f.repo.getCheckpoint(checkpointIdFor(TURN_ID, 'post')))?.createdAt).toBe(
      first?.createdAt,
    )
    await f.close()
  })

  it('reports a turn whose ending was seen but whose beginning was not', async () => {
    const f = await fixture()
    await writeRepoFile(f.root, 'a.txt', 'agent\n')

    // The plugin loaded mid-session: the turn was already running before there
    // was anything watching.
    const result = await f.inspector.observe(completed(), f.workspace, 'running')

    expect(await f.repo.getCheckpoint(checkpointIdFor(TURN_ID, 'pre'))).toBeUndefined()
    expect(result?.verdict.level).toBe('UNPROTECTED')
    const codes = result?.verdict.reasons.map(reason => reason.code) ?? []
    expect(codes).toContain('S001_PRE_CHECKPOINT_MISSING')
    expect(codes).toContain('S010_EVIDENCE_INCOMPLETE')
    // Nothing was attributed, so nothing is claimed about any path.
    expect(await f.repo.listFileChanges(TURN_ID)).toEqual([])
    await f.close()
  })

  it('records a failed checkpoint rather than throwing when there is no repository', async () => {
    const f = await fixture()
    const plain = await mkdtemp(join(tmpdir(), 'turnscope-plain-'))
    cleanups.push(async () => {
      await rm(plain, { recursive: true, force: true })
    })
    const workspace = { workspaceId: 'sha256:plain', repoRoot: plain }

    await f.inspector.observe(running(), workspace, undefined)
    const result = await f.inspector.observe(completed(), workspace, 'running')

    const pre = await f.repo.getCheckpoint(checkpointIdFor(TURN_ID, 'pre'))
    expect(pre?.failureReason).toBe(CHECKPOINT_FAILURE.NOT_A_REPOSITORY)
    expect(result?.verdict.level).toBe('UNPROTECTED')
    expect(result?.verdict.allowedActions).toEqual(['INSPECT'])
    expect(result?.verdict.reasons.map(reason => reason.code)).toEqual(['S009_NON_GIT_WORKSPACE'])
    await f.close()
  })

  it('returns what is on record for a UI that opens before re-evaluating', async () => {
    const f = await fixture()
    expect(await f.inspector.latestVerdict(TURN_ID)).toBeUndefined()

    await f.inspector.observe(running(), f.workspace, undefined)
    await f.inspector.observe(completed(), f.workspace, 'running')

    expect((await f.inspector.latestVerdict(TURN_ID))?.turnId).toBe(TURN_ID)
    await f.close()
  })

  it('re-judges a stored turn without attributing it again', async () => {
    const f = await fixture()
    await writeRepoFile(f.root, 'src/auth.ts', 'version 1\n')
    await commitAll(f.root, 'add auth')

    await f.inspector.observe(running(), f.workspace, undefined)
    await writeRepoFile(f.root, 'src/auth.ts', 'version 2, agent\n')
    await f.inspector.observe(completed(), f.workspace, 'running')
    const recorded = (await f.repo.listFileChanges(TURN_ID))[0]
    expect(recorded?.attribution).toBe('AGENT')

    const refreshed = await f.inspector.refresh(completed(), f.workspace)

    // The turn ended and its checkpoints are immutable, so an unchanged
    // workspace must reproduce the same judgement. Re-deriving it would be a
    // second opinion on a fact that cannot have changed.
    expect(refreshed.changeSet?.changes).toEqual([recorded])
    expect(refreshed.verdict.level).toBe('SAFE')
    expect(await f.repo.getLatestVerdict(TURN_ID)).toEqual(
      expect.objectContaining({ level: 'SAFE' }),
    )
    // `refresh` writes no checkpoint of its own: the verdict follows from the
    // stored PRE/POST plus a fresh CURRENT, and CURRENT was already recorded.
    expect(await f.repo.listCheckpoints(TURN_ID)).toHaveLength(3)
    await f.close()
  })

  it('refreshes a stored turn against a workspace that has moved since', async () => {
    const f = await fixture()
    await writeRepoFile(f.root, 'src/auth.ts', 'version 1\n')
    await commitAll(f.root, 'add auth')

    await f.inspector.observe(running(), f.workspace, undefined)
    await writeRepoFile(f.root, 'src/auth.ts', 'version 2, agent\n')
    await f.inspector.observe(completed(), f.workspace, 'running')

    await writeRepoFile(f.root, 'src/auth.ts', 'version 3, user\n')
    const refreshed = await f.inspector.refresh(completed(), f.workspace)

    expect(refreshed.verdict.level).toBe('FORK_ONLY')
    expect(refreshed.verdict.reasons.map(reason => reason.code)).toContain('S005_TARGET_FILE_DRIFT')
    // The decision differs from `inspect`'s only in where it came from, so the
    // row it leaves behind has to be the same one `inspect` would have written.
    // Otherwise the change list would disagree with the badge above it depending
    // on which endpoint last ran.
    expect((await f.repo.listFileChanges(TURN_ID))[0]?.attribution).toBe('DRIFT')
    await f.close()
  })

  it('lets a tool hint widen what a re-evaluation looks at', async () => {
    const f = await fixture()
    // Committed and clean: `git status` will not mention it, so the only way it
    // enters the observation is because a hint named it.
    await writeRepoFile(f.root, 'src/auth.ts', 'version 1\n')
    await commitAll(f.root, 'add auth')

    await f.inspector.observe(running(), f.workspace, undefined)
    await writeRepoFile(f.root, 'src/auth.ts', 'version 2, agent\n')
    await f.inspector.observe(completed(), f.workspace, 'running')

    await writeRepoFile(f.root, 'src/auth.ts', 'version 3, user\n')
    const withoutHint = await f.inspector.inspect(completed(), f.workspace)
    const withHint = await f.inspector.inspect(completed(), f.workspace, {
      hints: [
        { activityId: 's-1:act:9', path: 'src/auth.ts', operation: 'edit', occurredAt: 1_700_000_000_000 },
      ],
    })

    // The hint changes which observations were taken, never the verdict on its
    // own: the drift is real either way, and the hint is cited, not obeyed.
    expect(withoutHint?.changeSet?.summary.drift).toBe(1)
    expect(withHint?.changeSet?.summary.drift).toBe(1)
    expect(
      withHint?.changeSet?.changes.find(c => c.path === 'src/auth.ts')?.evidenceRefs,
    ).toContain('s-1:act:9')
    await f.close()
  })
})
