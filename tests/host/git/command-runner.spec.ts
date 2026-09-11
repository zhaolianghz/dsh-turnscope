import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExecFileRunner } from '../../../src/host/git/command-runner.ts'

/**
 * The runner is the one place this plugin creates a process, so these tests are
 * about the properties a caller relies on rather than about git: a non-zero exit
 * is data, a missing binary is an exception, a runaway command is bounded, and
 * an argument is never a shell word.
 */
describe('createExecFileRunner', () => {
  let root: string | undefined

  const tempDir = async (): Promise<string> => {
    root = await mkdtemp(join(tmpdir(), 'turnscope-runner-'))
    return root
  }

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  const runner = createExecFileRunner()

  it('resolves a non-zero exit instead of rejecting it', async () => {
    const cwd = await tempDir()
    // Outside a worktree `rev-parse` exits 128. That is an answer to "is this a
    // repository", not a malfunction, and the port upstream wants to read it.
    const result = await runner.run(['git', 'rev-parse', '--is-inside-work-tree'], { cwd })
    expect(result.exitCode).not.toBe(0)
    expect(result.incomplete).toBeUndefined()
  })

  it('rejects when the executable does not exist', async () => {
    const cwd = await tempDir()
    await expect(
      runner.run(['turnscope-definitely-not-a-real-binary'], { cwd }),
    ).rejects.toThrow(/cannot run/)
  })

  it('rejects when the working directory does not exist', async () => {
    const cwd = await tempDir()
    await expect(runner.run(['git', '--version'], { cwd: join(cwd, 'nope') })).rejects.toThrow(
      /cannot run/,
    )
  })

  it('treats an argument as one argument, never as shell syntax', async () => {
    const cwd = await tempDir()
    const marker = join(cwd, 'pwned')

    // If this string reached a shell, the `;` would end the git command and the
    // `touch` would run. With `shell: false` it is passed as one argv element
    // that git cannot resolve as an object name, so nothing is created.
    const result = await runner.run(
      ['git', 'rev-parse', '--verify', '--quiet', `nonexistent; touch ${marker}`],
      { cwd },
    )

    expect(result.exitCode).not.toBe(0)
    await expect(stat(marker)).rejects.toThrow()
  })

  it('kills a command that exceeds its output budget and marks the result', async () => {
    const cwd = await tempDir()
    const result = await runner.run(['git', '--version'], { cwd, maxOutputBytes: 1 })
    expect(result.incomplete).toBe('output-limit')
    expect(result.exitCode).toBeUndefined()
  })

  it('kills a command that exceeds its time limit and marks the result', async () => {
    const cwd = await tempDir()
    const result = await runner.run(['node', '-e', 'setTimeout(() => {}, 5000)'], {
      cwd,
      timeoutMs: 100,
    })
    expect(result.incomplete).toBe('timeout')
    expect(result.exitCode).toBeUndefined()
  })

  it('captures stdout as bytes, so a binary payload survives intact', async () => {
    const cwd = await tempDir()
    const result = await runner.run(['node', '-e', 'process.stdout.write(Buffer.from([0,255,1]))'], {
      cwd,
    })
    expect(result.exitCode).toBe(0)
    expect([...result.stdout]).toEqual([0, 255, 1])
  })
})
