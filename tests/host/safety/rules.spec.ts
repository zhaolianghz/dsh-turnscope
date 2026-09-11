/**
 * One describe per P0 rule.
 *
 * Each rule gets the same shape of test: it fires when it should, it stays quiet
 * when it should, and it names the code and the path a user would need to see.
 * `§14` says a rule is only allowed to return reasons, so the assertion is always
 * about the reasons — never about the verdict, which belongs to the aggregator.
 */
import { describe, expect, it } from 'vitest'
import {
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
} from '../../../src/host/safety/rules.ts'
import { CHECKPOINT_FAILURE } from '../../../src/host/git/checkpoint.ts'
import { change, checkpoint, incompleteness, safetyInput } from './support.ts'

const codes = (reasons: readonly { code: string }[]): string[] => reasons.map(reason => reason.code)

describe('S001 pre-checkpoint missing', () => {
  it('withdraws the in-place option when there is no starting state', () => {
    const reasons = s001PreCheckpointMissing.evaluate(safetyInput({ pre: undefined }))
    expect(codes(reasons)).toEqual(['S001_PRE_CHECKPOINT_MISSING'])
    expect(reasons[0]?.severity).toBe('UNPROTECTED')
  })

  it('stays quiet when a pre-checkpoint exists', () => {
    expect(s001PreCheckpointMissing.evaluate(safetyInput())).toEqual([])
  })
})

describe('S002 post-checkpoint missing', () => {
  it('withdraws the in-place option when there is no end state', () => {
    const reasons = s002PostCheckpointMissing.evaluate(safetyInput({ post: undefined }))
    expect(codes(reasons)).toEqual(['S002_POST_CHECKPOINT_MISSING'])
    expect(reasons[0]?.severity).toBe('UNPROTECTED')
  })

  it('stays quiet when a post-checkpoint exists', () => {
    expect(s002PostCheckpointMissing.evaluate(safetyInput())).toEqual([])
  })
})

describe('S003 repository changed', () => {
  it('fires when the current workspace is a different repository', () => {
    const reasons = s003RepositoryChanged.evaluate(
      safetyInput({ current: checkpoint('recovery_before', { workspaceId: 'ws-2' }) }),
    )
    expect(codes(reasons)).toEqual(['S003_REPOSITORY_CHANGED'])
    expect(reasons[0]?.severity).toBe('UNPROTECTED')
  })

  it('stays quiet for the same workspace', () => {
    expect(s003RepositoryChanged.evaluate(safetyInput())).toEqual([])
  })

  it('stays quiet when there is nothing to compare against', () => {
    expect(s003RepositoryChanged.evaluate(safetyInput({ current: undefined }))).toEqual([])
  })
})

describe('S004 HEAD drift', () => {
  it('moves the turn to fork-only when history moved under it', () => {
    const reasons = s004HeadDrift.evaluate(
      safetyInput({ current: checkpoint('recovery_before', { headOid: 'b'.repeat(40) }) }),
    )
    expect(codes(reasons)).toEqual(['S004_HEAD_DRIFT'])
    expect(reasons[0]?.severity).toBe('FORK_ONLY')
    // The message has to be checkable, so it names both commits.
    expect(reasons[0]?.detail).toContain('aaaaaaa')
    expect(reasons[0]?.detail).toContain('bbbbbbb')
  })

  it('stays quiet when HEAD has not moved', () => {
    expect(s004HeadDrift.evaluate(safetyInput())).toEqual([])
  })

  it('stays quiet when neither side could read a HEAD', () => {
    // Two unreadable HEADs are not a drift; a non-git workspace is S009's job.
    const reasons = s004HeadDrift.evaluate(
      safetyInput({
        post: checkpoint('post', { headOid: undefined }),
        current: checkpoint('recovery_before', { headOid: undefined }),
      }),
    )
    expect(reasons).toEqual([])
  })
})

