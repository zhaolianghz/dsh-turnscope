import type { SafetyLevel, SafetyReason, SafetyVerdict } from '../domain/types.ts';
import type { SafetyEvaluation, SafetyInput, SafetyRule } from './types.ts';
/**
 * Evaluate a turn.
 *
 * Pure, and injectable: `rules` exists so a test can ask "what does the
 * aggregation do with these three reasons" without arranging a repository to
 * produce them, and so a future rule set can be compared against this one.
 */
export declare function evaluateSafety(input: SafetyInput, rules?: readonly SafetyRule[]): SafetyEvaluation;
/** The persisted form, once the caller is ready to store it. */
export declare function toSafetyVerdict(input: SafetyInput, evaluation: SafetyEvaluation): SafetyVerdict;
/** The worst severity among the reasons; `SAFE` when there are none. */
export declare function highestSeverity(reasons: readonly SafetyReason[]): SafetyLevel;
/** Whether `level` is at least as severe as `floor`, by the §15 order. */
export declare function severityAtLeast(level: SafetyLevel, floor: SafetyLevel): boolean;
//# sourceMappingURL=engine.d.ts.map