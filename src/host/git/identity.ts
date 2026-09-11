import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { GitPort } from './git-port.ts'

/**
 * What identifies one repository across how a user happens to reach it.
 *
 * `repoRoot` is kept for display — the operator-facing features need a path a
 * human recognises — but it is **not** the key. `docs/ARCHITECTURE.md §11.2` is
 * explicit about why: the same repository reached through a symlink, a linked
 * worktree, or a different `cwd` must not become three workspaces in the index,
 * or retention and history would each only ever see a third of the truth.
 */
export interface RepositoryIdentity {
  /** Symlink-resolved worktree root. */
  readonly repoRoot: string
  /** Symlink-resolved git common directory, shared by every worktree. */
  readonly commonDir: string
  /** The normalized `origin` URL, when there is one. */
  readonly remote: string | undefined
  /** `sha256:<hex>` over the remote and the common directory. */
  readonly rootIdentity: string
}

/**
 * `sha256:` + hex for a UTF-8 string. The prefix makes the value recognisable
 * as a digest, so it cannot be mistaken for the path it was derived from.
 */
const digest = (value: string): string =>
  `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`

/**
 * Strip the parts of a remote URL that vary without meaning anything.
 *
 * A trailing slash and a trailing `.git` are the two spellings of the same
 * repository that Git itself writes in different situations, so leaving them in
 * would make `git@host:org/repo.git` and `git@host:org/repo` two workspaces.
 * Nothing else is normalized: lower-casing the whole URL would break a
 * case-sensitive server, and rewriting a relative remote would guess at a base
 * this plugin does not have.
 */
export function canonicalizeRemote(raw: string): string {
  let value = raw.trim()
  if (value.endsWith('/')) value = value.slice(0, -1)
  if (value.endsWith('.git')) value = value.slice(0, -4)
  return value
}

/** `realpath` the path when it exists, and fall back to `resolve` when it does not. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Derive a repository's identity, or `undefined` when there is no repository.
 *
 * The identity is `sha256((canonicalRemote ?? '') + '\0' + commonDir)`. The NUL
 * separator is what keeps the two halves from running together: without it, a
 * remote ending in the first character of a directory could collide with a
 * different pair. `docs/ARCHITECTURE.md §11.2` writes the same formula, though
 * its TypeScript sketch omits the parentheses the intent needs — `a ?? b + c`
 * binds as `a ?? (b + c)`, which is not the formula it describes.
 *
 * With no remote the first half is empty and the common directory alone keys the
 * repository, which is the best available answer for a local-only repository and
 * is stable across every worktree of it.
 */
export async function resolveRepositoryIdentity(
  git: GitPort,
  cwd: string,
): Promise<RepositoryIdentity | undefined> {
  if (!(await git.isRepository(cwd))) return undefined

  const toplevel = await git.toplevel(cwd)
  const commonDir = await git.commonDir(cwd)
  if (toplevel === undefined || commonDir === undefined) return undefined

  const canonicalCommonDir = await canonicalPath(commonDir)
  const remote = await git.canonicalRemote(cwd)
  const canonicalRemote = remote === undefined ? undefined : canonicalizeRemote(remote)

  return {
    repoRoot: await canonicalPath(toplevel),
    commonDir: canonicalCommonDir,
    remote: canonicalRemote,
    rootIdentity: digest(`${canonicalRemote ?? ''}\0${canonicalCommonDir}`),
  }
}
