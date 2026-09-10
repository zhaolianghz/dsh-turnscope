/**
 * Ratchets on the properties that are cheap to state and expensive to lose.
 *
 * Every assertion here holds today and could be checked by hand once. They are
 * tests because "checked once" is not a property — the value is in failing the
 * first commit that would break them, which is the commit whose author is least
 * likely to be thinking about them.
 *
 * They read source text rather than behaviour on purpose: what is being pinned
 * is what the code is *allowed to say*, which no unit test observes.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('../../src', import.meta.url).pathname

interface SourceFile {
  readonly path: string
  readonly text: string
}

async function sourceFiles(dir: string = ROOT): Promise<readonly SourceFile[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  const files: SourceFile[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    const path = relative(ROOT, join(entry.parentPath, entry.name))
    files.push({ path, text: await readFile(join(entry.parentPath, entry.name), 'utf8') })
  }
  return files
}

const matching = (files: readonly SourceFile[], pattern: RegExp): readonly string[] =>
  files.filter(file => pattern.test(file.text)).map(file => file.path)

let cache: readonly SourceFile[] | undefined
const sources = async (): Promise<readonly SourceFile[]> => (cache ??= await sourceFiles())

describe('source invariants', () => {
  it('actually reads the source tree', async () => {
    const files = await sources()
    // Every assertion below is of the form "this pattern matches nothing", and
    // every one of them passes against an empty list. Without this, a broken
    // scan would turn the whole file into six green no-ops — the guard would
    // report safety while checking nothing.
    expect(files.length).toBeGreaterThan(15)
    expect(files.map(file => file.path)).toContain('host/storage/object-store.ts')
  })

  it('never runs a shell', async () => {
    const files = await sources()
    // `execSync`, a shell string, or an explicit `sh -c` — the three ways a
    // string becomes a command line. Git is reached through an argv array or not
    // at all, so an argument containing `; rm -rf` stays an argument.
    expect(matching(files, /execSync|shell:\s*true|sh -c|['"]sh['"],\s*['"]-c/)).toEqual([])
  })

  it('imports only execFile from child_process', async () => {
    const files = await sources()
    for (const file of files.filter(item => item.text.includes('node:child_process'))) {
      // The conditional is the point: this says "if you spawn, spawn this way",
      // which is what makes adding a runner a deliberate act rather than a
      // copy-paste of whichever import autocompleted.
      expect(file.text).toMatch(/import\s*\{[^}]*\bexecFile\b[^}]*\}\s*from\s*'node:child_process'/)
    }
  })

  it('performs no Git write, because V0.1 has no recovery', async () => {
    const files = await sources()
    // `hash-object` is allowed and `hash-object -w` is not: the hash is needed to
    // fingerprint a file, and `-w` would write a loose object into the user's
    // repository — a side effect on a workspace this slice promises not to touch.
    expect(
      matching(
        files,
        /reset --hard|clean -fd|checkout --|write-tree|hash-object -w|update-ref|commit-tree|\bgit tag\b|\bgit commit\b/,
      ),
    ).toEqual([])
  })

  it('confines the SQLite driver to the storage module', async () => {
    const files = await sources()
    // Not merely tidiness: the port is what keeps a future backend swappable, and
    // a stray import is how a query ends up written against the driver directly.
    expect(matching(files, /node:sqlite/).every(path => path.startsWith('host/storage/'))).toBe(true)
  })

  it('makes no network call, because nothing leaves the machine', async () => {
    const files = await sources()
    // `docs/PRD.md §22`: no telemetry, no uploads, no accounts. There is nowhere
    // for a secret to go if there is no code that can send one.
    expect(
      matching(files, /fetch\s*\(|node:https?|undici|XMLHttpRequest|WebSocket|net\.connect/),
    ).toEqual([])
  })

  it('writes raw file bytes from nowhere but the observer', async () => {
    const files = await sources()
    // `raw-bytes` is the redaction-boundary escape hatch: those bytes are stored
    // byte-identical, so a secret in them stays a secret on disk. Exactly one
    // module is allowed to need that — the workspace observer, capturing a file
    // so a recovery can put it back. Anywhere else it is a leak.
    const allowed = ['host/storage/', 'host/git/']
    expect(
      matching(files, /raw-bytes/).filter(
        path => !allowed.some(prefix => path.startsWith(prefix)),
      ),
    ).toEqual([])
  })
})
