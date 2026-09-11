import type { TurnRecord } from '../domain/types.ts';
import type { GitPort } from '../git/git-port.ts';
import type { TurnWorkspace } from '../inspection/types.ts';
import type { ObjectStore } from '../storage/object-store.ts';
import type { TraceRepository } from '../storage/repository.ts';
import { type UnifiedDiffOptions } from './unified.ts';
import type { FileDiff } from './types.ts';
/** The stored evidence a diff is assembled from. */
export type DiffSink = Pick<TraceRepository, 'getCheckpoint' | 'listCheckpointPaths' | 'listFileChanges'>;
export interface DiffDeps {
    readonly git: GitPort;
    readonly store: ObjectStore;
    readonly sink: DiffSink;
    /** Overrides for the renderer's caps; the defaults are in `unified.ts`. */
    readonly limits?: Partial<UnifiedDiffOptions> | undefined;
}
export interface FileDiffReader {
    /**
     * The diff of one path in one turn, or `undefined` when the turn did not
     * change that path.
     *
     * `undefined` rather than an "unavailable" answer on purpose: a path the turn
     * never touched is *not found*, and a caller that rendered it as "we cannot
     * show you this" would be claiming evidence it does not have. The caller turns
     * this into the contract's `null`.
     */
    read(turn: TurnRecord, workspace: TurnWorkspace, path: string): Promise<FileDiff | undefined>;
}
export declare function createFileDiffReader(deps: DiffDeps): FileDiffReader;
//# sourceMappingURL=reader.d.ts.map