describe('S005 target file drift', () => {
  it('fires per drifted path and names it', () => {
    const reasons = s005TargetFileDrift.evaluate(
      safetyInput({
        changeSet: {
          turnId: 's-1:turn:3',
          changes: [change({ path: 'src/auth.ts', attribution: 'DRIFT' })],
          summary: { total: 1, agent: 0, baseline: 0, drift: 1, uncertain: 0 },
        },
      }),
    )
    expect(codes(reasons)).toEqual(['S005_TARGET_FILE_DRIFT'])
    expect(reasons[0]?.severity).toBe('FORK_ONLY')
    expect(reasons[0]?.path).toBe('src/auth.ts')
  })

  it('stays quiet for a change the turn still owns', () => {
    const reasons = s005TargetFileDrift.evaluate(
      safetyInput({
        changeSet: {
          turnId: 's-1:turn:3',
          changes: [change({ attribution: 'AGENT' })],
          summary: { total: 1, agent: 1, baseline: 0, drift: 0, uncertain: 0 },
        },
      }),
    )
    expect(reasons).toEqual([])
  })
})

describe('S006 uncertain attribution', () => {
  it('fires for each path that could not be attributed', () => {
    const reasons = s006UncertainAttribution.evaluate(
      safetyInput({
        changeSet: {
          turnId: 's-1:turn:3',
          changes: [change({ path: 'src/a.ts', attribution: 'UNCERTAIN', confidence: 'low' })],
          summary: { total: 1, agent: 0, baseline: 0, drift: 0, uncertain: 1 },
        },
      }),
    )
    expect(codes(reasons)).toEqual(['S006_UNCERTAIN_ATTRIBUTION'])
    expect(reasons[0]?.severity).toBe('FORK_ONLY')
    expect(reasons[0]?.path).toBe('src/a.ts')
  })

  it('stays quiet when everything was attributed', () => {
    expect(s006UncertainAttribution.evaluate(safetyInput())).toEqual([])
  })
})

describe('S007 Git operation in progress', () => {
  it('fires when the workspace is mid-merge right now', () => {
    const reasons = s007GitOperationInProgress.evaluate(
      safetyInput({ current: checkpoint('recovery_before', { mergeInProgress: true }) }),
    )
    expect(codes(reasons)).toEqual(['S007_GIT_OPERATION_IN_PROGRESS'])
    expect(reasons[0]?.severity).toBe('FORK_ONLY')
    expect(reasons[0]?.detail).toContain('a merge')
  })

  it('names every operation when more than one is recorded', () => {
    const reasons = s007GitOperationInProgress.evaluate(
      safetyInput({
        post: checkpoint('post', { rebaseInProgress: true, cherryPickInProgress: true }),
      }),
    )
    expect(reasons[0]?.detail).toMatch(/a rebase and a cherry-pick/)
  })

  it('stays quiet on a settled working tree', () => {
    expect(s007GitOperationInProgress.evaluate(safetyInput())).toEqual([])
  })
})

describe('S008 reverse patch conflict', () => {
  it('fires with the paths that would not apply', () => {
    const reasons = s008ReversePatchConflict.evaluate(
      safetyInput({ reversePatchCheck: { clean: false, conflicts: ['src/a.ts', 'src/b.ts'] } }),
    )
    expect(codes(reasons)).toEqual(['S008_REVERSE_PATCH_CONFLICT'])
    expect(reasons[0]?.severity).toBe('FORK_ONLY')
    expect(reasons[0]?.detail).toContain('src/a.ts, src/b.ts')
  })

  it('stays quiet when the patch applies', () => {
    expect(
      s008ReversePatchConflict.evaluate(safetyInput({ reversePatchCheck: { clean: true, conflicts: [] } })),
    ).toEqual([])
  })

  it('stays quiet when no dry-run was performed', () => {
    // Not having asked is not the same as having been told it would fail.
    expect(s008ReversePatchConflict.evaluate(safetyInput())).toEqual([])
  })
})

describe('S009 non-Git workspace', () => {
  it('fires when the observer found no repository', () => {
    const reasons = s009NonGitWorkspace.evaluate(
      safetyInput({
        post: checkpoint('post', {
          completeness: 'failed',
          restorable: false,
          failureReason: CHECKPOINT_FAILURE.NOT_A_REPOSITORY,
        }),
      }),
    )
    expect(codes(reasons)).toEqual(['S009_NON_GIT_WORKSPACE'])
    expect(reasons[0]?.severity).toBe('UNPROTECTED')
  })

  it('stays quiet for a workspace with a repository', () => {
    expect(s009NonGitWorkspace.evaluate(safetyInput())).toEqual([])
  })
})

