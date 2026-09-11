/**
 * How long ago a verdict was computed.
 *
 * Coarse on purpose. `docs/ARCHITECTURE.md §16` wants the panel to show
 * "evaluated Xs ago", and the *point* of that number is to say whether the verdict
 * is worth believing right now — a judgement from four seconds ago and one from
 * forty are the same answer to that question. A precise counter would invite
 * reading it as a measurement, and a ticking one would need a timer in a component
 * that otherwise has no reason to re-render.
 *
 * `now` is a parameter for the same reason the safety engine takes one: a render
 * that reads the clock is a function of something its caller cannot control, and
 * the rule here is that the same inputs produce the same output.
 */
export type AgeUnit = 'now' | 'seconds' | 'minutes' | 'hours' | 'days'

export interface Age {
  readonly unit: AgeUnit
  readonly count: number
}

/** Under this, "now" — a verdict computed in the last few seconds has no age to report. */
const JUST_NOW_MS = 10_000

export function ageOf(evaluatedAt: number, now: number): Age {
  // A verdict timestamped in the future is a clock disagreement, not a fact about
  // the verdict; clamping keeps it from rendering as "-3 seconds ago".
  const elapsed = Math.max(0, now - evaluatedAt)
  if (elapsed < JUST_NOW_MS) return { unit: 'now', count: 0 }
  const seconds = Math.floor(elapsed / 1000)
  if (seconds < 60) return { unit: 'seconds', count: seconds }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return { unit: 'minutes', count: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { unit: 'hours', count: hours }
  return { unit: 'days', count: Math.floor(hours / 24) }
}
