import type { FileChange } from '../domain/types.ts';
import type { AttributionInput, AttributionSummary, ObservedCheckpoint, TurnChangeSet } from './types.ts';
/**
 * Attribute every path a turn touched.
 *
 * The union of the two checkpoints' paths is the working set: a path present in
 * only one of them is exactly the interesting case, and taking the union rather
 * than the intersection is what keeps a creation or a deletion from disappearing.
 */
export declare function attributeChanges(input: AttributionInput): TurnChangeSet;
/** Every path of a change set, for a caller that only needs the names. */
export declare function changedPaths(changes: readonly FileChange[]): readonly string[];
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
export declare function applyCurrentState(change: FileChange, current: ObservedCheckpoint): FileChange;
/**
 * Recount a change set's attributions.
 *
 * Exported because a change set is rebuilt from storage whenever a verdict is
 * refreshed: the changes are recorded facts and must not be re-derived, but the
 * summary that travels with them has to be reconstructed from the rows rather
 * than trusted to have been kept in step with them.
 */
export declare function summarizeChanges(changes: readonly FileChange[]): AttributionSummary;
//# sourceMappingURL=engine.d.ts.map