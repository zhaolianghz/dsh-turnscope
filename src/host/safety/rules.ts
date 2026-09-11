/**
 * The P0 rules of `docs/ARCHITECTURE.md §14.1`.
 *
 * Each rule is a function from evidence to reasons, with no knowledge of the
 * others. The verdict is the worst reason found, so a rule that is unsure should
 * fire rather than stay silent: a missing warning is a promise the product
 * cannot keep, while an extra warning is a sentence the user can read and
 * disagree with.
 *
 * The wording of `detail` is part of the contract. `docs/PRD.md §14.2` bans
 * hedging — there is no "probably safe" here — and `§14.4` bans leaning on
 * colour, so every reason has to be legible as a sentence on its own.
 */
import { CHECKPOINT_FAILURE } from '../git/checkpoint.ts'
import type { FileChange, SafetyReason, SafetyLevel } from '../domain/types.ts'
import type { ObservedCheckpoint } from '../attribution/types.ts'
import type { SafetyInput, SafetyRule } from './types.ts'

/** Build a reason, omitting `path` rather than storing an explicit `undefined`. */
function reason(
  code: string,
  severity: SafetyLevel,
  title: string,
  detail: string,
  extra: { path?: string; evidenceRefs?: readonly string[] } = {},
): SafetyReason {
  return {
    code,
    severity,
    title,
    detail,
    evidenceRefs: extra.evidenceRefs ?? [],
    ...(extra.path === undefined ? {} : { path: extra.path }),
  }
}

/** `S001` — with no starting state there is nothing to restore or compare. */
export const s001PreCheckpointMissing: SafetyRule = {
  id: 'S001_PRE_CHECKPOINT_MISSING',
  evaluate: ({ pre, turn }) =>
    pre !== undefined
      ? []
      : [
          reason(
            'S001_PRE_CHECKPOINT_MISSING',
            'UNPROTECTED',
            'No checkpoint was taken before the turn',
            'The turn has no recorded starting state, so there is nothing to restore and nothing to compare the result against.',
            { evidenceRefs: [turn.id] },
          ),
        ],
}

/** `S002` — an end state is needed to know what the turn actually produced. */
export const s002PostCheckpointMissing: SafetyRule = {
  id: 'S002_POST_CHECKPOINT_MISSING',
  evaluate: ({ post, turn }) =>
    post !== undefined
      ? []
      : [
          reason(
            'S002_POST_CHECKPOINT_MISSING',
            'UNPROTECTED',
            'No checkpoint was taken after the turn',
            'The turn has no recorded end state, so the changes it produced cannot be identified.',
            { evidenceRefs: [turn.id] },
          ),
        ],
}

/**
 * `S003` — the workspace changed identity underneath the turn.
 *
 * The workspace id is derived from the repository's remote and its git common
 * directory (`docs/ARCHITECTURE.md §11.2`), so two different ids mean these facts
 * are about different repositories or different clones.
 */
export const s003RepositoryChanged: SafetyRule = {
  id: 'S003_REPOSITORY_CHANGED',
  evaluate: ({ pre, current }) => {
    if (pre === undefined || current === undefined) return []
    if (pre.record.workspaceId === current.record.workspaceId) return []
    return [
      reason(
        'S003_REPOSITORY_CHANGED',
        'UNPROTECTED',
        'The workspace is no longer the same repository',
        'The recorded state and the current state belong to different repositories, so they cannot be compared.',
        { evidenceRefs: [pre.record.id, current.record.id] },
      ),
    ]
  },
}

/**
 * `S004` — HEAD moved after the turn.
 *
 * A rewind assumes the recorded end state is still where history sits. When HEAD
 * has moved, the bytes may still be restorable but the turn's place in history
 * is gone, which is what a fork exists for.
 */
export const s004HeadDrift: SafetyRule = {
  id: 'S004_HEAD_DRIFT',
  evaluate: ({ post, current }) => {
    if (post === undefined || current === undefined) return []
    const recorded = post.record.headOid
    const live = current.record.headOid
    // Two unreadable HEADs say nothing; a non-git workspace is S009's business.
    if (recorded === undefined && live === undefined) return []
    if (recorded === live) return []
    return [
      reason(
        'S004_HEAD_DRIFT',
        'FORK_ONLY',
        'HEAD moved after the turn',
        `The turn ended at ${short(recorded)} but the repository is now at ${short(live)}, so an in-place rewind no longer has a history to return to.`,
        { evidenceRefs: [post.record.id, current.record.id] },
      ),
    ]
  },
}

/**
 * `S005` — a file the turn changed has been changed again since.
 *
 * This is the rule the whole product is arranged around. If the user edited a
 * file after the turn, restoring the turn's before-state would silently discard
 * their work, and there is no version of that which is acceptable.
 */
