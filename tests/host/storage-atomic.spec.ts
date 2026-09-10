import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type TurnscopeConfig } from '../../src/config.ts'
import { writeFileAtomic } from '../../src/host/storage/atomic.ts'
import { resolveDataRoot } from '../../src/host/storage/paths.ts'

/** Owner-only access bits, with the file-type bits masked off. */
const permissions = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

const configWithDataDir = (dataDir: string | undefined): TurnscopeConfig => ({
  ...DEFAULT_CONFIG,
  dataDir,
})

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'turnscope-storage-'))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('resolveDataRoot', () => {
  const homeDir = join(tmpdir(), 'turnscope-home')

  it('returns an explicit dataDir verbatim', () => {
    const dataDir = join(tmpdir(), 'explicit-turnscope')
    expect(resolveDataRoot(configWithDataDir(dataDir), {}, homeDir)).toBe(dataDir)
  })

  it('prefers dataDir over DSH_HOME', () => {
    const dataDir = join(tmpdir(), 'explicit-turnscope')
    const dshHome = join(tmpdir(), 'dsh-home')
    expect(resolveDataRoot(configWithDataDir(dataDir), { DSH_HOME: dshHome }, homeDir)).toBe(
      dataDir,
    )
  })

  it('falls back to <DSH_HOME>/turnscope', () => {
    const dshHome = join(tmpdir(), 'dsh-home')
    expect(resolveDataRoot(configWithDataDir(undefined), { DSH_HOME: dshHome }, homeDir)).toBe(
      join(dshHome, 'turnscope'),
    )
  })

  it('ignores a relative or empty DSH_HOME', () => {
    expect(
      resolveDataRoot(configWithDataDir(undefined), { DSH_HOME: 'relative/dsh' }, homeDir),
    ).toBe(join(homeDir, '.dsh', 'turnscope'))
    expect(resolveDataRoot(configWithDataDir(undefined), { DSH_HOME: '' }, homeDir)).toBe(
      join(homeDir, '.dsh', 'turnscope'),
    )
  })

  it('falls back to <homeDir>/.dsh/turnscope', () => {
    expect(resolveDataRoot(configWithDataDir(undefined), {}, homeDir)).toBe(
      join(homeDir, '.dsh', 'turnscope'),
    )
  })

  it('never derives the root from process.cwd()', () => {
    // The fallback must come from homeDir alone. If the implementation ever
    // consulted cwd, the result would move with the project the user opened.
    expect(homeDir.startsWith(process.cwd())).toBe(false)
    const resolved = resolveDataRoot(configWithDataDir(undefined), {}, homeDir)
    expect(resolved).toBe(join(homeDir, '.dsh', 'turnscope'))
    expect(resolved.startsWith(process.cwd())).toBe(false)
    expect(resolved).not.toContain(`${process.cwd()}/`)
  })

  it('refuses a relative or empty homeDir rather than resolving it against process.cwd()', () => {
    // Every one of these makes `path.resolve` start from the cwd, so without the
    // isAbsolute guard the store would land inside whichever project is open.
    for (const badHome of ['relative/home', '', '.', '..']) {
      const label = `homeDir ${JSON.stringify(badHome)}`
      let resolved: string | undefined
      let thrown: unknown
      try {
        resolved = resolveDataRoot(configWithDataDir(undefined), {}, badHome)
      } catch (error) {
        thrown = error
      }

      if (thrown === undefined) {
        // A cwd-free fallback would be acceptable; a cwd-derived one is not.
        expect(resolved, label).not.toContain(process.cwd())
      } else {
        expect(thrown, label).toBeInstanceOf(Error)
        expect((thrown as Error).message, label).toMatch(/absolute/)
        expect((thrown as Error).message, label).toContain(JSON.stringify(badHome))
      }
    }
  })
})

describe('writeFileAtomic', () => {
  it('creates the parent directory 0o700 and the file 0o600', async () => {
    const directory = join(scratch, 'nested')
    const target = join(directory, 'payload.bin')

    await writeFileAtomic(target, new Uint8Array([1, 2, 3]))

    expect(await permissions(directory)).toBe(0o700)
    expect(await permissions(target)).toBe(0o600)
  })

  it('writes the exact input bytes', async () => {
    const target = join(scratch, 'payload.bin')
    const bytes = new Uint8Array([0x00, 0xff, 0x41, 0x00])

    await writeFileAtomic(target, bytes)

    expect(new Uint8Array(await readFile(target))).toEqual(bytes)
  })

  it('leaves no temporary sibling behind', async () => {
    const target = join(scratch, 'payload.bin')

    await writeFileAtomic(target, new Uint8Array([7]))

    expect(await readdir(scratch)).toEqual(['payload.bin'])
  })

  it('replaces the contents of an existing file', async () => {
    const target = join(scratch, 'payload.bin')

    await writeFileAtomic(target, new Uint8Array([1, 1, 1]))
    await writeFileAtomic(target, new Uint8Array([2]))

    expect(new Uint8Array(await readFile(target))).toEqual(new Uint8Array([2]))
    expect(await readdir(scratch)).toEqual(['payload.bin'])
  })
})
