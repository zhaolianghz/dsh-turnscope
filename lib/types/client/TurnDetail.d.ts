/**
 * One turn, in full.
 *
 * The section order is `docs/PRD.md §14.1`'s: safety first, then what changed,
 * then how it was validated, then what could be done about it. Raw events are
 * last, and on the card rather than here, because they are the thing a reader
 * goes looking for only after the verdict has failed to explain something.
 *
 * Everything the user is asked to believe is a word. `§14.2` forbids hedging about
 * safety and `§14.4` forbids colour as the only carrier of meaning, so every chip
 * and every row below states its case in text and the stylesheet only groups them.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { TurnDetailState } from './turn-details.ts';
export interface TurnDetailProps {
    readonly state: TurnDetailState;
    /** The clock, as an input. See `age.ts` for why it is not read here. */
    readonly now: number;
}
export declare function TurnDetailView({ state, now, t, }: TurnDetailProps & PropsLocale<'turnscope'>): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=TurnDetail.d.ts.map