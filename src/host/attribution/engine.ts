/**
 * The attribution rules of `docs/ARCHITECTURE.md §10`.
 *
 * Pure by construction: it takes checkpoints that were already captured and
 * returns changes. No clock, no process, no filesystem — which is what lets the
 * whole decision table below be tested against hand-written scenarios instead of
 * against a repository that has to be coaxed into the right shape first.
 *
 * The rule the product lives or dies on is `baseline`: a file that was already
 * dirty when the turn began belongs to the user, and `docs/PRD.md §19.2` gives
 * reporting it as the agent's work a zero tolerance. So the engine is built to
 * fail towards `UNCERTAIN` rather than towards `AGENT` whenever the evidence for
 * that distinction is missing, and never to guess.
 *
 * ## Why "not observed at PRE" is not the same as "unknown"
 *
 * `docs/ARCHITECTURE.md §12.2` records only *relevant* paths, so a file that was
 * clean at PRE has no row — and a clean file the agent then edits is the most
 * common change there is. Reading its absence as "PRE is missing" would make
 * almost every agent edit `UNCERTAIN` and the engine useless. The reading that
 * is both useful and honest is: *a complete checkpoint is a warrant about the
 * paths it did not list*. If PRE completed, a path it did not list was not dirty
 * at PRE, so the turn is the only thing that can have changed it.
 *
 * What that reading costs is the before *content* for those paths, so their
 * confidence is capped at `medium`: the attribution is certain, the delta is
 * not, and `docs/PRD.md §19` would rather the UI say "the agent changed this,
 * but we do not have the 'before'" than imply a diff we cannot show.
 */
import { fileChangeIdFor } from '../domain/ids.ts'
import { SCHEMA_VERSION } from '../domain/types.ts'
import type {
  Attribution,
  AttributionConfidence,
  CheckpointPathState,
  FileChange,
  FileChangeKind,
  FileToolHint,
} from '../domain/types.ts'
import type {
  AttributionInput,
  AttributionSummary,
  ObservedCheckpoint,
  TurnChangeSet,
} from './types.ts'

/** One checkpoint, indexed for lookup. */
interface IndexedCheckpoint {
  readonly record: ObservedCheckpoint['record']
  readonly byPath: ReadonlyMap<string, CheckpointPathState>
  /** True when every relevant path was read; the warrant the header describes. */
  readonly complete: boolean
}

/** One path as seen by one checkpoint. */
interface Observation {
  /** False when the checkpoint has no row for the path at all. */
  readonly seen: boolean
  /** False for a row whose status is `deleted`. */
  readonly present: boolean
  readonly hash: string | undefined
  readonly status: CheckpointPathState['status'] | undefined
  readonly binary: boolean
  /** The `checkpoint_paths.id`, so a verdict can cite the exact fact. */
  readonly stateId: string | undefined
  readonly renamedFrom: string | undefined
}

interface PathContext {
  readonly turnId: string
  readonly path: string
  readonly pre: IndexedCheckpoint
  readonly post: IndexedCheckpoint
  readonly current: IndexedCheckpoint | undefined
  readonly hint: FileToolHint | undefined
  readonly renameConflicted: boolean
}

/**
 * Attribute every path a turn touched.
 *
 * The union of the two checkpoints' paths is the working set: a path present in
 * only one of them is exactly the interesting case, and taking the union rather
 * than the intersection is what keeps a creation or a deletion from disappearing.
 */
export function attributeChanges(input: AttributionInput): TurnChangeSet {
  const pre = index(input.pre)
  const post = index(input.post)
  const current = input.current === undefined ? undefined : index(input.current)
  const hints = new Map(input.hints.map(hint => [hint.path, hint]))
  const conflicted = conflictedRenamePaths(post)

  const paths = [...new Set([...pre.byPath.keys(), ...post.byPath.keys()])].sort()
  const changes: FileChange[] = []
  for (const path of paths) {
    const change = attributePath({
      turnId: pre.record.turnId,
      path,
      pre,
      post,
      current,
      hint: hints.get(path),
      renameConflicted: conflicted.has(path),
    })
    if (change !== undefined) changes.push(change)
  }

  return { turnId: pre.record.turnId, changes, summary: summarizeChanges(changes) }
}

/** Every path of a change set, for a caller that only needs the names. */
export function changedPaths(changes: readonly FileChange[]): readonly string[] {
  return changes.map(change => change.path)
}

