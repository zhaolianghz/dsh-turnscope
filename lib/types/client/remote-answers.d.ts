import type { ReplyRead } from '../shared/contracts/api.ts';
/**
 * What is known about one asked-for key.
 *
 * `absent` and `failed` are deliberately separate: the first is the host's answer
 * ("I have nothing under that key"), the second is the absence of an answer. A
 * reader shown the first when the truth is the second goes looking for something
 * that was deleted.
 */
export type Answer<T> = {
    readonly kind: 'loading';
} | {
    readonly kind: 'value';
    readonly value: T;
} | {
    readonly kind: 'absent';
} | {
    readonly kind: 'failed';
    readonly reason: string;
};
/**
 * Answer the wanted keys, once each, in this generation.
 *
 * `generation` is carried *in* the cache rather than cleared by an effect, so
 * answers from an older generation are neither shown nor reused: a refreshed list
 * and a stale detail can never sit in the same card. Where the list itself uses
 * `freshness.ts` to reach the same conclusion, this is that conclusion for the
 * things that are only fetched when someone asks for them.
 */
export declare function useRemoteAnswers<T>(ask: (key: string) => Promise<ReplyRead<T>>, keys: readonly string[], generation: number): ReadonlyMap<string, Answer<T>>;
//# sourceMappingURL=remote-answers.d.ts.map