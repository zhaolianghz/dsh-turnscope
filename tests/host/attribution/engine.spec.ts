/**
 * The attribution decision table.
 *
 * These tests read as prose on purpose: each one is a story about a turn —
 * "the agent edited a file that was clean", "the user was already editing it",
 * "the user edited it again afterwards" — and the assertion is the verdict a
 * person would give. When a rule changes, the story it breaks should be visible
 * in the test name rather than buried in a fixture.
 */
import { describe, expect, it } from 'vitest'
import { attributeChanges } from '../../../src/host/attribution/engine.ts'
import type { ObservedCheckpoint } from '../../../src/host/attribution/types.ts'
import { SCHEMA_VERSION } from '../../../src/host/domain/types.ts'
import type {
  CheckpointCompleteness,
  CheckpointPathState,
  FileToolHint,
  PathStatus,
} from '../../../src/host/domain/types.ts'

const TURN = 's-1:turn:3'

function state(
  path: string,
  status: PathStatus,
  hash: string | undefined,
  extra: Partial<CheckpointPathState> = {},
): CheckpointPathState {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: `cp:path:${path}`,
    checkpointId: 'cp',
    path,
    status,
    staged: false,
    binary: false,
    ...(hash === undefined ? {} : { contentHash: hash }),
    ...extra,
  }
}

function checkpoint(
  phase: 'pre' | 'post' | 'recovery_before' | 'recovery_after',
  completeness: CheckpointCompleteness,
  paths: readonly CheckpointPathState[],
): ObservedCheckpoint {
  return {
    record: {
      schemaVersion: SCHEMA_VERSION,
      id: `${TURN}:cp:${phase}`,
      workspaceId: 'ws-1',
      turnId: TURN,
      phase,
      cleanStart: false,
      mergeInProgress: false,
      rebaseInProgress: false,
      cherryPickInProgress: false,
      completeness,
      restorable: completeness === 'complete',
      createdAt: 1_700_000_000_000,
    },
    paths: paths.map(path => ({
      ...path,
      checkpointId: `${TURN}:cp:${phase}`,
      id: `${TURN}:cp:${phase}:path:${path.path}`,
    })),
  }
}

const hint = (path: string): FileToolHint => ({
  activityId: 's-1:act:9',
  path,
  operation: 'edit',
  occurredAt: 1_700_000_000_100,
})

/** The common shape: a complete PRE, a complete POST, nothing afterwards. */
function turn(options: {
  prePaths?: readonly CheckpointPathState[]
  postPaths?: readonly CheckpointPathState[]
  currentPaths?: readonly CheckpointPathState[]
  preCompleteness?: CheckpointCompleteness
  postCompleteness?: CheckpointCompleteness
  currentCompleteness?: CheckpointCompleteness
  hints?: readonly FileToolHint[]
}) {
  const pre = checkpoint('pre', options.preCompleteness ?? 'complete', options.prePaths ?? [])
  const post = checkpoint('post', options.postCompleteness ?? 'complete', options.postPaths ?? [])
  const current =
    options.currentPaths === undefined
      ? undefined
      : checkpoint('recovery_before', options.currentCompleteness ?? 'complete', options.currentPaths)
  return attributeChanges({
    pre,
    post,
    ...(current === undefined ? {} : { current }),
    hints: options.hints ?? [],
  })
}

const only = (changes: readonly { path: string }[]): { path: string } => {
  expect(changes).toHaveLength(1)
  return changes[0]!
}