export const s005TargetFileDrift: SafetyRule = {
  id: 'S005_TARGET_FILE_DRIFT',
  evaluate: ({ changeSet }) => {
    const drifted = (changeSet?.changes ?? []).filter(change => change.attribution === 'DRIFT')
    return drifted.map(change =>
      reason(
        'S005_TARGET_FILE_DRIFT',
        'FORK_ONLY',
        'A changed file was edited again after the turn',
        `${change.path} changed after the recorded turn, so restoring the turn would discard changes made since.`,
        { path: change.path, evidenceRefs: change.evidenceRefs },
      ),
    )
  },
}

/**
 * `S006` — the change set contains something we could not attribute.
 *
 * Rewinding a file we cannot attribute risks reverting the user's own work, so
 * an uncertain path is enough on its own to withdraw the in-place option.
 */
export const s006UncertainAttribution: SafetyRule = {
  id: 'S006_UNCERTAIN_ATTRIBUTION',
  evaluate: ({ changeSet }) => {
    const uncertain = (changeSet?.changes ?? []).filter(change => change.attribution === 'UNCERTAIN')
    return uncertain.map(change =>
      reason(
        'S006_UNCERTAIN_ATTRIBUTION',
        'FORK_ONLY',
        'A change could not be attributed with confidence',
        `${change.path} could not be reliably attributed to this turn, so restoring it might revert work that was never the turn's.`,
        { path: change.path, evidenceRefs: change.evidenceRefs },
      ),
    )
  },
}

/** `S007` — a merge, rebase, or cherry-pick is in progress. */
export const s007GitOperationInProgress: SafetyRule = {
  id: 'S007_GIT_OPERATION_IN_PROGRESS',
  evaluate: ({ post, current }) => {
    const found: string[] = []
    const refs: string[] = []
    for (const [label, checkpoint] of [
      ['now', current],
      ['when the turn ended', post],
    ] as const) {
      if (checkpoint === undefined) continue
      const operations = operationsInProgress(checkpoint)
      if (operations.length === 0) continue
      found.push(`${operations.join(' and ')} ${label}`)
      refs.push(checkpoint.record.id)
    }
    if (found.length === 0) return []
    return [
      reason(
        'S007_GIT_OPERATION_IN_PROGRESS',
        'FORK_ONLY',
        'A Git operation is in progress',
        `${joinSentences(found)}, so the working tree is mid-operation and restoring files in place would leave it in a state Git cannot resolve.`,
        { evidenceRefs: refs },
      ),
    ]
  },
}

/** `S008` — the reverse patch does not apply cleanly. */
export const s008ReversePatchConflict: SafetyRule = {
  id: 'S008_REVERSE_PATCH_CONFLICT',
  evaluate: ({ reversePatchCheck }) => {
    if (reversePatchCheck === undefined || reversePatchCheck.clean) return []
    const paths = reversePatchCheck.conflicts
    const detail =
      paths.length === 0
        ? 'The changes could not be reversed cleanly, so an in-place rewind would not reproduce the recorded start state.'
        : `The changes to ${paths.join(', ')} could not be reversed cleanly, so an in-place rewind would not reproduce the recorded start state.`
    return [
      reason('S008_REVERSE_PATCH_CONFLICT', 'FORK_ONLY', 'The turn cannot be reversed cleanly', detail, {
        evidenceRefs: [...paths],
      }),
    ]
  },
}

/**
 * `S009` — the workspace is not a Git repository.
 *
 * Distinguished from S001/S002 because "we looked and there is no repository" is
 * a different fact from "we never looked", and only the second one is a bug.
 */
export const s009NonGitWorkspace: SafetyRule = {
  id: 'S009_NON_GIT_WORKSPACE',
  evaluate: ({ pre, post, current }) => {
    const refs: string[] = []
    for (const checkpoint of [pre, post, current]) {
      if (checkpoint?.record.failureReason === CHECKPOINT_FAILURE.NOT_A_REPOSITORY) {
        refs.push(checkpoint.record.id)
      }
    }
    if (refs.length === 0) return []
    return [
      reason(
        'S009_NON_GIT_WORKSPACE',
        'UNPROTECTED',
        'The workspace is not a Git repository',
        'Turnscope records and restores changes through Git. Without a repository there is no history to recover from.',
        { evidenceRefs: refs },
      ),
    ]
  },
}

/**
 * `S010` — evidence is missing.
 *
 * Split by consequence: a checkpoint that *failed* leaves a hole big enough that
 * the safe answer is to withdraw the in-place option entirely, while a
 * checkpoint that was merely unable to read some paths is worth a warning. The
 * distinction is the one `docs/PRD.md §19` cares about — a partial observation is
 * not the same as a wrong one, but it is not the same as a complete one either.
 */
