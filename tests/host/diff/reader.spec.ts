/**
 * Where a diff's two sides come from, over a real repository and a real store.
 *
 * The renderer is tested on its own; this file is about the part that cannot be
 * unit-tested into existence — that the bytes a user sees are the bytes that
 * were there, and that every way of *not* having them arrives as an explanation
 * rather than as an empty diff.
 *
 * The turn is driven through the real inspector rather than assembled by hand, so
 * the checkpoints, the change rows, and the diff all come from one pipeline. That
 * is the point: the interesting case is the *common* one, where a file was clean
 * when the turn started and `PRE` therefore has nothing to say about it — a
 * `PRE` row only exists for paths that were dirty or hinted
 * (`docs/ARCHITECTURE.md §12.2`). A test that hand-wrote a `PRE` row for that path
 * would prove the reader works on evidence that never occurs.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileDiffReader } from '../../../src/host/diff/reader.ts'
import type { FileDiff } from '../../../src/host/diff/types.ts'
import type { TurnRecord } from '../../../src/host/domain/types.ts'
import { createExecFileRunner } from '../../../src/host/git/command-runner.ts'
import { createGitPort } from '../../../src/host/git/git-port.ts'
import { createTurnInspector } from '../../../src/host/inspection/inspector.ts'
import type { TurnWorkspace } from '../../../src/host/inspection/types.ts'
import { createObjectStore } from '../../../src/host/storage/object-store.ts'
import type { ObjectStore } from '../../../src/host/storage/object-store.ts'
import { createRepository } from '../../../src/host/storage/repository.ts'
import type { TraceRepository } from '../../../src/host/storage/repository.ts'
import { openIndex } from '../../../src/host/storage/sqlite-index.ts'
import { commitAll, createRepo, setupGit, writeRepoFile } from '../git/support.ts'
import { turnRecord } from '../safety/support.ts'

const git = createGitPort(createExecFileRunner())
const TURN_ID = 's-1:turn:3'
const WORKSPACE: TurnWorkspace = { workspaceId: 'ws-1', repoRoot: '' }

/** The lines of a diff, as a reader would see them, for a compact assertion. */
const rendered = (diff: FileDiff): readonly string[] => {
  if (diff.availability.kind !== 'text') return []
  return diff.availability.hunks.flatMap(hunk =>
    hunk.lines.map(line =>
      `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`,
    ),
  )
}

