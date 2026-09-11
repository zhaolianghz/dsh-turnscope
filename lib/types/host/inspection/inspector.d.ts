import type { InspectionDeps, TurnInspector } from './types.ts';
/**
 * Build the pipeline.
 *
 * The returned inspector is safe to call concurrently but is not a
 * synchronization primitive: the recorder drives it from a single ordered queue
 * per session, and that is where mutual exclusion lives. Duplicating the queue
 * here would hide a recorder bug rather than fix one.
 */
export declare function createTurnInspector(deps: InspectionDeps): TurnInspector;
//# sourceMappingURL=inspector.d.ts.map