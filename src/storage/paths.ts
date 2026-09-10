import { isAbsolute, join, resolve } from 'node:path'
import type { TurnscopeConfig } from '../config.ts'

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

  // `resolve` (not `join`) so a relative `homeDir` still yields an absolute
  // path; an absolute first segment makes it independent of the cwd.
  return resolve(homeDir, HOME_DIRNAME, PLUGIN_DIRNAME)
}

/** The object store directory beneath a resolved data root. */
export function resolveObjectsDir(dataRoot: string): string {
  return join(dataRoot, OBJECTS_DIRNAME)
}
