/**
 * How long ago a verdict was computed.
 *
 * Coarse on purpose. `docs/ARCHITECTURE.md §16` wants the panel to show
 * "evaluated Xs ago", and the *point* of that number is to say whether the verdict
 * is worth believing right now — a judgement from four seconds ago and one from
 * forty are the same answer to that question. A precise counter would invite
 * reading it as a measurement, and a ticking one would need a timer in a component
 * that otherwise has no reason to re-render.
 *
 * `now` is a parameter for the same reason the safety engine takes one: a render
 * that reads the clock is a function of something its caller cannot control, and
 * the rule here is that the same inputs produce the same output.
 */
export type AgeUnit = 'now' | 'seconds' | 'minutes' | 'hours' | 'days';
export interface Age {
    readonly unit: AgeUnit;
    readonly count: number;
}
export declare function ageOf(evaluatedAt: number, now: number): Age;
//# sourceMappingURL=age.d.ts.map