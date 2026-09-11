import type { TurnDetailData } from '../shared/contracts/api.ts';
import type { TurnscopeHostApi } from './host-api.ts';
/**
 * What a card can say about a turn it opened.
 *
 * `missing` and `failed` are separate because the host distinguishes them: the
 * first is an answer ("I have no such turn"), the second is not an answer at all.
 * A reader told the first when the truth is the second goes looking for a turn
 * somebody deleted.
 */
export type TurnDetailState = {
    readonly kind: 'loading';
} | {
    readonly kind: 'loaded';
    readonly detail: TurnDetailData;
} | {
    readonly kind: 'missing';
} | {
    readonly kind: 'failed';
    readonly reason: string;
};
export interface TurnDetailFeed {
    /** One entry per turn that has been opened at least once, in this generation. */
    readonly states: ReadonlyMap<string, TurnDetailState>;
    /** Which cards are open. */
    readonly expanded: ReadonlySet<string>;
    readonly toggle: (turnId: string) => void;
}
/**
 * Answer a card's detail, once per turn per generation.
 *
 * `generation` is the reader's refresh counter, and it is carried in the cache
 * rather than cleared by an effect: answers from an older generation are not
 * shown and not reused, so a refreshed list and a stale detail can never sit in
 * the same card. Keeping them in step is the same job `freshness.ts` does for the
 * list, and doing it in two different ways is how the two drift apart.
 *
 * Opening a card only records *intent*; the effect below turns intent into a
 * request. That is what keeps a request from being restarted by a re-render, and
 * what makes "opened but not yet answered" a state rather than a flag on a click.
 */
export declare function useTurnDetails(host: TurnscopeHostApi, generation: number): TurnDetailFeed;
//# sourceMappingURL=turn-details.d.ts.map