export const s010EvidenceIncomplete: SafetyRule = {
  id: 'S010_EVIDENCE_INCOMPLETE',
  evaluate: ({ pre, post, changeSet, turn }) => {
    const critical: SafetyReason[] = []
    if (changeSet === undefined) {
      critical.push(
        reason(
          'S010_EVIDENCE_INCOMPLETE',
          'UNPROTECTED',
          'The turn was never attributed',
          'No change set was computed for this turn, so there is no record of what it changed and nothing safe to act on.',
          { evidenceRefs: [turn.id] },
        ),
      )
    }
    for (const [label, checkpoint] of [
      ['before the turn', pre],
      ['after the turn', post],
    ] as const) {
      if (checkpoint?.record.completeness === 'failed' && checkpoint.record.failureReason !== CHECKPOINT_FAILURE.NOT_A_REPOSITORY) {
        critical.push(
          reason(
            'S010_EVIDENCE_INCOMPLETE',
            'UNPROTECTED',
            `The checkpoint ${label} could not be taken`,
            `The observation ${label} failed, so the changes cannot be established with confidence.`,
            { evidenceRefs: [checkpoint.record.id] },
          ),
        )
      }
    }
    if (critical.length > 0) return critical

    const warnings: SafetyReason[] = []
    for (const [label, checkpoint] of [
      ['before the turn', pre],
      ['after the turn', post],
    ] as const) {
      if (checkpoint?.record.completeness === 'partial') {
        warnings.push(
          reason(
            'S010_EVIDENCE_INCOMPLETE',
            'CAUTION',
            `The checkpoint ${label} is incomplete`,
            `Some files could not be read ${label}, so the recorded change set may be missing paths.`,
            { evidenceRefs: [checkpoint.record.id] },
          ),
        )
      }
    }
    return warnings
  },
}

/**
 * `S011` — a binary file changed and there is no before copy to put back.
 *
 * A binary has no textual delta to reason about, so the only question is whether
 * the bytes needed to undo the change were kept. When they were, the change is
 * judged like any other; when they were not, the turn is forked rather than
 * rewound.
 */
export const s011BinaryChange: SafetyRule = {
  id: 'S011_BINARY_CHANGE',
  evaluate: ({ pre, changeSet }) => {
    if (pre === undefined) return []
    const reasons: SafetyReason[] = []
    for (const change of changeSet?.changes ?? []) {
      if (change.kind !== 'binary_changed') continue
      if (beforeBytesAvailable(pre, change)) continue
      reasons.push(
        reason(
          'S011_BINARY_CHANGE',
          'FORK_ONLY',
          'A binary file changed and its previous contents were not kept',
          `${change.path} is binary and no copy of its earlier contents was recorded, so it cannot be restored in place.`,
          { path: change.path, evidenceRefs: change.evidenceRefs },
        ),
      )
    }
    return reasons
  },
}

/**
 * `S012` — the turn reached outside the repository.
 *
 * Deliberately a warning and not a refusal: files can be rewound and a deploy
 * cannot be un-deployed, so the honest move is to say so rather than to imply
 * that the button covers more than it does.
 */
export const s012ExternalSideEffect: SafetyRule = {
  id: 'S012_EXTERNAL_SIDE_EFFECT',
  evaluate: ({ externalEffects }) => {
    if (externalEffects === undefined || externalEffects.length === 0) return []
    const details = externalEffects.map(effect => effect.detail).join('; ')
    return [
      reason(
        'S012_EXTERNAL_SIDE_EFFECT',
        'CAUTION',
        'The turn may have had effects outside the repository',
        `Files may be rewindable, external effects are not. Recorded: ${details}.`,
        {
          evidenceRefs: externalEffects
            .map(effect => effect.activityId)
            .filter((id): id is string => id !== undefined),
        },
      ),
    ]
  },
}

/** Every P0 rule, in the order `docs/ARCHITECTURE.md §14.1` lists them. */
export const SAFETY_RULES: readonly SafetyRule[] = [
  s001PreCheckpointMissing,
  s002PostCheckpointMissing,
  s003RepositoryChanged,
  s004HeadDrift,
  s005TargetFileDrift,
  s006UncertainAttribution,
  s007GitOperationInProgress,
  s008ReversePatchConflict,
  s009NonGitWorkspace,
  s010EvidenceIncomplete,
  s011BinaryChange,
  s012ExternalSideEffect,
]

// ---------------------------------------------------------------------------

function operationsInProgress(checkpoint: ObservedCheckpoint): string[] {
  const { record } = checkpoint
  const operations: string[] = []
  if (record.mergeInProgress) operations.push('a merge')
  if (record.rebaseInProgress) operations.push('a rebase')
  if (record.cherryPickInProgress) operations.push('a cherry-pick')
  return operations
}

function joinSentences(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** `abcdef1…` — enough of an object id to recognise, short enough to read. */
function short(oid: string | undefined): string {
  if (oid === undefined) return 'an unknown commit'
  return `${oid.slice(0, 7)}…`
}

function beforeBytesAvailable(pre: ObservedCheckpoint, change: FileChange): boolean {
  const path = change.previousPath ?? change.path
  return pre.paths.some(state => state.path === path && state.blobRef !== undefined)
}
