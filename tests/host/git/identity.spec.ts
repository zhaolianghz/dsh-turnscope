import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExecFileRunner } from '../../../src/host/git/command-runner.ts'
import { createGitPort } from '../../../src/host/git/git-port.ts'
import { canonicalizeRemote, resolveRepositoryIdentity } from '../../../src/host/git/identity.ts'
import { createRepo, setupGit } from './support.ts'

const port = createGitPort(createExecFileRunner())

describe('canonicalizeRemote', () => {
  it('strips the two spellings that mean the same repository', () => {
    expect(canonicalizeRemote('https://example.com/org/repo.git')).toBe('https://example.com/org/repo')
    expect(canonicalizeRemote('https://example.com/org/repo/')).toBe('https://example.com/org/repo')
    expect(canonicalizeRemote('  git@example.com:org/repo.git  ')).toBe('git@example.com:org/repo')
  })

  it('keeps case, because a remote can be served case-sensitively', () => {
    expect(canonicalizeRemote('https://example.com/Org/Repo.git')).toBe('https://example.com/Org/Repo')
  })
})

describe('resolveRepositoryIdentity', () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  const makeRepo = async (): Promise<string> => {
    const root = await createRepo()
    roots.push(root)
    return root
  }

  it('returns undefined outside a repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turnscope-plain-'))
    roots.push(root)
    expect(await resolveRepositoryIdentity(port, root)).toBeUndefined()
  })

  it('keys the identity on the canonical root, not the path it was asked about', async () => {
    const root = await makeRepo()
    await mkdir(join(root, 'nested', 'deeper'), { recursive: true })

    const fromRoot = await resolveRepositoryIdentity(port, root)
    const fromNested = await resolveRepositoryIdentity(port, join(root, 'nested', 'deeper'))
    const canonicalRoot = await realpath(root)

    expect(fromRoot?.rootIdentity).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(fromRoot?.repoRoot).toBe(canonicalRoot)
    // The decisive property: the same repository reached by a different `cwd`
    // must not become a second workspace in the index.
    expect(fromNested?.rootIdentity).toBe(fromRoot?.rootIdentity)
    expect(fromNested?.repoRoot).toBe(canonicalRoot)
  })

  it('gives two unrelated repositories different identities', async () => {
    const first = await resolveRepositoryIdentity(port, await makeRepo())
    const second = await resolveRepositoryIdentity(port, await makeRepo())
    expect(first?.rootIdentity).not.toBe(second?.rootIdentity)
  })

  it('gives every worktree of one repository the same identity', async () => {
    const root = await makeRepo()
    const linked = await mkdtemp(join(tmpdir(), 'turnscope-linked-'))
    roots.push(linked)
    const worktree = join(linked, 'wt')
    await setupGit(['worktree', 'add', '-q', '-b', 'side', worktree], root)

    const main = await resolveRepositoryIdentity(port, root)
    const side = await resolveRepositoryIdentity(port, worktree)

    expect(side?.repoRoot).not.toBe(main?.repoRoot)
    expect(side?.commonDir).toBe(main?.commonDir)
    expect(side?.rootIdentity).toBe(main?.rootIdentity)
  })

  it('separates two clones by their remote, and unifies the spellings of one', async () => {
    const root = await makeRepo()
    await setupGit(['remote', 'add', 'origin', 'https://example.com/org/repo.git'], root)
    const withGitSuffix = await resolveRepositoryIdentity(port, root)

    await setupGit(['remote', 'set-url', 'origin', 'https://example.com/org/repo/'], root)
    const withSlash = await resolveRepositoryIdentity(port, root)

    await setupGit(['remote', 'set-url', 'origin', 'https://example.com/other/repo.git'], root)
    const otherRepo = await resolveRepositoryIdentity(port, root)

    expect(withSlash?.rootIdentity).toBe(withGitSuffix?.rootIdentity)
    expect(withSlash?.remote).toBe('https://example.com/org/repo')
    expect(otherRepo?.rootIdentity).not.toBe(withGitSuffix?.rootIdentity)
  })
})
