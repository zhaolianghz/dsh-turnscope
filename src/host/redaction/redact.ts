import { markerFor, SECRET_PATTERNS } from './patterns.ts'

/** Outcome of one redaction pass. */
export interface RedactResult {
  /** Input with every recognized secret replaced by a `[REDACTED:<kind>]` marker. */
  readonly text: string
  /** Distinct kinds that fired, sorted. Empty when nothing matched. */
  readonly masked: readonly string[]
}

/**
 * Replace every recognized secret in `input` with a marker.
 *
 * Pure, synchronous and total: no I/O, no clock, no randomness, and no input it
 * throws on — it runs inside the persistence write path, where a partial
 * failure would be worse than the redaction itself.
 *
 * Patterns are applied in `SECRET_PATTERNS` order over the text produced so far,
 * each with `lastIndex` reset, so the result depends only on the input and not
 * on how many times, or in what order, `redact` has been called before.
 *
 * Idempotent: `redact(redact(x).text).text === redact(x).text`, because no
 * pattern can match a marker (see the assignment guard in `patterns.ts`).
 */
export function redact(input: string): RedactResult {
  let text = input
  const fired = new Set<string>()
  for (const { kind, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    const replaced = text.replace(pattern, () => markerFor(kind))
    if (replaced !== text) {
      fired.add(kind)
      text = replaced
    }
  }
  return Object.freeze({ text, masked: Object.freeze([...fired].sort()) })
}

/**
 * Apply {@link redact} to every string in a JSON-shaped value.
 *
 * Containers are copied, never mutated: numbers, booleans, `null` and
 * `undefined` are returned as they are, so a caller can hand this a decoded
 * payload and store the result without a second look.
 */
export function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redact(value).text
  if (Array.isArray(value)) return value.map((item: unknown) => redactDeep(item))
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(source)) output[key] = redactDeep(source[key])
    return output
  }
  return value
}
