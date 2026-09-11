import { rm, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createExecFileRunner,
  type CommandRunner,
  type RunOptions,
} from '../../../src/host/git/command-runner.ts'
import { createGitPort, parseStatusPorcelainV2 } from '../../../src/host/git/git-port.ts'
import { commitAll, createRepo, writeRepoFile } from './support.ts'

const oid = (character: string): string => character.repeat(40)

/** Build the NUL-separated field stream `git status --porcelain=v2 -z` emits. */
const porcelain = (fields: readonly string[]): Uint8Array =>
  Buffer.from(fields.map(field => `${field}\0`).join(''), 'utf8')

describe('parseStatusPorcelainV2', () => {
  it('reads an ordinary unstaged modification', () => {
    const entries = parseStatusPorcelainV2(
      porcelain([`1 .M N... 100644 100644 100644 ${oid('a')} ${oid('b')} file.txt`]),
    )
    expect(entries).toEqual([
      {
        path: 'file.txt',
        status: 'modified',
        staged: false,
        unmerged: false,
        mode: '100644',
        headOid: oid('a'),
        indexOid: oid('b'),
      },
    ])
  })

  it('marks a staged change and classifies an addition and a deletion', () => {
    const entries = parseStatusPorcelainV2(
      porcelain([
        `1 M. N... 100644 100644 100644 ${oid('a')} ${oid('b')} staged.txt`,
        `1 A. N... 000000 100644 100644 ${oid('0')} ${oid('c')} added.txt`,
        `1 .D N... 100644 100644 000000 ${oid('d')} ${oid('d')} gone.txt`,
      ]),
    )
    expect(entries.map(entry => [entry.path, entry.status, entry.staged])).toEqual([
      ['staged.txt', 'modified', true],
      ['added.txt', 'added', true],
      ['gone.txt', 'deleted', false],
    ])
    // A zero id is git's "no object", not an id, and must not be stored as one.
    expect(entries[1]?.headOid).toBeUndefined()
    expect(entries[2]?.mode).toBeUndefined()
  })

  it('takes a rename’s original path from the following field', () => {
    const entries = parseStatusPorcelainV2(
      porcelain([
        `2 R. N... 100644 100644 100644 ${oid('a')} ${oid('b')} R100 new name.txt`,
        'old name.txt',
      ]),
    )
    expect(entries).toEqual([
      {
        path: 'new name.txt',
        previousPath: 'old name.txt',
        status: 'renamed',
        staged: true,
        unmerged: false,
        mode: '100644',
        headOid: oid('a'),
        indexOid: oid('b'),
      },
    ])
  })

  it('keeps a path containing a space intact', () => {
    const entries = parseStatusPorcelainV2(
      porcelain([`1 .M N... 100644 100644 100644 ${oid('a')} ${oid('b')} a b c.txt`]),
    )
    expect(entries[0]?.path).toBe('a b c.txt')
  })

  it('reports an unmerged entry as modified and unmerged', () => {
    const entries = parseStatusPorcelainV2(
      porcelain([
        `u UU N... 100644 100644 100644 100644 ${oid('a')} ${oid('b')} ${oid('c')} conflict.txt`,
      ]),
    )
    expect(entries[0]).toMatchObject({ path: 'conflict.txt', status: 'modified', unmerged: true })
  })

  it('records an untracked file and drops an ignored one', () => {
    const entries = parseStatusPorcelainV2(porcelain(['? new.txt', '! build/out.js']))
    expect(entries).toEqual([
      { path: 'new.txt', status: 'untracked', staged: false, unmerged: false },
    ])
  })

  it('returns nothing for a clean tree', () => {
    expect(parseStatusPorcelainV2(porcelain([]))).toEqual([])
  })
})