/**
 * Bring one recorded change's *current* fields up to date.
 *
 * A change has two kinds of field and they age differently. `kind`, `baseline`,
 * `previousPath` and the two endpoint hashes describe a turn that has already
 * ended; they are as true now as they were then. Whether the file is *still*
 * what the agent left is a statement about right now, and it is the one this
 * carries forward — otherwise a re-evaluation could report `S005` in the verdict
 * while the change row beside it still read `AGENT`, and which of the two a
 * client shows would depend on which endpoint it happened to call last.
 *
 * Only a change that was the agent's can drift. A baseline path was dirty before
 * the turn and stayed dirty through it, so the user editing it afterwards is not
 * a departure from anything we claimed (`docs/ARCHITECTURE.md §10.2`); calling
 * that drift would withdraw a rewind for a file the turn never touched.
 */
export function applyCurrentState(
  change: FileChange,
  current: ObservedCheckpoint,
): FileChange {
  const now = observe(index(current), change.path)
  const currentHash = now.hash
  const wasPresent = change.kind !== 'deleted'
  // Mirrors `drifted`: a path that is gone, or whose bytes differ. An `AGENT`
  // change whose after-content was never readable can only be seen to have moved
  // by its presence — that change is already `medium` confidence and already
  // reported as a hole by the checkpoint's own completeness, so guessing at a
  // content comparison here would invent evidence rather than find it.
  const moved =
    now.seen &&
    (now.present !== wasPresent ||
      (now.hash !== undefined && change.afterHash !== undefined && now.hash !== change.afterHash))

  if (!moved && currentHash === change.currentHash) return change

  const refs = new Set(change.evidenceRefs)
  if (now.seen) {
    refs.add(current.record.id)
    if (now.stateId !== undefined) refs.add(now.stateId)
  }

  return {
    ...change,
    attribution: moved && change.attribution === 'AGENT' ? 'DRIFT' : change.attribution,
    evidenceRefs: [...refs].sort(),
    ...(currentHash === undefined ? {} : { currentHash }),
  }
}

// ---------------------------------------------------------------------------
// One path
// ---------------------------------------------------------------------------

function attributePath(ctx: PathContext): FileChange | undefined {
  const after = observe(ctx.post, ctx.path)
  let before = observe(ctx.pre, ctx.path)
  // A rename is observed under its new path, so the PRE row for it is under the
  // old one. Looking it up is what lets the rename be recognised as a change at
  // all — its content is identical on both sides, so only the identity differs.
  if (!before.seen && after.status === 'renamed' && after.renamedFrom !== undefined) {
    before = observe(ctx.pre, after.renamedFrom)
  }
  const now = ctx.current === undefined ? undefined : observe(ctx.current, ctx.path)

  if (!before.seen && !after.seen) return undefined

  if (!before.seen) return fromPostOnly(ctx, after, now)
  if (!after.seen) return fromPreOnly(ctx, before)
  return fromBoth(ctx, before, after, now)
}

/**
 * The path has no PRE row.
 *
 * With a complete PRE that means the path was clean or did not exist, so the
 * turn is the only candidate. With an incomplete one, the PRE pass may simply
 * have failed to read it, and the safe answer is `UNCERTAIN`.
 */
function fromPostOnly(
  ctx: PathContext,
  after: Observation,
  now: Observation | undefined,
): FileChange | undefined {
  if (after.status === 'clean') return undefined

  const created = after.status === 'added' || after.status === 'untracked'
  // A row that says the path is *gone* is a change the turn made, not a reason
  // to say nothing. `deleted` is git reporting that a file it tracks left the
  // worktree, and a path with no PRE row was clean at PRE — which is the premise
  // above, that the turn is the only candidate — so nothing else can have
  // removed it. Reading "not present" as "nothing to report" dropped the case
  // entirely, which told a user whose agent deleted a file that the turn had
  // changed nothing; a deletion is also the change a recovery is most often
  // needed for.
  const kind: FileChangeKind = created
    ? 'created'
    : after.status === 'renamed'
      ? 'renamed'
      : after.present
        ? 'modified'
        : 'deleted'
  const drift = drifted(after, now)

  // A rename git could not pair is `§10.4`'s conflict, and it does not become
  // attributable just because one side of it is missing.
  if (ctx.renameConflicted) {
    return build(ctx, {
      kind,
      attribution: 'UNCERTAIN',
      confidence: 'low',
      baseline: false,
      after,
      now,
    })
  }

  if (!ctx.pre.complete) {
    return build(ctx, {
      kind,
      attribution: 'UNCERTAIN',
      confidence: 'low',
      baseline: false,
      after,
      now,
    })
  }

  return build(ctx, {
    kind,
    attribution: drift ? 'DRIFT' : 'AGENT',
    // A creation needs no before-content, because "nothing" is its before. The
    // other two have a before that no checkpoint fingerprinted — for a deletion
    // that is git's copy at `PRE`'s HEAD rather than a checkpoint blob — so the
    // attribution is certain and the delta is not.
    confidence: created ? 'high' : 'medium',
    baseline: false,
    after,
    now,
  })
}

