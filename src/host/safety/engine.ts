/**
 * Turning reasons into a verdict (`docs/ARCHITECTURE.md §15`).
 *
 * The level is the worst reason, but the *actions* are not derived from it. That
 * is the point `§15` is making: `FORK_ONLY` and `UNPROTECTED` are not two points
 * on one danger scale — the first has a usable historical baseline and the second
 * may not have a usable starting point at all — so collapsing them into "worse"
 * and then mapping "worse" to "fewer buttons" would get both wrong. A turn can be
 * `UNPROTECTED` and still offer a fork, and it can be `FORK_ONLY` and offer
 * nothing but a fork.
 *
 * `docs/PRD.md §FR-11` adds the rule the UI must not break: an action is either
 * offered or it is not. No button that only explains its own danger after it is
 * pressed.
 */
import { safetyVerdictIdFor } from '../domain/ids.ts'
import { SCHEMA_VERSION } from '../domain/types.ts'
import type { RecoveryAction, SafetyLevel, SafetyReason, SafetyVerdict } from '../domain/types.ts'
import type { SafetyEvaluation, SafetyInput, SafetyRule } from './types.ts'
import { SAFETY_ENGINE_VERSION, SEVERITY_ORDER } from './types.ts'
import { SAFETY_RULES } from './rules.ts'

/**
 * Evaluate a turn.
 *
 * Pure, and injectable: `rules` exists so a test can ask "what does the
 * aggregation do with these three reasons" without arranging a repository to
 * produce them, and so a future rule set can be compared against this one.
 */
export function evaluateSafety(
  input: SafetyInput,
  rules: readonly SafetyRule[] = SAFETY_RULES,
): SafetyEvaluation {
  const reasons = rules.flatMap(rule => rule.evaluate(input))
  const level = highestSeverity(reasons)
  const allowedActions = allowedActionsFor(level, input)
  return {
    level,
    reasons,
    allowedActions,
    recommendedAction: recommendedFor(level, allowedActions),
    engineVersion: SAFETY_ENGINE_VERSION,
    currentStateHash: currentStateHash(input),
  }
}

/** The persisted form, once the caller is ready to store it. */
export function toSafetyVerdict(input: SafetyInput, evaluation: SafetyEvaluation): SafetyVerdict {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: safetyVerdictIdFor(input.turn.id),
    turnId: input.turn.id,
    level: evaluation.level,
    reasons: evaluation.reasons,
    allowedActions: evaluation.allowedActions,
    recommendedAction: evaluation.recommendedAction,
    evaluatedAt: input.now,
    engineVersion: evaluation.engineVersion,
    ...(evaluation.currentStateHash === undefined
      ? {}
      : { currentStateHash: evaluation.currentStateHash }),
  }
}

/** The worst severity among the reasons; `SAFE` when there are none. */
export function highestSeverity(reasons: readonly SafetyReason[]): SafetyLevel {
  let worst: SafetyLevel = 'SAFE'
  for (const reason of reasons) {
    if (rank(reason.severity) > rank(worst)) worst = reason.severity
  }
  return worst
}

/** Whether `level` is at least as severe as `floor`, by the §15 order. */
export function severityAtLeast(level: SafetyLevel, floor: SafetyLevel): boolean {
  return rank(level) >= rank(floor)
}

function rank(level: SafetyLevel): number {
  return SEVERITY_ORDER.indexOf(level)
}

/**
 * What the UI may offer.
 *
 * A fork is gated on the starting state actually being restorable rather than on
 * the level, because the level describes how much we know and `restorable`
 * describes whether the bytes exist — two different questions that S011 and
 * friends answer separately.
 */
function allowedActionsFor(level: SafetyLevel, input: SafetyInput): readonly RecoveryAction[] {
  const canFork = input.pre !== undefined && input.pre.record.restorable
  const canPreview = input.pre !== undefined && input.post !== undefined
  const fork = canFork ? (['FORK'] as const) : []

  switch (level) {
    case 'SAFE':
      return canPreview
        ? ['INSPECT', 'PREVIEW_REWIND', 'REWIND', 'FORK']
        : ['INSPECT', ...fork]
    case 'CAUTION':
      // Rewind is deliberately absent: caution means preview and decide, and a
      // button that writes before the user has looked is exactly what §FR-11
      // forbids.
      return canPreview ? ['INSPECT', 'PREVIEW_REWIND', ...fork] : ['INSPECT', ...fork]
    case 'FORK_ONLY':
      return ['INSPECT', ...fork]
    case 'UNPROTECTED':
      return ['INSPECT', ...fork]
  }
}

function recommendedFor(
  level: SafetyLevel,
  allowedActions: readonly RecoveryAction[],
): RecoveryAction {
  switch (level) {
    case 'SAFE':
      return allowedActions.includes('REWIND') ? 'REWIND' : 'INSPECT'
    case 'CAUTION':
      return allowedActions.includes('PREVIEW_REWIND') ? 'PREVIEW_REWIND' : 'INSPECT'
    case 'FORK_ONLY':
    case 'UNPROTECTED':
      return allowedActions.includes('FORK') ? 'FORK' : 'INSPECT'
  }
}

/**
 * A fingerprint of the workspace the verdict was computed against.
 *
 * Stored so a confirmation given before the workspace moved can be refused
 * afterwards: a preview the user approved is only valid for the state it
 * described, and re-checking this is cheaper and more honest than re-deriving
 * the whole verdict.
 */
function currentStateHash(input: SafetyInput): string | undefined {
  const current = input.current?.record
  return current?.worktreeDigest ?? current?.headOid
}
