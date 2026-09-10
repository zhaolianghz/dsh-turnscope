import type { TurnscopeConfig } from '../../config.ts';
/** Subdirectory of a resolved root that holds the content-addressed objects. */
export declare const OBJECTS_DIRNAME = "objects";
/** The subset of the process environment that root resolution consults. */
export interface StorageEnv {
    readonly DSH_HOME?: string | undefined;
}
/**
 * Decide where Turnscope keeps its private data.
 *
 * Precedence is explicit `config.dataDir`, then `<DSH_HOME>/turnscope`, then
 * `<homeDir>/.dsh/turnscope`. `process.cwd()` is deliberately never consulted:
 * a cwd fallback would give every project the user opens its own store, so the
 * index would silently fragment and retention would never see the whole set.
 * The result is always absolute, so callers can open it without further
 * resolution.
 *
 * Every arm is guarded to keep that promise. `dataDir` and `DSH_HOME` are
 * accepted only when absolute, and `homeDir` is required to be absolute —
 * `resolve` would quietly start from the cwd for a relative or empty first
 * segment, which is the one path by which the cwd could reach the result. A bad
 * `homeDir` is therefore a caller bug, and failing loudly beats scattering the
 * store; the call site wraps this in its fail-open boundary, so the outcome is
 * a disabled recorder rather than data written to the wrong place.
 */
export declare function resolveDataRoot(config: TurnscopeConfig, env: StorageEnv, homeDir: string): string;
/** The object store directory beneath a resolved data root. */
export declare function resolveObjectsDir(dataRoot: string): string;
//# sourceMappingURL=paths.d.ts.map