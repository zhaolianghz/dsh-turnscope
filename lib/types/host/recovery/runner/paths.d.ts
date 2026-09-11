/**
 * Path layout under the Turnscope data root for V0.2 recovery state.
 *
 * Per `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §5.3`:
 *
 * - **Dry-run staging** lives at `<dataRoot>/recovery/dryrun/<planId>/`, a
 *   per-plan scratch directory the runner writes to during a dry-run preview.
 *   It is intentionally *not* a git worktree: git metadata is irrelevant to
 *   the runner (it never calls git apply, never calls git checkout), and
 *   building a worktree just to stage files in it is the slowest possible way
 *   to do what `fs.rename` already does correctly.
 * - **Apply journal files** live at `<dataRoot>/recovery/journal/<planId>.jsonl`,
 *   one JSONL file per apply. The journal is the only thing that lets the
 *   host detect a half-finished apply on next boot, so it has to be readable
 *   without first opening the SQLite index.
 *
 * Every path under this module is derived from a single absolute data root;
 * the resolver refuses a relative one for the same reason
 * `storage/paths.ts` does — a relative path would let `process.cwd()` leak
 * into the layout, and the recovery state would silently fragment across
 * working directories.
 */
/** Subdirectory of the data root that holds V0.2 recovery state. */
export declare const RECOVERY_DIRNAME = "recovery";
/** Subdirectory that holds one scratch directory per dry-run preview. */
export declare const DRYRUN_DIRNAME = "dryrun";
/** Subdirectory that holds one JSONL journal per apply. */
export declare const JOURNAL_DIRNAME = "journal";
export interface RecoveryPathsEnv {
    readonly DSH_HOME?: string | undefined;
}
/**
 * Resolve the data root for a Turnscope installation.
 *
 * Mirrors `resolveDataRoot` in `storage/paths.ts`: prefer an explicit absolute
 * `dataDir`, then `$DSH_HOME/turnscope`, then `<homeDir>/.dsh/turnscope`. The
 * copy is deliberate — the runner must agree with the index on where the
 * root lives, and agreement here means using the same rule.
 */
export declare function resolveRecoveryDataRoot(env: RecoveryPathsEnv, homeDir: string, configDataDir: string | undefined): string;
/** The recovery root under the Turnscope data root. */
export declare function resolveRecoveryRoot(dataRoot: string): string;
/** A dry-run staging directory for one plan, rooted at the recovery root. */
export declare function resolveDryRunRoot(recoveryRoot: string, planId: string): string;
/** The journal file for one plan, rooted at the recovery root. */
export declare function resolveJournalPath(recoveryRoot: string, planId: string): string;
//# sourceMappingURL=paths.d.ts.map