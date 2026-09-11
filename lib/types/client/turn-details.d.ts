import type { TurnDetailData } from '../shared/contracts/api.ts';
import type { TurnscopeHostApi } from './host-api.ts';
import { type Answer } from './remote-answers.ts';
/** What a card can say about a turn it opened. */
export type TurnDetailState = Answer<TurnDetailData>;
export interface TurnDetailFeed {
    /** One entry per turn that has been opened at least once, in this generation. */
    readonly states: ReadonlyMap<string, TurnDetailState>;
    /** Which cards are open. */
    readonly expanded: ReadonlySet<string>;
    readonly toggle: (turnId: string) => void;
}
export declare function useTurnDetails(host: TurnscopeHostApi, generation: number): TurnDetailFeed;
//# sourceMappingURL=turn-details.d.ts.map