describe('createGitPort', () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  const makeRepo = async (): Promise<string> => {
    const root = await createRepo()
    roots.push(root)
    return root
  }

  const port = createGitPort(createExecFileRunner())

  it('distinguishes a repository from a directory that is not one', async () => {
    const root = await makeRepo()
    expect(await port.isRepository(root)).toBe(true)

    const plain = await makeRepo()
    await rm(`${plain}/.git`, { recursive: true, force: true })
    expect(await port.isRepository(plain)).toBe(false)
    expect(await port.status(plain)).toBeUndefined()
    expect(await port.head(plain)).toBeUndefined()
  })

  it('reports the worktree root, the common dir and HEAD', async () => {
    const root = await makeRepo()
    await writeRepoFile(root, 'a.txt', 'hello\n')
    await commitAll(root, 'add a')

    expect(await port.toplevel(root)).toBeTruthy()
    expect(await port.commonDir(root)).toMatch(/\.git$/)
    const head = await port.head(root)
    expect(head?.oid).toMatch(/^[0-9a-f]{40}$/)
    expect(typeof head?.branch).toBe('string')
  })

  it('lists every changed path, including files inside an untracked directory', async () => {
    const root = await makeRepo()
    await writeRepoFile(root, 'tracked.txt', 'one\n')
    await commitAll(root, 'tracked')

    await writeRepoFile(root, 'tracked.txt', 'two\n')
    await writeRepoFile(root, 'nested/deep/new.txt', 'fresh\n')

    const status = await port.status(root)
    expect(status).toBeDefined()
    const byPath = new Map(status?.map(entry => [entry.path, entry]))
    expect(byPath.get('tracked.txt')?.status).toBe('modified')
    expect(byPath.get('nested/deep/new.txt')?.status).toBe('untracked')
  })

  it('hashes a file without writing an object into the repository', async () => {
    const root = await makeRepo()
    await writeRepoFile(root, 'unique.txt', 'content that is not committed\n')

    const objectId = await port.hashObject(root, 'unique.txt')
    expect(objectId).toMatch(/^[0-9a-f]{40}$/)

    // The decisive check: if `-w` had been passed, the object would be readable.
    expect(await port.blob(root, objectId ?? '')).toBeUndefined()
  })

  it('reads back the bytes of a stored blob', async () => {
    const root = await makeRepo()
    await writeRepoFile(root, 'bytes.txt', 'exact bytes\n')
    await commitAll(root, 'bytes')

    const objectId = await port.hashObject(root, 'bytes.txt')
    const bytes = await port.blob(root, objectId ?? '')
    expect(Buffer.from(bytes ?? []).toString('utf8')).toBe('exact bytes\n')
  })

  it('resolves a git path for in-progress-state detection', async () => {
    const root = await makeRepo()
    expect(await port.gitPath(root, 'MERGE_HEAD')).toMatch(/MERGE_HEAD$/)
  })

  it('emits only read-only subcommands, as argv rather than a command line', async () => {
    const recorded: string[][] = []
    const recording: CommandRunner = {
      run: (argv: readonly string[], options: RunOptions) => {
        recorded.push([...argv])
        return createExecFileRunner().run(argv, options)
      },
    }
    const watched = createGitPort(recording)
    const root = await makeRepo()
    await watched.status(root)
    await watched.head(root)
    await watched.commonDir(root)

    // The source-level guard pins what the code says; this pins what it emits, so
    // a new call site cannot quietly reach a write through a spelling the guard's
    // regular expressions happened not to cover.
    const readOnly = new Set(['rev-parse', 'status', 'hash-object', 'cat-file', 'symbolic-ref', 'config'])
    expect(recorded.length).toBeGreaterThan(0)
    for (const argv of recorded) {
      expect(argv[0]).toBe('git')
      expect(readOnly.has(argv[1] ?? '')).toBe(true)
      expect(argv).not.toContain('-w')
    }
    expect(recorded[0]).toEqual(['git', 'status', '--porcelain=v2', '-z', '--untracked-files=all'])
  })

  it('returns undefined for a git question that does not apply', async () => {
    const root = await makeRepo()
    expect(await port.canonicalRemote(root)).toBeUndefined()
    await rm(`${root}/.git/HEAD`, { force: true })
    expect(await port.status(root)).toBeUndefined()
  })

  it('parses the real status of a clean repository as empty', async () => {
    const root = await makeRepo()
    expect(await port.status(root)).toEqual([])
    // A file written after the commit is the only difference.
    await writeFile(`${root}/later.txt`, 'later\n', 'utf8')
    expect((await port.status(root))?.map(entry => entry.path)).toEqual(['later.txt'])
  })
})
