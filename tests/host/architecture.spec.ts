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

/**
 * Remove comments while leaving string contents alone.
 *
 * Without this the guard cannot tell "here is the ban" from "here is code that
 * breaks it": the comment in `host/git/git-port.ts` explaining why `-w` is
 * absent would itself match the pattern for a `-w` write. A quote-aware scan is
 * used rather than a regex so that a `//` inside a string literal — a URL, most
 * often — is not mistaken for the start of a comment.
 */
const withoutComments = (text: string): string => {
  let out = ''
  let index = 0
  let quote: string | undefined
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (quote !== undefined) {
      out += char
      if (char === '\\') {
        out += next ?? ''
        index += 2
        continue
      }
      if (char === quote) quote = undefined
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    out += char
    index += 1
  }
  return out
}

const matching = (files: readonly SourceFile[], pattern: RegExp): readonly string[] =>
  files.filter(file => pattern.test(withoutComments(file.text))).map(file => file.path)

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

  it('keeps the diff renderer pure and the diff reader behind the ports', async () => {
    const files = await sources()
    // The renderer has no runtime dependency at all: its only imports are
    // type-only, which the compiler erases. It is a function from two line lists
    // to hunks, which is why every case about how a change is shown can be
    // tested without a repository, a store, or a file on disk.
    const renderer = files.find(file => file.path === 'host/diff/unified.ts')
    const imports = renderer?.text.match(/^import\b.*$/gm) ?? []
    expect(imports.filter(line => !line.startsWith('import type'))).toEqual([])
    // The reader assembles bytes that were already recorded, so it opens no file
    // and runs no process of its own. Reading the worktree again would show the
    // user bytes the turn did not produce — the file may have been edited since,
    // which is what `S005` is about.
    expect(
      files
        .filter(file => file.path.startsWith('host/diff/'))
        .filter(file => /node:fs|node:child_process|execFile/.test(file.text)),
    ).toEqual([])
  })
})