describe('agent changes', () => {
  it('attributes an edit to a file that was clean at PRE, without claiming a before', () => {
    // The most common case there is. PRE has no row because the file was clean;
    // a complete PRE is the warrant that it was not the user's uncommitted work.
    const set = turn({
      postPaths: [state('src/auth.ts', 'modified', 'sha256:b')],
      hints: [hint('src/auth.ts')],
    })

    expect(set.changes).toHaveLength(1)
    expect(set.changes[0]).toMatchObject({
      id: `${TURN}:chg:src/auth.ts`,
      turnId: TURN,
      path: 'src/auth.ts',
      kind: 'modified',
      attribution: 'AGENT',
      // The attribution is certain; the *delta* is not, and saying `high` would
      // imply we can show a diff whose left side we never captured.
      confidence: 'medium',
      baseline: false,
      afterHash: 'sha256:b',
    })
    expect(set.changes[0]?.beforeHash).toBeUndefined()
  })

  it('calls a newly appearing untracked file created, at high confidence', () => {
    const set = turn({
      postPaths: [state('src/new.ts', 'untracked', 'sha256:n')],
      hints: [hint('src/new.ts')],
    })

    expect(only(set.changes)).toMatchObject({
      kind: 'created',
      attribution: 'AGENT',
      confidence: 'high',
      baseline: false,
    })
  })

  it('calls a staged addition created too, because git already accepted it', () => {
    const set = turn({ postPaths: [state('src/new.ts', 'added', 'sha256:n')] })
    expect(only(set.changes)).toMatchObject({ kind: 'created', attribution: 'AGENT' })
  })

  it('calls a disappearance deleted', () => {
    const set = turn({
      prePaths: [state('src/gone.ts', 'clean', 'sha256:g')],
      postPaths: [state('src/gone.ts', 'deleted', 'sha256:g')],
    })

    expect(only(set.changes)).toMatchObject({
      kind: 'deleted',
      attribution: 'AGENT',
      baseline: false,
      beforeHash: 'sha256:g',
      afterHash: 'sha256:g',
    })
  })

  it('detects a rename and carries where it came from', () => {
    const set = turn({
      prePaths: [state('src/old.ts', 'clean', 'sha256:o')],
      postPaths: [state('src/new.ts', 'renamed', 'sha256:o', { previousPath: 'src/old.ts' })],
    })

    expect(only(set.changes)).toMatchObject({
      path: 'src/new.ts',
      kind: 'renamed',
      attribution: 'AGENT',
      previousPath: 'src/old.ts',
      confidence: 'high',
    })
  })

  it('marks a binary content change as such rather than pretending it is text', () => {
    const set = turn({
      prePaths: [state('logo.png', 'clean', 'sha256:p', { binary: true })],
      postPaths: [state('logo.png', 'modified', 'sha256:q', { binary: true })],
    })

    expect(only(set.changes)).toMatchObject({ kind: 'binary_changed', attribution: 'AGENT' })
  })
})

describe('the user\'s own work', () => {
  it('reports a file that was already dirty and that the turn did not touch as BASELINE', () => {
    // §62 asserts exactly this: the user's edit must be visible and must not be
    // attributed to the agent. Omitting it would make the turn look like it owns
    // the file, which is the failure with zero tolerance.
    const set = turn({
      prePaths: [state('README.md', 'modified', 'sha256:user')],
      postPaths: [state('README.md', 'modified', 'sha256:user')],
    })

    expect(only(set.changes)).toMatchObject({
      path: 'README.md',
      attribution: 'BASELINE',
      baseline: true,
      confidence: 'high',
      beforeHash: 'sha256:user',
      afterHash: 'sha256:user',
    })
  })

  it('keeps a dirty file baseline even when the agent then edits it', () => {
    // §10.3: the turn delta is PRE→POST, and the file is still the user's to
    // start from. Both facts have to survive, and `baseline` is the second one.
    const set = turn({
      prePaths: [state('README.md', 'modified', 'sha256:user')],
      postPaths: [state('README.md', 'modified', 'sha256:user+agent')],
    })

    expect(only(set.changes)).toMatchObject({
      attribution: 'AGENT',
      baseline: true,
      beforeHash: 'sha256:user',
      afterHash: 'sha256:user+agent',
    })
  })
})

