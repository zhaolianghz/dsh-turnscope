import { isAbsolute, join, resolve } from 'node:path'
import type { TurnscopeConfig } from '../../config.ts'

/** Subdirectory of a resolved root that holds the content-addressed objects. */
export const OBJECTS_DIRNAME = 'objects'

/** The subset of the process environment that root resolution consults. */
export interface StorageEnv {
  readonly DSH_HOME?: string | undefined
}

/** The plugin's directory name under whichever base applies. */
const PLUGIN_DIRNAME = 'turnscope'

/**
 * Base directory for a user-wide DSH install, mirroring DSH's own convention.
 */
const HOME_DIRNAME = '.dsh'

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
export function resolveDataRoot(
  config: TurnscopeConfig,
  env: StorageEnv,
  homeDir: string,
): string {
  const dataDir = config.dataDir
  if (typeof dataDir === 'string' && isAbsolute(dataDir)) return dataDir

  const dshHome = env.DSH_HOME
  if (typeof dshHome === 'string' && dshHome.length > 0 && isAbsolute(dshHome)) {
    return join(dshHome, PLUGIN_DIRNAME)
  }

  // A relative (or empty) homeDir would make `resolve` start from the cwd,
  // which is the one thing this function is not allowed to do. Both a caller
  // passing a relative path and a caller passing an unset HOME land here, and
  // neither may silently produce a store under the user's current project.
  if (!isAbsolute(homeDir)) {
    throw new Error(`homeDir must be absolute, got ${JSON.stringify(homeDir)}`)
  }
  return resolve(homeDir, HOME_DIRNAME, PLUGIN_DIRNAME)
}

/** The object store directory beneath a resolved data root. */
export function resolveObjectsDir(dataRoot: string): string {
  return join(dataRoot, OBJECTS_DIRNAME)
}
