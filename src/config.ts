import { isAbsolute } from 'node:path'

/** Fully resolved host configuration; every field is present and valid. */
export interface TurnscopeConfig {
  readonly enabled: boolean
  readonly dataDir: string | undefined
  readonly retentionDays: number
  readonly retentionBytes: number
  readonly maxOutputBytes: number
  readonly ignorePaths: readonly string[]
}

/** Documented defaults, used for absent input and for every invalid field. */
export const DEFAULT_CONFIG: TurnscopeConfig = Object.freeze({
  enabled: true,
  dataDir: undefined,
  retentionDays: 30,
  retentionBytes: 104_857_600,
  maxOutputBytes: 32_768,
  ignorePaths: Object.freeze([]),
})

/**
 * Read one field without ever propagating a throw. Host plugins are loaded with
 * arbitrary user configuration, which may be an exotic object with an accessor
 * that throws. `resolveConfig` is called outside the `apply` fail-open boundary,
 * so totality has to be enforced here.
 */
const read = (source: Record<string, unknown>, key: string): unknown => {
  try {
    return source[key]
  } catch {
    return undefined
  }
}

/** `Array.isArray` itself throws on a revoked proxy, so it is guarded too. */
const isArray = (value: unknown): value is unknown[] => {
  try {
    return Array.isArray(value)
  } catch {
    return false
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !isArray(value)

const isStringArray = (value: unknown): value is readonly string[] =>
  isArray(value) && value.every((item: unknown) => typeof item === 'string')

const readBoolean = (
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean => {
  const value = read(source, key)
  return typeof value === 'boolean' ? value : fallback
}

const readPositiveInteger = (
  source: Record<string, unknown>,
  key: string,
  fallback: number,
): number => {
  const value = read(source, key)
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

const readAbsolutePath = (
  source: Record<string, unknown>,
  key: string,
  fallback: string | undefined,
): string | undefined => {
  const value = read(source, key)
  return typeof value === 'string' && isAbsolute(value) ? value : fallback
}

const readStringArray = (
  source: Record<string, unknown>,
  key: string,
  fallback: readonly string[],
): readonly string[] => {
  const value = read(source, key)
  return isStringArray(value) ? Object.freeze([...value]) : fallback
}

/**
 * Turn arbitrary loader-supplied configuration into a valid {@link TurnscopeConfig}.
 *
 * Total by construction: unknown input and invalid fields fall back to their
 * default individually, so one bad field never discards the valid ones.
 */
export function resolveConfig(input: unknown): TurnscopeConfig {
  const source = isRecord(input) ? input : {}
  return Object.freeze({
    enabled: readBoolean(source, 'enabled', DEFAULT_CONFIG.enabled),
    dataDir: readAbsolutePath(source, 'dataDir', DEFAULT_CONFIG.dataDir),
    retentionDays: readPositiveInteger(source, 'retentionDays', DEFAULT_CONFIG.retentionDays),
    retentionBytes: readPositiveInteger(source, 'retentionBytes', DEFAULT_CONFIG.retentionBytes),
    maxOutputBytes: readPositiveInteger(source, 'maxOutputBytes', DEFAULT_CONFIG.maxOutputBytes),
    ignorePaths: readStringArray(source, 'ignorePaths', DEFAULT_CONFIG.ignorePaths),
  })
}