describe('S010 evidence incomplete', () => {
  it('fires as UNPROTECTED when the turn was never attributed', () => {
    const reasons = s010EvidenceIncomplete.evaluate(safetyInput({ changeSet: undefined }))
    expect(codes(reasons)).toEqual(['S010_EVIDENCE_INCOMPLETE'])
    expect(reasons[0]?.severity).toBe('UNPROTECTED')
  })

  it('fires as UNPROTECTED when a checkpoint failed', () => {
    const reasons = s010EvidenceIncomplete.evaluate(
      safetyInput({
        post: checkpoint('post', {
          completeness: 'failed',
          restorable: false,
          failureReason: CHECKPOINT_FAILURE.STATUS_UNAVAILABLE,
        }),
      }),
    )
    expect(reasons[0]?.severity).toBe('UNPROTECTED')
  })

  it('fires only as CAUTION when a checkpoint read some paths but not all', () => {
    // A partial observation is not a wrong one, but it is not a complete one.
    const reasons = s010EvidenceIncomplete.evaluate(safetyInput({ pre: checkpoint('pre', incompleteness('partial')) }))
    expect(codes(reasons)).toEqual(['S010_EVIDENCE_INCOMPLETE'])
    expect(reasons[0]?.severity).toBe('CAUTION')
  })

  it('reports both checkpoints when both are partial', () => {
    const reasons = s010EvidenceIncomplete.evaluate(
      safetyInput({
        pre: checkpoint('pre', incompleteness('partial')),
        post: checkpoint('post', incompleteness('partial')),
      }),
    )
    expect(reasons).toHaveLength(2)
    expect(reasons.every(reason => reason.severity === 'CAUTION')).toBe(true)
  })

  it('stays quiet when everything is complete', () => {
    expect(s010EvidenceIncomplete.evaluate(safetyInput())).toEqual([])
  })
})

describe('S011 binary change', () => {
  const binaryChange = change({ path: 'logo.png', kind: 'binary_changed' })
  const withBeforeCopy = [
    { schemaVersion: 2 as const, id: '', checkpointId: '', path: 'logo.png', status: 'clean' as const, staged: false, binary: true, blobRef: 'objects/ab/cdef' },
  ]

  it('sends a binary change to fork-only when its earlier bytes were not kept', () => {
    const reasons = s011BinaryChange.evaluate(
      safetyInput({
        changeSet: { turnId: 's-1:turn:3', changes: [binaryChange], summary: { total: 1, agent: 1, baseline: 0, drift: 0, uncertain: 0 } },
      }),
    )
    expect(codes(reasons)).toEqual(['S011_BINARY_CHANGE'])
    expect(reasons[0]?.severity).toBe('FORK_ONLY')
  })

  it('stays quiet when the earlier bytes are available to restore', () => {
    const reasons = s011BinaryChange.evaluate(
      safetyInput({
        pre: checkpoint('pre', {}, withBeforeCopy),
        changeSet: { turnId: 's-1:turn:3', changes: [binaryChange], summary: { total: 1, agent: 1, baseline: 0, drift: 0, uncertain: 0 } },
      }),
    )
    expect(reasons).toEqual([])
  })

  it('ignores a text change', () => {
    const reasons = s011BinaryChange.evaluate(
      safetyInput({
        changeSet: { turnId: 's-1:turn:3', changes: [change()], summary: { total: 1, agent: 1, baseline: 0, drift: 0, uncertain: 0 } },
      }),
    )
    expect(reasons).toEqual([])
  })
})

describe('S012 external side effect', () => {
  it('warns, but does not refuse, when the turn reached outside the repo', () => {
    const reasons = s012ExternalSideEffect.evaluate(
      safetyInput({ externalEffects: [{ kind: 'deploy', detail: 'deployed to staging' }] }),
    )
    expect(codes(reasons)).toEqual(['S012_EXTERNAL_SIDE_EFFECT'])
    expect(reasons[0]?.severity).toBe('CAUTION')
    expect(reasons[0]?.detail).toContain('external effects are not')
  })

  it('stays quiet for a turn that only touched files', () => {
    expect(s012ExternalSideEffect.evaluate(safetyInput())).toEqual([])
  })
})
