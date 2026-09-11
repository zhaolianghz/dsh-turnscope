import type { GitPort } from './git-port.ts';
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
    readonly repoRoot: string;
    /** Symlink-resolved git common directory, shared by every worktree. */
    readonly commonDir: string;
    /** The normalized `origin` URL, when there is one. */
    readonly remote: string | undefined;
    /** `sha256:<hex>` over the remote and the common directory. */
    readonly rootIdentity: string;
}
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
export declare function canonicalizeRemote(raw: string): string;
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
export declare function resolveRepositoryIdentity(git: GitPort, cwd: string): Promise<RepositoryIdentity | undefined>;
//# sourceMappingURL=identity.d.ts.map