import type { FileChange } from '../domain/types.ts';
import type { AttributionInput, TurnChangeSet } from './types.ts';
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
//# sourceMappingURL=engine.d.ts.map