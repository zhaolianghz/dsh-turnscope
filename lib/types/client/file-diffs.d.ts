import type { GetDiffData } from '../shared/contracts/api.ts';
import type { TurnscopeHostApi } from './host-api.ts';
import { type Answer } from './remote-answers.ts';
export type FileDiffState = Answer<GetDiffData['diff']>;
/** A path inside a turn, as one key: a path cannot contain a NUL. */
export declare const diffKey: (turnId: string, path: string) => string;
export interface FileDiffFeed {
    readonly states: ReadonlyMap<string, FileDiffState>;
    /** The open diff, by `diffKey`. Absent when nothing is open. */
    readonly selected: string | undefined;
    readonly select: (turnId: string, path: string) => void;
}
export declare function useFileDiffs(host: TurnscopeHostApi, generation: number): FileDiffFeed;
//# sourceMappingURL=file-diffs.d.ts.map