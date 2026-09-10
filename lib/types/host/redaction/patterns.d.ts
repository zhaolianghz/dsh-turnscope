/**
 * Secret recognition table.
 *
 * Order is part of the contract: the PEM block runs first so a multi-line key
 * body is consumed whole before any inner pattern can fragment it, and the
 * auth-header pattern runs before the bare token patterns so a header keeps its
 * single, most specific kind.
 */
/** Label reported in `RedactResult.masked` for one class of secret. */
export type SecretKind = 'private-key' | 'authorization-header' | 'openai-key' | 'aws-access-key-id' | 'github-token' | 'slack-token' | 'jwt' | 'assignment';
/** One recognition rule: a label and the global pattern that finds it. */
export interface SecretPattern {
    readonly kind: SecretKind;
    readonly pattern: RegExp;
}
/** `[REDACTED:<kind>]`, what every match is replaced with. */
export declare const markerFor: (kind: SecretKind) => string;
/**
 * Frozen, ordered recognition rules.
 *
 * The array and its entries are frozen but the regexes are not: a global regex
 * is mutated in place by `String.prototype.replace` and `RegExp.prototype.test`
 * (both write `lastIndex`), and writing to a frozen `RegExp` throws in strict
 * mode. Sharing the compiled regexes is still safe because `redact` resets
 * `lastIndex` before every use and never reads it afterwards.
 */
export declare const SECRET_PATTERNS: readonly SecretPattern[];
//# sourceMappingURL=patterns.d.ts.map