describe('createFileDiffReader', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  /**
   * A repository, an index, a store, and an inspector that writes to both.
   *
   * `maxBlobBytes` is a parameter because one of the cases is about a file the
   * checkpoint refused to copy, and the interesting part of that case is that the
   * refusal is *recorded* rather than that the file was large.
   */
  const fixture = async (options: { readonly maxBlobBytes?: number } = {}) => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'turnscope-diff-'))
    const root = await createRepo()
    cleanups.push(async () => {
      await rm(dataRoot, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    })

    const handle = await openIndex(join(dataRoot, 'index.sqlite3'))
    const repo = createRepository(handle)
    const store = createObjectStore(join(dataRoot, 'store'))
    const inspector = createTurnInspector({
      git,
      store,
      sink: repo,
      maxBlobBytes: options.maxBlobBytes ?? 1024 * 1024,
      ignorePaths: [],
      now: () => 1_700_000_000_000,
    })
    const workspace: TurnWorkspace = { ...WORKSPACE, repoRoot: root }
    const reader = createFileDiffReader({ git, store, sink: repo })

    return {
      root,
      repo,
      store,
      workspace,
      reader,
      /** Open a turn, so `PRE` is taken. */
      open: () => inspector.observe(running(), workspace, undefined),
      /** Close it, which takes `POST` and attributes the changes. */
      close: () => inspector.observe(completed(), workspace, 'running'),
      closeIndex: async () => {
        repo.close()
      },
    }
  }

  const running = (): TurnRecord => turnRecord({ status: 'running', endedAt: undefined })
  const completed = (): TurnRecord => turnRecord({ status: 'completed' })

  it('reads the before side from the commit the turn started from', async () => {
    const f = await fixture()
    await writeRepoFile(f.root, 'src/auth.ts', 'version 1\n')
    await commitAll(f.root, 'add auth')

    await f.open()
    await writeRepoFile(f.root, 'src/auth.ts', 'version 2\n')
    await f.close()

    const diff = await f.reader.read(completed(), f.workspace, 'src/auth.ts')

    expect(diff).toBeDefined()
    // The path was clean at PRE, so no checkpoint copied it. The committed
    // content is not a substitute for the before state here — it *is* the before
    // state, which is why this is a read rather than a guess.
    expect(diff?.before).toMatchObject({ source: 'git-object', byteSize: 10, lineCount: 1 })
    expect(diff?.after.source).toBe('recovery-blob')
    expect(diff?.availability.kind).toBe('text')
    expect(rendered(diff!)).toEqual(['-version 1', '+version 2'])
    expect(diff).toMatchObject({ attribution: 'AGENT', baseline: false, kind: 'modified' })
    await f.closeIndex()
  })

  it('reads the before side from the checkpoint when the path was already dirty', async () => {
    const f = await fixture()
    await writeRepoFile(f.root, 'README.md', 'committed notes\n')
    await commitAll(f.root, 'add readme')

    // The user's own uncommitted work exists before the turn starts, so `PRE`
    // does have a row for it — and that row, not `HEAD`, is the baseline.
    await writeRepoFile(f.root, 'README.md', 'notes the user wrote\n')
    await f.open()
    await writeRepoFile(f.root, 'README.md', 'notes the user wrote, and the agent\n')
    await f.close()

    const diff = await f.reader.read(completed(), f.workspace, 'README.md')

    expect(diff?.before.source).toBe('recovery-blob')
    expect(rendered(diff!)).toEqual(['-notes the user wrote', '+notes the user wrote, and the agent'])
    // Reported, and not claimed by the turn: the file was the user's before the
    // agent touched it.
    expect(diff).toMatchObject({ attribution: 'AGENT', baseline: true })
    await f.closeIndex()
  })

  it('shows a created file as additions with nothing before it', async () => {
    const f = await fixture()
    await f.open()
    await writeRepoFile(f.root, 'tests/auth.test.ts', 'export const ok = true\n')
    await f.close()

    const diff = await f.reader.read(completed(), f.workspace, 'tests/auth.test.ts')

    expect(diff?.before).toMatchObject({ source: 'absent', byteSize: 0, lineCount: 0 })
    expect(diff).toMatchObject({ kind: 'created' })
    expect(rendered(diff!)).toEqual(['+export const ok = true'])
    await f.closeIndex()
  })

  it('shows a deleted file as removals with nothing after it', async () => {
    const f = await fixture()
    await writeRepoFile(f.root, 'src/old.ts', 'export const gone = true\n')
    await commitAll(f.root, 'add old')

    await f.open()
    await rm(join(f.root, 'src/old.ts'))
    await f.close()

    const diff = await f.reader.read(completed(), f.workspace, 'src/old.ts')

    // The bytes of a deleted file are exactly the ones a recovery would need, so
    // the before side comes from git even though the worktree no longer has it.
    expect(diff?.before.source).toBe('git-object')
    expect(diff?.after).toMatchObject({ source: 'absent', byteSize: 0 })
    expect(diff).toMatchObject({ kind: 'deleted' })
    expect(rendered(diff!)).toEqual(['-export const gone = true'])
    await f.closeIndex()
  })

  it('follows a rename back to the name it had before the turn', async () => {
    const f = await fixture()
    await writeRepoFile(f.root, 'src/old.ts', 'version 1\n')
    await commitAll(f.root, 'add old')

    await f.open()
    // A staged rename, which is what `git status` reports as one; a worktree move
    // alone reads as a deletion plus an untracked file, and would be two changes.
    await setupGit(['mv', 'src/old.ts', 'src/new.ts'], f.root)
    await writeRepoFile(f.root, 'src/new.ts', 'version 2\n')
    await f.close()

    const diff = await f.reader.read(completed(), f.workspace, 'src/new.ts')

    expect(diff).toMatchObject({ path: 'src/new.ts', previousPath: 'src/old.ts', kind: 'renamed' })
    // The before bytes are read under the old name: `git cat-file HEAD:src/new.ts`
    // would fail, and reporting "unavailable" for every rename would make the case
    // that most needs a diff the one case that never has one.
    expect(diff?.before.source).toBe('git-object')
    expect(rendered(diff!)).toEqual(['-version 1', '+version 2'])
    await f.closeIndex()
  })

  it('does not render a binary file as text', async () => {
    const f = await fixture()
    await f.open()
    await writeRepoFile(f.root, 'logo.bin', Uint8Array.from([0x89, 0x50, 0x00, 0x0a, 0x1a]))
    await f.close()

    const diff = await f.reader.read(completed(), f.workspace, 'logo.bin')

    expect(diff?.availability.kind).toBe('binary')
    // Metadata is still offered, which is what `FR-07` asks for: a reader can be
    // told the file changed and how big it is without being shown mojibake.
    expect(diff?.after.byteSize).toBe(5)
    expect(rendered(diff!)).toEqual([])
    await f.closeIndex()
  })

  it('says the content was not saved rather than showing an empty file', async () => {
    // A checkpoint copies small files and only fingerprints big ones, so a large
    // changed file has a row with a digest and no blob.
    const f = await fixture({ maxBlobBytes: 64 })
    await f.open()
    await writeRepoFile(f.root, 'big.txt', `${'x'.repeat(200)}\n`)
    await f.close()

    const diff = await f.reader.read(completed(), f.workspace, 'big.txt')

    expect(diff?.availability).toMatchObject({ kind: 'unavailable', reason: 'not-recorded' })
    expect(diff?.availability).toMatchObject({
      detail: expect.stringContaining('larger than the size a checkpoint copies'),
    })
    // The fingerprint that *was* taken is still reported: the difference between
    // "we did not keep this" and "we know nothing about this" is the whole point
    // of the case.
    expect(diff?.after.contentHash).toBeDefined()
    expect(diff?.after.byteSize).toBe(0)
    await f.closeIndex()
  })

  it('reports a blob that retention took away', async () => {
    const f = await fixture()
    await f.open()
    await writeRepoFile(f.root, 'notes.txt', 'kept for now\n')
    await f.close()

    // Nothing removes objects yet, so this stands in for the retention policy
    // that will: the reference is on record and the bytes are gone.
    const stripped: ObjectStore = { ...f.store, has: async () => false }
    const reader = createFileDiffReader({ git, store: stripped, sink: f.repo })

    const diff = await reader.read(completed(), f.workspace, 'notes.txt')

    expect(diff?.availability).toMatchObject({ kind: 'unavailable', reason: 'missing-blob' })
    await f.closeIndex()
  })

  it('reports a turn whose checkpoints are no longer on record', async () => {
    const f = await fixture()
    await f.open()
    await writeRepoFile(f.root, 'notes.txt', 'something\n')
    await f.close()

    const sink: TraceRepository = { ...f.repo, getCheckpoint: async () => undefined }
    const reader = createFileDiffReader({ git, store: f.store, sink })

    const diff = await reader.read(completed(), f.workspace, 'notes.txt')

    expect(diff?.availability).toMatchObject({ kind: 'unavailable', reason: 'no-checkpoint' })
    await f.closeIndex()
  })

  it('answers nothing for a path the turn did not change', async () => {
    const f = await fixture()
    await f.open()
    await writeRepoFile(f.root, 'notes.txt', 'something\n')
    await f.close()

    // Not an error and not an empty diff: the turn has no record of that path,
    // and a reader must not be shown "nothing changed here" about a file the
    // turn never looked at.
    expect(await f.reader.read(completed(), f.workspace, 'src/never-touched.ts')).toBeUndefined()
    await f.closeIndex()
  })
})
