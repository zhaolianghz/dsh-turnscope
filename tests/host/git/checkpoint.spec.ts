import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createExecFileRunner } from '../../../src/host/git/command-runner.ts'
import { createGitPort } from '../../../src/host/git/git-port.ts'
import {
  captureCheckpoint,
  type CheckpointDeps,
} from '../../../src/host/git/checkpoint.ts'
import { createObjectStore } from '../../../src/host/storage/object-store.ts'
import { createRepository } from '../../../src/host/storage/repository.ts'
import type { TraceRepository } from '../../../src/host/storage/repository.ts'
import { openIndex } from '../../../src/host/storage/sqlite-index.ts'
import { commitAll, createRepo, createRecordingSink, writeRepoFile } from './support.ts'

const sha256 = (text: string): string =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`

const git = createGitPort(createExecFileRunner())

describe('captureCheckpoint', () => {
  const roots: string[] = []
  let dataRoot: string

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'turnscope-data-'))
    roots.push(dataRoot)
  })

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  const makeRepo = async (): Promise<string> => {
    const root = await createRepo()
    roots.push(root)
    return root
  }

  const makeDeps = (
    overrides: Partial<Pick<CheckpointDeps, 'maxBlobBytes' | 'ignorePaths'>> = {},
  ): {
    deps: CheckpointDeps
    sink: ReturnType<typeof createRecordingSink>
    store: ReturnType<typeof createObjectStore>
  } => {
    const sink = createRecordingSink()
    const store = createObjectStore(join(dataRoot, 'store'))
    return {
      deps: {
        git,
        store,
        sink,
        maxBlobBytes: 1024 * 1024,
        ignorePaths: [],
        ...overrides,
      },
      sink,
      store,
    }
  }

  const capture = (
    deps: CheckpointDeps,
    root: string,
    extra: { phase?: 'pre' | 'post'; hintedPaths?: readonly string[] } = {},
  ) =>
    captureCheckpoint(deps, {
      workspaceId: 'ws-1',
      repoRoot: root,
      turnId: 'turn-1',
      phase: extra.phase ?? 'pre',
      ...(extra.hintedPaths === undefined ? {} : { hintedPaths: extra.hintedPaths }),
      now: 1_700_000_000_000,
    })

  it('records a failed checkpoint instead of throwing when there is no repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turnscope-plain-'))
    roots.push(root)
    const { deps, sink } = makeDeps()

    const { record, paths, capturedPaths } = await capture(deps, root)

    expect(record.completeness).toBe('failed')
    expect(record.failureReason).toBe('not a git worktree')
    // Never optimistic: a checkpoint that could not be taken is not restorable.
    expect(record.restorable).toBe(false)
    expect(paths).toEqual([])
    expect(capturedPaths).toEqual([])
    expect(sink.checkpoints).toHaveLength(1)
  })

  it('records a clean repository as complete with nothing to capture', async () => {
    const root = await makeRepo()
    const { deps, sink } = makeDeps()

    const { record, paths, capturedPaths } = await capture(deps, root)

    expect(record.cleanStart).toBe(true)
    expect(record.completeness).toBe('complete')
    expect(record.restorable).toBe(true)
    expect(record.headOid).toMatch(/^[0-9a-f]{40}$/)
    expect(record.mergeInProgress).toBe(false)
    expect(record.rebaseInProgress).toBe(false)
    expect(record.cherryPickInProgress).toBe(false)
    expect(paths).toEqual([])
    expect(capturedPaths).toEqual([])
    expect(sink.objects).toEqual([])
  })

  it('records an in-progress merge, which a later reader cannot reconstruct', async () => {
    const root = await makeRepo()
    await writeRepoFile(root, '.git/MERGE_HEAD', `${'0'.repeat(39)}1\n`)
    const { deps } = makeDeps()

    const { record } = await capture(deps, root)

    expect(record.mergeInProgress).toBe(true)
    expect(record.rebaseInProgress).toBe(false)
    expect(record.cherryPickInProgress).toBe(false)
  })

  it('captures the bytes and the digest of a modified tracked file', async () => {
    const root = await makeRepo()
    await writeRepoFile(root, 'a.txt', 'base\n')
    await commitAll(root, 'base')
    await writeRepoFile(root, 'a.txt', 'changed\n')

    const { deps, sink, store } = makeDeps()
    const { record, paths, capturedPaths } = await capture(deps, root, { phase: 'post' })

    expect(record.cleanStart).toBe(false)
    expect(record.completeness).toBe('complete')
    expect(record.id).toBe('turn-1:cp:post')
    expect(record.fileDigests?.['a.txt']).toBe(sha256('changed\n'))

    const path = paths[0]
    expect(path).toMatchObject({
      checkpointId: 'turn-1:cp:post',
      id: 'turn-1:cp:post:path:a.txt',
      path: 'a.txt',
      status: 'modified',
      staged: false,
      binary: false,
      contentHash: sha256('changed\n'),
    })
    expect(path?.blobRef).toBeDefined()
    expect(capturedPaths).toEqual(['a.txt'])

    const stored = await store.get(path?.blobRef ?? '')
    expect(Buffer.from(stored).toString('utf8')).toBe('changed\n')
    expect(sink.objects).toHaveLength(1)
    expect(sink.objects[0]?.kind).toBe('recovery-blob')
  })

  it('recovers a deleted file’s bytes from git, since the disk no longer has them', async () => {
    const root = await makeRepo()
    await writeRepoFile(root, 'gone.txt', 'the only copy\n')
    await commitAll(root, 'gone')
    await rm(join(root, 'gone.txt'))

    const { deps, store } = makeDeps()
    const { paths } = await capture(deps, root)

    const path = paths.find(entry => entry.path === 'gone.txt')
    expect(path?.status).toBe('deleted')
    expect(path?.contentHash).toBe(sha256('the only copy\n'))
    const stored = await store.get(path?.blobRef ?? '')
    expect(Buffer.from(stored).toString('utf8')).toBe('the only copy\n')
  })

  it('captures an untracked file', async () => {
    const root = await makeRepo()
    await writeRepoFile(root, 'new.txt', 'brand new\n')

    const { deps } = makeDeps()
    const { paths } = await capture(deps, root)

    expect(paths).toEqual([
      expect.objectContaining({
        path: 'new.txt',
        status: 'untracked',
        staged: false,
        contentHash: sha256('brand new\n'),
      }),
    ])
  })

  it('marks binary content and stores its bytes unchanged', async () => {
    const root = await makeRepo()
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x00])
    await writeRepoFile(root, 'blob.bin', bytes)

    const { deps, store } = makeDeps()
    const { paths } = await capture(deps, root)

    expect(paths[0]?.binary).toBe(true)
    const stored = await store.get(paths[0]?.blobRef ?? '')
    expect([...stored]).toEqual([...bytes])
  })

  it('stores a symlink as its target string rather than reading through it', async () => {
    const root = await makeRepo()
    await writeRepoFile(root, 'real.txt', 'real\n')
    await commitAll(root, 'real')
    await symlink('real.txt', join(root, 'link.txt'))

    const { deps, store } = makeDeps()
    const { paths } = await capture(deps, root)

    const path = paths.find(entry => entry.path === 'link.txt')
    expect(path?.binary).toBe(false)
    expect(path?.contentHash).toBe(sha256('real.txt'))
    expect(Buffer.from(await store.get(path?.blobRef ?? '')).toString('utf8')).toBe('real.txt')
  })

  it('fingerprints an oversized file but refuses to claim it is restorable', async () => {
    const root = await makeRepo()
    await writeRepoFile(root, 'big.txt', 'much longer than the budget\n')

    const { deps } = makeDeps({ maxBlobBytes: 4 })
    const { record, paths, capturedPaths } = await capture(deps, root)

    expect(record.completeness).toBe('partial')
    expect(record.restorable).toBe(false)
    expect(record.fileDigests?.['big.txt']).toBe(sha256('much longer than the budget\n'))
    expect(paths[0]?.contentHash).toBeDefined()
    expect(paths[0]?.blobRef).toBeUndefined()
    expect(capturedPaths).toEqual([])
  })

  it('never observes an ignored path', async () => {
    const root = await makeRepo()
    await writeRepoFile(root, 'node_modules/pkg/index.js', 'generated\n')
    await writeRepoFile(root, 'src/index.ts', 'real\n')

    const { deps } = makeDeps({ ignorePaths: ['node_modules'] })
    const { record, paths } = await capture(deps, root)

    expect(paths.map(entry => entry.path)).toEqual(['src/index.ts'])
    // Filtering is not a failure: nothing that should have been observed was lost.
    expect(record.completeness).toBe('complete')
  })

  it('fingerprints a hinted path that git no longer reports as changed', async () => {
    const root = await makeRepo()
    await writeRepoFile(root, 'a.txt', 'stable\n')
    await commitAll(root, 'a')

    const { deps, store } = makeDeps()
    const { record, paths } = await capture(deps, root, { hintedPaths: ['a.txt'] })

    // The hint does not make the repository dirty…
    expect(record.cleanStart).toBe(true)
    // …but the path is still fingerprinted, which is what target-drift needs.
    expect(paths).toEqual([
      expect.objectContaining({ path: 'a.txt', status: 'clean', contentHash: sha256('stable\n') }),
    ])
    expect(Buffer.from(await store.get(paths[0]?.blobRef ?? '')).toString('utf8')).toBe('stable\n')
  })

  it('ignores a hinted path that would escape the repository', async () => {
    const root = await makeRepo()
    await writeRepoFile(root, 'a.txt', 'inside\n')
    await commitAll(root, 'a')

    const { deps } = makeDeps()
    const { paths } = await capture(deps, root, {
      hintedPaths: ['../outside.txt', '/etc/passwd', './a.txt'],
    })

    expect(paths.map(entry => entry.path)).toEqual(['a.txt'])
  })

  it('is idempotent in its ids, so re-observing a phase rewrites rather than appends', async () => {
    const root = await makeRepo()
    await writeRepoFile(root, 'a.txt', 'one\n')

    const first = makeDeps()
    const second = makeDeps()
    const one = await capture(first.deps, root, { phase: 'pre' })
    const two = await capture(second.deps, root, { phase: 'pre' })

    expect(two.record.id).toBe(one.record.id)
    expect(two.paths.map(path => path.id)).toEqual(one.paths.map(path => path.id))
    expect(two.record.worktreeDigest).toBe(one.record.worktreeDigest)
  })

  it('reflects the worktree digest only when there is something in it', async () => {
    const root = await makeRepo()
    const clean = makeDeps()
    expect((await capture(clean.deps, root)).record.worktreeDigest).toBeUndefined()

    await writeFile(join(root, 'a.txt'), 'a\n', 'utf8')
    const dirty = makeDeps()
    expect((await capture(dirty.deps, root)).record.worktreeDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('round-trips through the real index without losing a field', async () => {
    const root = await makeRepo()
    await writeRepoFile(root, 'src/auth.ts', 'before\n')
    await commitAll(root, 'auth')
    await writeRepoFile(root, 'src/auth.ts', 'after\n')
    await writeRepoFile(root, 'src/new.ts', 'fresh\n')

    const handle = await openIndex(join(dataRoot, 'index.sqlite3'))
    const repository: TraceRepository = createRepository(handle)
    const store = createObjectStore(dataRoot)
    try {
      const { record, paths } = await captureCheckpoint(
        { git, store, sink: repository, maxBlobBytes: 1024 * 1024, ignorePaths: [] },
        {
          workspaceId: 'ws-1',
          repoRoot: root,
          turnId: 'turn-1',
          phase: 'post',
          now: 1_700_000_000_000,
        },
      )

      const stored = await repository.getCheckpoint(record.id)
      expect(stored).toEqual(record)

      const storedPaths = await repository.listCheckpointPaths(record.id)
      expect(storedPaths.map(path => path.path).sort()).toEqual(['src/auth.ts', 'src/new.ts'])
      for (const path of storedPaths) {
        if (path.blobRef === undefined) continue
        const bytes = Buffer.from(await store.get(path.blobRef)).toString('utf8')
        expect(bytes).toBe(path.path === 'src/auth.ts' ? 'after\n' : 'fresh\n')
      }
      expect(paths).toHaveLength(2)
    } finally {
      await repository.close()
    }
  })
})
