/**
 * Secret recognition table.
 *
 * Order is part of the contract: the PEM block runs first so a multi-line key
 * body is consumed whole before any inner pattern can fragment it, and the
 * auth-header pattern runs before the bare token patterns so a header keeps its
 * single, most specific kind.
 */

/** Label reported in `RedactResult.masked` for one class of secret. */
export type SecretKind =
  | 'private-key'
  | 'authorization-header'
  | 'openai-key'
  | 'aws-access-key-id'
  | 'github-token'
  | 'slack-token'
  | 'jwt'
  | 'assignment'

/** One recognition rule: a label and the global pattern that finds it. */
export interface SecretPattern {
  readonly kind: SecretKind
  readonly pattern: RegExp
}

/** `[REDACTED:<kind>]`, what every match is replaced with. */
export const markerFor = (kind: SecretKind): string => `[REDACTED:${kind}]`

/**
 * Marker prefix, used as a negative lookahead by the assignment rule.
 *
 * Keeping this guard here rather than trimming the value charset is what makes
 * redaction idempotent: `api_key=[REDACTED:openai-key]` must not read as an
 * assignment of a fresh value, so a second pass finds nothing to do.
 */
const GUARD = '\\[REDACTED:'

/**
 * An assignment whose name contains one of the sensitive words.
 *
 * The name is allowed to carry a prefix and a suffix (`AWS_SECRET_ACCESS_KEY`,
 * `GITHUB_TOKEN`), because an environment dump is the most likely place for a
 * credential to show up in a trace. The lookbehind stops at a bare identifier
 * character so `mysecret` is not read as `secret`; over-redacting a name that
 * merely mentions a token is the safe direction to fail in. The value must be
 * at least eight characters, which is what keeps prose like `token: abc` and
 * `password: prompt` intact.
 */
const ASSIGNMENT_VALUE = new RegExp(
  `(?<![A-Za-z0-9])(?:api[_-]?key|apikey|secret|password|passwd|pwd|token)[A-Za-z0-9_]*\\s*[:=]\\s*["']?(?!${GUARD})[^\\s"',;]{8,}["']?`,
  'gi',
)

const TABLE: readonly SecretPattern[] = [
  {
    kind: 'private-key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    kind: 'authorization-header',
    pattern: /\bauthorization\s*:\s*(?:bearer|basic|token)\s+[A-Za-z0-9\-._~+/=]{8,}/gi,
  },
  { kind: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}/g },
  // No trailing word-boundary assertion on the fixed-length prefixes above, and
  // none after the GitHub run: requiring that the match end at a boundary lets
  // a longer run through completely unredacted, which is a leak, while matching
  // the minimum only ever over-redacts a suffix that follows the credential.
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: 'slack-token', pattern: /\bxox[bp]-[A-Za-z0-9-]{10,}/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { kind: 'assignment', pattern: ASSIGNMENT_VALUE },
]

/**
 * Frozen, ordered recognition rules.
 *
 * The array and its entries are frozen but the regexes are not: a global regex
 * is mutated in place by `String.prototype.replace` and `RegExp.prototype.test`
 * (both write `lastIndex`), and writing to a frozen `RegExp` throws in strict
 * mode. Sharing the compiled regexes is still safe because `redact` resets
 * `lastIndex` before every use and never reads it afterwards.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze(
  TABLE.map((entry) => Object.freeze(entry)),
)