describe('drift after the turn', () => {
  it('reports DRIFT when CURRENT no longer matches what the turn left', () => {
    // §10.1 Case C: PRE != POST and CURRENT != POST.
    const set = turn({
      prePaths: [state('src/auth.ts', 'clean', 'sha256:a')],
      postPaths: [state('src/auth.ts', 'modified', 'sha256:b')],
      currentPaths: [state('src/auth.ts', 'modified', 'sha256:c')],
    })

    expect(only(set.changes)).toMatchObject({
      attribution: 'DRIFT',
      baseline: false,
      beforeHash: 'sha256:a',
      afterHash: 'sha256:b',
      currentHash: 'sha256:c',
    })
  })

  it('stays AGENT when CURRENT still matches POST', () => {
    const set = turn({
      prePaths: [state('src/auth.ts', 'clean', 'sha256:a')],
      postPaths: [state('src/auth.ts', 'modified', 'sha256:b')],
      currentPaths: [state('src/auth.ts', 'modified', 'sha256:b')],
    })

    expect(only(set.changes)).toMatchObject({ attribution: 'AGENT', currentHash: 'sha256:b' })
  })

  it('does not invent drift from a CURRENT that never observed the path', () => {
    // Absence is not evidence of stability, and it is not evidence of change
    // either. The turn-time answer stands.
    const set = turn({
      prePaths: [state('src/auth.ts', 'clean', 'sha256:a')],
      postPaths: [state('src/auth.ts', 'modified', 'sha256:b')],
      currentPaths: [],
    })

    expect(only(set.changes)).toMatchObject({ attribution: 'AGENT' })
  })

  it('treats a deleted-after-the-turn file as drift too', () => {
    const set = turn({
      prePaths: [state('src/auth.ts', 'clean', 'sha256:a')],
      postPaths: [state('src/auth.ts', 'modified', 'sha256:b')],
      currentPaths: [state('src/auth.ts', 'deleted', 'sha256:b')],
    })

    expect(only(set.changes)).toMatchObject({ attribution: 'DRIFT' })
  })
})

describe('uncertainty, and failing towards it', () => {
  it('refuses to attribute a change whose PRE pass did not complete', () => {
    // The PRE pass may simply have missed the path, and "we did not look" is not
    // "it was clean".
    const set = turn({
      preCompleteness: 'partial',
      postPaths: [state('src/auth.ts', 'modified', 'sha256:b')],
    })

    expect(only(set.changes)).toMatchObject({ attribution: 'UNCERTAIN', confidence: 'low' })
  })

  it('refuses to attribute when the POST pass did not complete', () => {
    const set = turn({
      postCompleteness: 'failed',
      prePaths: [state('src/auth.ts', 'clean', 'sha256:a')],
      postPaths: [state('src/auth.ts', 'modified', 'sha256:b')],
    })

    expect(only(set.changes)).toMatchObject({ attribution: 'UNCERTAIN', confidence: 'low' })
  })

  it('refuses to say what happened to a dirty file the POST pass never mentioned', () => {
    // Either the agent reverted it to HEAD or the pass missed it, and those are
    // different stories with different safe answers.
    const set = turn({
      prePaths: [state('src/auth.ts', 'modified', 'sha256:user')],
      postPaths: [],
    })

    expect(only(set.changes)).toMatchObject({
      attribution: 'UNCERTAIN',
      confidence: 'low',
      baseline: true,
    })
  })

  it('refuses to resolve a rename git paired twice', () => {
    // Guessing which file became which is exactly the move that would let a
    // rewind delete the wrong content.
    const set = turn({
      prePaths: [
        state('src/a.ts', 'clean', 'sha256:x'),
        state('src/b.ts', 'clean', 'sha256:y'),
      ],
      postPaths: [
        state('src/c.ts', 'renamed', 'sha256:x', { previousPath: 'src/a.ts' }),
        state('src/d.ts', 'renamed', 'sha256:y', { previousPath: 'src/a.ts' }),
      ],
    })

    expect(set.changes.map(change => change.attribution)).toEqual(['UNCERTAIN', 'UNCERTAIN'])
    expect(set.changes.every(change => change.confidence === 'low')).toBe(true)
  })

  it('refuses to resolve a rename git did not pair at all', () => {
    const set = turn({ postPaths: [state('src/new.ts', 'renamed', 'sha256:x')] })
    expect(only(set.changes)).toMatchObject({ kind: 'renamed', attribution: 'UNCERTAIN' })
  })

  it('does not invent a change it cannot see through fingerprints', () => {
    // No hashes on either side and the same presence: there is nothing to claim.
    const set = turn({
      prePaths: [state('src/a.ts', 'modified', undefined)],
      postPaths: [state('src/a.ts', 'modified', undefined)],
    })

    expect(set.changes).toEqual([])
  })

  it('never hands back a change it could not vouch for as the agent\'s', () => {
    // §10.5: `low` is not an actionable confidence. Here the file is gone at
    // POST and neither end was ever fingerprinted, so the only thing observed is
    // that a path stopped being present. Reporting `AGENT`/`deleted` would let a
    // rewind be offered on the strength of a guess about content nobody read.
    const set = turn({
      prePaths: [state('src/a.ts', 'clean', undefined)],
      postPaths: [state('src/a.ts', 'deleted', undefined)],
    })

    expect(only(set.changes)).toMatchObject({ attribution: 'UNCERTAIN', confidence: 'low' })
  })

  it('keeps a well-observed change attributable at medium confidence', () => {
    // The counterweight to the rule above: only `low` is barred. A modification
    // whose before-state was clean (so HEAD is the before) is genuinely known,
    // and calling it `UNCERTAIN` would make every untouched-at-PRE file look
    // like a mystery.
    const set = turn({ postPaths: [state('src/a.ts', 'modified', 'sha256:b')] })

    expect(only(set.changes)).toMatchObject({ attribution: 'AGENT', confidence: 'medium' })
  })
})

