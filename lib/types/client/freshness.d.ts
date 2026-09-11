/**
 * How much of what the panel shows is known to still be true.
 *
 * The panel has two sources and they are not the same kind of thing. The timeline
 * comes from the conversation the browser is already rendering and is *live* by
 * construction. The verdicts come from a request that finished at some point in
 * the past, and a request that finished is a fact about that moment — a turn that
 * started since will not be in the answer, and neither will a verdict the host
 * computed after it replied.
 *
 * So this is derived, not timed. The comparison is between the turns on screen
 * and the turns the host's answer mentions: an ordinal on screen that the answer
 * does not mention is not a disagreement about a turn, it is a *newer* turn. That
 * needs no clock, no polling, and no assumption about how fast either side is,
 * and it cannot be fooled by a tab that was suspended for an hour — a stale
 * answer stays recognisably stale until somebody asks again.
 */
import type { TurnModel } from './turn-model.ts';
import type { RecordedTurns } from './recorded-turns.ts';
export type Freshness = 
/** Nothing from the host yet, so there is nothing to qualify. */
'loading'
/** The host could not be asked; whatever is shown is what the timeline knows. */
 | 'error'
/** The answer is older than the turn list: it cannot speak about the last turns. */
 | 'stale'
/** In step with the host, and at least one turn is still running. */
 | 'live'
/** In step with the host, and every turn has ended. */
 | 'stable';
/**
 * Classify the answer against the timeline.
 *
 * `stale` is checked before `live` on purpose. A turn that is running *and* newer
 * than the answer is exactly the case where a reader is most likely to believe a
 * verdict that has not been computed yet, so "we are behind" is the more useful
 * of the two things to say.
 *
 * The empty timeline is not a special case: with no local turns nothing can be
 * behind, so the answer is `live` or `stable` depending on the host's own rows.
 * That reads correctly — a session with no turns in it is in step with itself.
 */
export declare function freshnessOf(local: readonly TurnModel[], recorded: RecordedTurns | undefined): Freshness;
//# sourceMappingURL=freshness.d.ts.map