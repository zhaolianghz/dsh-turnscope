import type { PathStatus } from '../domain/types.ts';
import type { CommandRunner } from './command-runner.ts';
/**
 * One changed path as `git status --porcelain=v2 -z` reports it.
 *
 * The upstream field names are kept (`mW` is the worktree mode, `hH`/`hI` are
 * the HEAD and index blob ids) because they are what a reader will look up in
 * the format documentation, and renaming them would hide which upstream column
 * each value actually came from.
 */
export interface GitStatusEntry {
    /** Repo-relative, forward-slashed; never quoted, because `-z` is used. */
    readonly path: string;
    /** Where a rename came from; only present when `status` is `renamed`. */
    readonly previousPath?: string;
    readonly status: PathStatus;
    /** True when the index differs from `HEAD`, not when the worktree does. */
    readonly staged: boolean;
    /** True for an unmerged entry, which `pathStatus` reports as `modified`. */
    readonly unmerged: boolean;
    /** Worktree mode, e.g. `100644`; absent when the worktree has no file. */
    readonly mode?: string;
    /** HEAD blob id, when the path is tracked. */
    readonly headOid?: string;
    /** Index blob id, when the path is staged. */
    readonly indexOid?: string;
}
/** `HEAD`, and the branch it is on when it is not detached. */
export interface GitHead {
    readonly oid: string;
    readonly branch?: string;
}
/**
 * The only way this plugin reaches Git.
 *
 * Every method names a read operation, and `runGit` refuses a subcommand that
 * is not on {@link ALLOWED_SUBCOMMANDS}. That runtime set is the enforcement of
 * `docs/ARCHITECTURE.md §11.3`: the source-level guard in
 * `tests/host/architecture.spec.ts` pins what the code *says*, and this pins
 * what it can *do*, so a future call site cannot reach a write by assembling an
 * argv the guard's regular expressions did not anticipate.
 *
 * A method returns `undefined` for any non-zero exit rather than a partial
 * value. Git's failure modes are mostly "this question does not apply here" —
 * no commits, no remote, not a repository — and a half-parsed answer to those
 * would be worse than no answer, because the caller stores it.
 */
export interface GitPort {
    /** Whether `cwd` is inside a work tree. */
    isRepository(cwd: string): Promise<boolean>;
    /** Absolute, symlink-resolved worktree root. */
    toplevel(cwd: string): Promise<string | undefined>;
    /** Absolute, symlink-resolved git common directory (shared across worktrees). */
    commonDir(cwd: string): Promise<string | undefined>;
    /** The `origin` URL, verbatim, or `undefined` when there is no remote. */
    canonicalRemote(cwd: string): Promise<string | undefined>;
    /** The current commit and branch, or `undefined` in a repository with no commit. */
    head(cwd: string): Promise<GitHead | undefined>;
    /** Every changed path, or `undefined` when `git status` could not answer. */
    status(cwd: string): Promise<readonly GitStatusEntry[] | undefined>;
    /** The blob id of a worktree file, computed without writing an object. */
    hashObject(cwd: string, path: string): Promise<string | undefined>;
    /** The bytes of a stored blob. */
    blob(cwd: string, oid: string): Promise<Uint8Array | undefined>;
    /** Resolve a git path such as `MERGE_HEAD`, for in-progress-state detection. */
    gitPath(cwd: string, name: string): Promise<string | undefined>;
}
/**
 * Parse NUL-separated porcelain-v2 output.
 *
 * `-z` is required rather than convenient: the default format quotes a path
 * containing a space or a non-ASCII byte and escapes it C-style, and decoding
 * that back is a recurring source of bugs. With `-z` the path is literal and the
 * only separator is the byte that cannot appear in one.
 *
 * A rename is the reason this is a loop with an index rather than a `map`: type
 * `2` records carry the original path as the *next* NUL-separated field.
 */
export declare function parseStatusPorcelainV2(input: Uint8Array): readonly GitStatusEntry[];
/**
 * Build a {@link GitPort} over an injected runner.
 *
 * The runner is a parameter so tests can drive the port through a recording
 * double, and so there is exactly one place — {@link createExecFileRunner} in
 * the production wiring — where a real process is spawned.
 */
export declare function createGitPort(runner: CommandRunner): GitPort;
//# sourceMappingURL=git-port.d.ts.map