describe('what does not belong in the change set', () => {
  it('omits a clean path that did not change', () => {
    const set = turn({
      prePaths: [state('src/a.ts', 'clean', 'sha256:a')],
      postPaths: [state('src/a.ts', 'clean', 'sha256:a')],
    })

    expect(set.changes).toEqual([])
  })

  it('omits a path that has no observation on either side of the turn', () => {
    expect(turn({}).changes).toEqual([])
  })
})

describe('the shape of the answer', () => {
  it('sorts by path so two runs over the same evidence print identically', () => {
    const set = turn({
      postPaths: [
        state('z.ts', 'modified', 'sha256:z'),
        state('a.ts', 'modified', 'sha256:a'),
        state('m.ts', 'modified', 'sha256:m'),
      ],
    })

    expect(set.changes.map(change => change.path)).toEqual(['a.ts', 'm.ts', 'z.ts'])
  })

  it('counts each attribution for the summary line', () => {
    const set = turn({
      prePaths: [state('user.ts', 'modified', 'sha256:u')],
      postPaths: [
        state('user.ts', 'modified', 'sha256:u'),
        state('agent.ts', 'modified', 'sha256:a'),
        state('drifted.ts', 'modified', 'sha256:d'),
      ],
      currentPaths: [state('drifted.ts', 'modified', 'sha256:d2')],
    })

    expect(set.summary).toEqual({ total: 3, agent: 1, baseline: 1, drift: 1, uncertain: 0 })
  })

  it('cites the checkpoints, the path rows, and the hint a verdict rests on', () => {
    const set = turn({
      postPaths: [state('src/a.ts', 'modified', 'sha256:a')],
      hints: [hint('src/a.ts')],
    })

    // The UI has to be able to show *why*, so every fact used is named.
    expect(set.changes[0]?.evidenceRefs).toEqual([
      's-1:act:9',
      `${TURN}:cp:post`,
      `${TURN}:cp:post:path:src/a.ts`,
    ])
  })

  it('is deterministic: the same evidence produces the same answer', () => {
    const evidence = {
      prePaths: [state('README.md', 'modified', 'sha256:u')],
      postPaths: [
        state('README.md', 'modified', 'sha256:u'),
        state('src/a.ts', 'modified', 'sha256:a'),
      ],
    }

    expect(turn(evidence)).toEqual(turn(evidence))
  })
})