/**
 * The path has no POST row.
 *
 * It was dirty at PRE and the POST pass does not mention it. Either it was
 * reverted to HEAD or the pass missed it; both leave the outcome unknown, and
 * `docs/ARCHITECTURE.md §10.4` puts a missing post-state in `UNCERTAIN`.
 */
function fromPreOnly(ctx: PathContext, before: Observation): FileChange | undefined {
  if (before.status === 'clean') return undefined
  return build(ctx, {
    kind: baselineKind(before),
    attribution: 'UNCERTAIN',
    confidence: 'low',
    baseline: true,
    before,
  })
}

/** Both checkpoints observed the path: the case `docs/ARCHITECTURE.md §10.1` is about. */
function fromBoth(
  ctx: PathContext,
  before: Observation,
  after: Observation,
  now: Observation | undefined,
): FileChange | undefined {
  const presenceChanged = before.present !== after.present
  const comparable = before.hash !== undefined && after.hash !== undefined
  const hashChanged = comparable && before.hash !== after.hash
  // A rename carries its content with it, so its hashes agree on both sides and
  // a hash comparison alone would call it unchanged. The change is the identity.
  const renamedNow = after.status === 'renamed' && before.status !== 'renamed'

  if (presenceChanged || hashChanged || renamedNow) {
    const kind = transitionKind(before, after)
    const baseline = before.status !== 'clean'
    const drift = drifted(after, now)
    const confidence = confidenceFor(ctx, after, comparable)
    return build(ctx, {
      kind,
      attribution:
        ctx.renameConflicted || !ctx.pre.complete || !ctx.post.complete
          ? 'UNCERTAIN'
          : drift
            ? 'DRIFT'
            : 'AGENT',
      confidence: ctx.renameConflicted ? 'low' : confidence,
      baseline,
      before,
      after,
      now,
    })
  }

  if (!comparable) return undefined
  // Unchanged and not dirty: the turn has nothing to say about it.
  if (before.status === 'clean') return undefined

  // Unchanged but dirty: the user's own uncommitted work, which `§62` requires
  // be reported — omitting it would make the turn look like it owns the file.
  return build(ctx, {
    kind: baselineKind(before),
    attribution: 'BASELINE',
    confidence: ctx.pre.complete && ctx.post.complete ? 'high' : 'low',
    baseline: true,
    before,
    after,
  })
}

// ---------------------------------------------------------------------------
// Small decisions
// ---------------------------------------------------------------------------

/**
 * Did the workspace move after the turn ended?
 *
 * Only meaningful when CURRENT was captured; a missing observation is not
 * evidence of stability, so it returns false and the caller stays with the
 * turn-time verdict. A comparison needs both hashes — an unreadable CURRENT is
 * again not evidence of anything.
 */
function drifted(after: Observation, now: Observation | undefined): boolean {
  if (now === undefined || !now.seen) return false
  if (now.present !== after.present) return true
  return now.hash !== undefined && after.hash !== undefined && now.hash !== after.hash
}

function confidenceFor(ctx: PathContext, after: Observation, comparable: boolean): AttributionConfidence {
  if (!ctx.pre.complete || !ctx.post.complete) return 'low'
  if (!comparable) return 'low'
  // A path git did not call changed, whose fingerprints nonetheless differ, is a
  // weaker observation than one git reported itself.
  return after.status === 'clean' ? 'medium' : 'high'
}

/** What happened between the two observations. */
function transitionKind(before: Observation, after: Observation): FileChangeKind {
  if (before.present && !after.present) return 'deleted'
  if (!before.present && after.present) return 'created'
  if (after.status === 'renamed') return 'renamed'
  if (before.binary || after.binary) return 'binary_changed'
  return 'modified'
}

/** For an untouched baseline entry, the path's standing rather than a transition. */
function baselineKind(before: Observation): FileChangeKind {
  if (before.status === 'added' || before.status === 'untracked') return 'created'
  if (before.status === 'renamed') return 'renamed'
  return 'modified'
}

/**
 * Renames git could not pair, or paired twice.
 *
 * A one-sided or duplicated rename means the pairing is a guess, and guessing
 * which file became which is precisely the move that would let a rewind delete
 * the wrong content (`docs/ARCHITECTURE.md §10.4`).
 */
