import type { SafetyRule } from './types.ts';
/** `S001` — with no starting state there is nothing to restore or compare. */
export declare const s001PreCheckpointMissing: SafetyRule;
/** `S002` — an end state is needed to know what the turn actually produced. */
export declare const s002PostCheckpointMissing: SafetyRule;
/**
 * `S003` — the workspace changed identity underneath the turn.
 *
 * The workspace id is derived from the repository's remote and its git common
 * directory (`docs/ARCHITECTURE.md §11.2`), so two different ids mean these facts
 * are about different repositories or different clones.
 */
export declare const s003RepositoryChanged: SafetyRule;
/**
 * `S004` — HEAD moved after the turn.
 *
 * A rewind assumes the recorded end state is still where history sits. When HEAD
 * has moved, the bytes may still be restorable but the turn's place in history
 * is gone, which is what a fork exists for.
 */
export declare const s004HeadDrift: SafetyRule;
/**
 * `S005` — a file the turn changed has been changed again since.
 *
 * This is the rule the whole product is arranged around. If the user edited a
 * file after the turn, restoring the turn's before-state would silently discard
 * their work, and there is no version of that which is acceptable.
 */
export declare const s005TargetFileDrift: SafetyRule;
/**
 * `S006` — the change set contains something we could not attribute.
 *
 * Rewinding a file we cannot attribute risks reverting the user's own work, so
 * an uncertain path is enough on its own to withdraw the in-place option.
 */
export declare const s006UncertainAttribution: SafetyRule;
/** `S007` — a merge, rebase, or cherry-pick is in progress. */
export declare const s007GitOperationInProgress: SafetyRule;
/** `S008` — the reverse patch does not apply cleanly. */
export declare const s008ReversePatchConflict: SafetyRule;
/**
 * `S009` — the workspace is not a Git repository.
 *
 * Distinguished from S001/S002 because "we looked and there is no repository" is
 * a different fact from "we never looked", and only the second one is a bug.
 */
export declare const s009NonGitWorkspace: SafetyRule;
/**
 * `S010` — evidence is missing.
 *
 * Split by consequence: a checkpoint that *failed* leaves a hole big enough that
 * the safe answer is to withdraw the in-place option entirely, while a
 * checkpoint that was merely unable to read some paths is worth a warning. The
 * distinction is the one `docs/PRD.md §19` cares about — a partial observation is
 * not the same as a wrong one, but it is not the same as a complete one either.
 */
export declare const s010EvidenceIncomplete: SafetyRule;
/**
 * `S011` — a binary file changed and there is no before copy to put back.
 *
 * A binary has no textual delta to reason about, so the only question is whether
 * the bytes needed to undo the change were kept. When they were, the change is
 * judged like any other; when they were not, the turn is forked rather than
 * rewound.
 */
export declare const s011BinaryChange: SafetyRule;
/**
 * `S012` — the turn reached outside the repository.
 *
 * Deliberately a warning and not a refusal: files can be rewound and a deploy
 * cannot be un-deployed, so the honest move is to say so rather than to imply
 * that the button covers more than it does.
 */
export declare const s012ExternalSideEffect: SafetyRule;
/** Every P0 rule, in the order `docs/ARCHITECTURE.md §14.1` lists them. */
export declare const SAFETY_RULES: readonly SafetyRule[];
//# sourceMappingURL=rules.d.ts.map