function conflictedRenamePaths(post: IndexedCheckpoint): ReadonlySet<string> {
  const sources = new Map<string, number>()
  for (const state of post.byPath.values()) {
    if (state.status !== 'renamed' || state.previousPath === undefined) continue
    sources.set(state.previousPath, (sources.get(state.previousPath) ?? 0) + 1)
  }

  const conflicted = new Set<string>()
  for (const state of post.byPath.values()) {
    if (state.status !== 'renamed') continue
    if (state.previousPath === undefined || (sources.get(state.previousPath) ?? 0) > 1) {
      conflicted.add(state.path)
    }
  }
  return conflicted
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function index(observed: ObservedCheckpoint): IndexedCheckpoint {
  return {
    record: observed.record,
    byPath: new Map(observed.paths.map(path => [path.path, path])),
    complete: observed.record.completeness === 'complete',
  }
}

function observe(checkpoint: IndexedCheckpoint, path: string): Observation {
  const state = checkpoint.byPath.get(path)
  if (state === undefined) {
    return {
      seen: false,
      present: false,
      hash: undefined,
      status: undefined,
      binary: false,
      stateId: undefined,
      renamedFrom: undefined,
    }
  }
  return {
    seen: true,
    present: state.status !== 'deleted',
    hash: state.contentHash,
    status: state.status,
    binary: state.binary,
    stateId: state.id,
    renamedFrom: state.previousPath,
  }
}

interface BuildArgs {
  readonly kind: FileChangeKind
  readonly attribution: Attribution
  readonly confidence: AttributionConfidence
  readonly baseline: boolean
  readonly before?: Observation | undefined
  readonly after?: Observation | undefined
  readonly now?: Observation | undefined
  readonly extraRefs?: readonly string[] | undefined
}

/**
 * `docs/ARCHITECTURE.md §10.5`: a `low`-confidence attribution is not enough to
 * act on. Handing back `AGENT` with `confidence: 'low'` would let a caller that
 * only reads the attribution treat a guess as a finding — and the safety engine
 * would have to re-derive the same rule from a second field, in a second place,
 * with a chance of disagreeing.
 *
 * So the rule lives here, at the single point where a change is constructed:
 * a change we cannot vouch for is `UNCERTAIN`, and `AGENT`/`DRIFT` always imply
 * a confidence a caller may act on. Only those two are demoted — `BASELINE` and
 * `UNCERTAIN` are informational, and `low` is the honest word for them.
 */
function attributionFor(args: BuildArgs): Attribution {
  const unsupported = args.attribution === 'AGENT' || args.attribution === 'DRIFT'
  return unsupported && args.confidence === 'low' ? 'UNCERTAIN' : args.attribution
}

function build(ctx: PathContext, args: BuildArgs): FileChange {
  const refs = new Set<string>(args.extraRefs ?? [])
  if (args.before?.seen) {
    refs.add(ctx.pre.record.id)
    if (args.before.stateId !== undefined) refs.add(args.before.stateId)
  }
  if (args.after?.seen) {
    refs.add(ctx.post.record.id)
    if (args.after.stateId !== undefined) refs.add(args.after.stateId)
  }
  if (args.now?.seen) {
    refs.add(ctx.current?.record.id ?? '')
    if (args.now.stateId !== undefined) refs.add(args.now.stateId)
  }
  if (ctx.hint !== undefined) refs.add(ctx.hint.activityId)
  refs.delete('')

  const beforeHash = args.before?.hash
  const afterHash = args.after?.hash
  const currentHash = args.now?.hash
  const previousPath = args.after?.renamedFrom

  return {
    schemaVersion: SCHEMA_VERSION,
    id: fileChangeIdFor(ctx.turnId, ctx.path),
    turnId: ctx.turnId,
    path: ctx.path,
    kind: args.kind,
    attribution: attributionFor(args),
    confidence: args.confidence,
    baseline: args.baseline,
    evidenceRefs: [...refs].sort(),
    ...(beforeHash === undefined ? {} : { beforeHash }),
    ...(afterHash === undefined ? {} : { afterHash }),
    ...(currentHash === undefined ? {} : { currentHash }),
    ...(previousPath === undefined ? {} : { previousPath }),
  }
}

/**
 * Recount a change set's attributions.
 *
 * Exported because a change set is rebuilt from storage whenever a verdict is
 * refreshed: the changes are recorded facts and must not be re-derived, but the
 * summary that travels with them has to be reconstructed from the rows rather
 * than trusted to have been kept in step with them.
 */
export function summarizeChanges(changes: readonly FileChange[]): AttributionSummary {
  const count = (attribution: Attribution): number =>
    changes.filter(change => change.attribution === attribution).length
  return {
    total: changes.length,
    agent: count('AGENT'),
    baseline: count('BASELINE'),
    drift: count('DRIFT'),
    uncertain: count('UNCERTAIN'),
  }
}
