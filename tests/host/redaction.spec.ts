import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { SECRET_PATTERNS } from '../../src/host/redaction/patterns.ts'
import { redact, redactDeep } from '../../src/host/redaction/redact.ts'
import { truncateBytes } from '../../src/host/redaction/truncate.ts'

// ---------------------------------------------------------------------------
// Fixtures. Every secret carries a distinctive tail so absence can be asserted
// on a substring that only the original value could produce.
// ---------------------------------------------------------------------------

const OPENAI_KEY = 'sk-proj-Ab12Cd34Ef56Gh78Ij90KlMn'
const ANTHROPIC_KEY = 'sk-ant-api03-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0F'
const BEARER_TOKEN = 'Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZg'
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const GITHUB_TOKEN = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz'
// Synthetic-looking Slack-shaped fixtures: a `TEST` namespace token is used
// so the pattern matchers in `redact.ts` still trigger while the strings stay
// distinguishable from real Slack tokens on secret-scanning review.
const SLACK_TOKEN = 'xoxb-TEST-FAKE0001-FAKE0000000001-FAKEFAKEFAKE'
const SLACK_ALT = 'xoxp-TEST-FAKE0001-FAKE0000000001-FAKEFAKEFAKE'
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const PEM_BODY = 'MIIEowIBAAKCAQEAxYzAbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  PEM_BODY,
  'token: abcdefgh0123456789',
  '9zy8yx7xw6wv5vu4ut3ts2sr1rq0qp',
  '-----END RSA PRIVATE KEY-----',
].join('\n')

const ASSIGNED_VALUE = 'Qw3rTy6Ui8Op1As2Df4Gh'

const ASSIGNMENT_FORMS = [
  `api_key=${ASSIGNED_VALUE}`,
  `apiKey: "${ASSIGNED_VALUE}"`,
  `secret: '${ASSIGNED_VALUE}'`,
  `password=${ASSIGNED_VALUE}`,
  `token: ${ASSIGNED_VALUE}`,
] as const

/**
 * Redact `input` and prove the secret is gone.
 *
 * The `toContain` on the raw input is what keeps the assertion below honest: if
 * the fixture ever stopped containing the secret, the absence check would pass
 * vacuously and this fails instead.
 */
const expectSecretRemoved = (secret: string, kind: string, input: string): string => {
  expect(input).toContain(secret)
  const result = redact(input)
  expect(result.text).not.toContain(secret)
  expect(result.masked).toContain(kind)
  return result.text
}

// ---------------------------------------------------------------------------
// Positives
// ---------------------------------------------------------------------------

describe('redact: positives', () => {
  it('masks OpenAI style keys', () => {
    expectSecretRemoved(OPENAI_KEY, 'openai-key', `export OPENAI_API_KEY=${OPENAI_KEY}`)
  })

  it('masks Anthropic style keys', () => {
    expectSecretRemoved(ANTHROPIC_KEY, 'openai-key', `key is ${ANTHROPIC_KEY} ok`)
  })

  it('masks an Authorization Bearer header', () => {
    expectSecretRemoved(
      BEARER_TOKEN,
      'authorization-header',
      `Authorization: Bearer ${BEARER_TOKEN}`,
    )
  })

  it('masks a lower-case authorization bearer header', () => {
    expectSecretRemoved(
      BEARER_TOKEN.toLowerCase(),
      'authorization-header',
      `authorization: bearer ${BEARER_TOKEN.toLowerCase()}`,
    )
  })

  it('masks an AWS access key id', () => {
    expectSecretRemoved(AWS_KEY, 'aws-access-key-id', `aws_access_key_id = ${AWS_KEY}`)
  })

  it('masks a GitHub token', () => {
    expectSecretRemoved(GITHUB_TOKEN, 'github-token', `remote: https://${GITHUB_TOKEN}@github.com`)
  })

  it.each(['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'])('masks a %s GitHub token', (prefix) => {
    const secret = `${prefix}1234567890abcdefghijklmnopqrstuvwxyz`
    expectSecretRemoved(secret, 'github-token', `token=${secret}`)
  })

  it('masks a Slack token', () => {
    expectSecretRemoved(SLACK_TOKEN, 'slack-token', `SLACK_TOKEN=${SLACK_TOKEN}`)
  })

  it('masks a Slack user token', () => {
    expectSecretRemoved(SLACK_ALT, 'slack-token', `slack: ${SLACK_ALT} is stale`)
  })

  it('masks a JWT', () => {
    expectSecretRemoved(JWT, 'jwt', `Authorization: ${JWT}`)
  })

  it.each(ASSIGNMENT_FORMS)('masks the assignment form %s', (form) => {
    const text = expectSecretRemoved(ASSIGNED_VALUE, 'assignment', `config line: ${form}`)
    expect(text).toContain('[REDACTED:assignment]')
  })

  it('masks an environment-style assignment', () => {
    const awsSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    expectSecretRemoved(
      awsSecret,
      'assignment',
      `export AWS_SECRET_ACCESS_KEY=${awsSecret}`,
    )
    expectSecretRemoved(ASSIGNED_VALUE, 'assignment', `DB_PASSWORD=${ASSIGNED_VALUE}`)
    expectSecretRemoved(ASSIGNED_VALUE, 'assignment', `session_token: ${ASSIGNED_VALUE}`)
  })

  // A JSON key's closing quote sits between the name and the separator, and a
  // quoted key is the most likely way a credential reaches a trace at all.
  it.each([
    ['{"password":"correct-horse-battery"}', 'correct-horse-battery'],
    ['{"api_key":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['  "token": "abcdefgh12345678"', 'abcdefgh12345678'],
    ["{'secret': 'abc12345678'}", 'abc12345678'],
  ])('masks a quoted key %s', (input, secret) => {
    const text = expectSecretRemoved(secret, 'assignment', input)
    expect(text).not.toContain(secret)
    expect(text).toContain('[REDACTED:assignment]')
  })

  // The sensitive word may be the tail of an identifier: `DBPASSWORD` is as
  // much an environment dump as `DB_PASSWORD`.
  it.each([
    ['DBPASSWORD=abc12345', 'abc12345'],
    ['MONGOPASSWORD=abc12345', 'abc12345'],
    ['appsecret=abcdefgh1234', 'abcdefgh1234'],
    ['DB_PASSWORD=abc12345', 'abc12345'],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ])('masks a suffixed environment name %s', (input, secret) => {
    expectSecretRemoved(secret, 'assignment', input)
  })

  // A value that contains a space must be consumed whole. Stopping at the first
  // space is the worst outcome this layer can produce: a marker is present, so
  // the line reads as handled, while the tail is stored in clear.
  it.each([
    ['password: hunter2hunter2 hunter2', 'hunter2hunter2 hunter2'],
    ['password: correct horse battery staple', 'correct horse battery staple'],
    ['password="correct horse"', 'correct horse'],
  ])('masks a value containing spaces %s', (input, secret) => {
    const text = expectSecretRemoved(secret, 'assignment', input)
    expect(text).toBe('[REDACTED:assignment]')
  })

  it('leaves no tail of a spaced value beside the marker', () => {
    const result = redact('password: hunter2hunter2 hunter2')
    expect(result.text).not.toContain('hunter2')
    expect(result.text.match(/\[REDACTED:/g)).toHaveLength(1)
  })

  it('masks a token that continues past its minimum length', () => {
    // A run longer than the minimum must not defeat the match: the leading
    // minimum is the credential, the tail is a suffix.
    const secret = `${GITHUB_TOKEN}_extended`
    const text = expectSecretRemoved(GITHUB_TOKEN, 'github-token', `token=${secret}`)
    expect(text).toBe('token=[REDACTED:github-token]_extended')
  })

  it('masks an AWS key run that continues past sixteen characters', () => {
    const text = expectSecretRemoved(AWS_KEY, 'aws-access-key-id', `${AWS_KEY}1`)
    expect(text).toBe('[REDACTED:aws-access-key-id]1')
  })
})

describe('redact: PEM private key blocks', () => {
  it('replaces a multi-line block wholesale', () => {
    const text = expectSecretRemoved(PEM_BODY, 'private-key', `before\n${PEM}\nafter`)
    expect(text).not.toContain('-----BEGIN RSA PRIVATE KEY-----')
    expect(text).not.toContain('9zy8yx7xw6wv5vu4ut3ts2sr1rq0qp')
    expect(text).toContain('before')
    expect(text).toContain('after')
  })

  it('consumes the block before inner patterns can fragment it', () => {
    // The body carries an assignment-shaped line: if the assignment pattern ran
    // first it would split the block into several markers.
    const result = redact(`before\n${PEM}\nafter`)
    expect(result.masked).toEqual(['private-key'])
    expect(result.text.match(/\[REDACTED:/g)).toHaveLength(1)
  })

  it('masks a PKCS#8 block', () => {
    const block = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`
    expectSecretRemoved(PEM_BODY, 'private-key', block)
  })
})

describe('redact: masking contract', () => {
  it('lists the fired kinds, sorted and de-duplicated', () => {
    const input = `${OPENAI_KEY} ${OPENAI_KEY} ${AWS_KEY} ${GITHUB_TOKEN}`
    const result = redact(input)
    expect(result.masked).toEqual(['aws-access-key-id', 'github-token', 'openai-key'])
  })

  it('reports every kind in the pattern table exactly once', () => {
    const input = `a\n${PEM}\n${OPENAI_KEY}\nAuthorization: Bearer ${BEARER_TOKEN}\n${AWS_KEY}\n${GITHUB_TOKEN}\n${SLACK_TOKEN}\n${JWT}\ntoken: ${ASSIGNED_VALUE}`
    const result = redact(input)
    expect(result.masked).toEqual(
      [...SECRET_PATTERNS.map((entry) => entry.kind)].sort((left, right) =>
        left < right ? -1 : 1,
      ),
    )
  })

  it('exposes a frozen, ordered pattern table that starts with the PEM block', () => {
    expect(Object.isFrozen(SECRET_PATTERNS)).toBe(true)
    expect(SECRET_PATTERNS.map((entry) => entry.kind)[0]).toBe('private-key')
    for (const entry of SECRET_PATTERNS) {
      expect(Object.isFrozen(entry)).toBe(true)
      expect(entry.pattern.global).toBe(true)
    }
  })

  it('is deterministic across repeated and interleaved calls', () => {
    const first = `Authorization: Bearer ${BEARER_TOKEN}`
    const second = `key=${OPENAI_KEY}`
    const once = redact(first)
    const elsewhere = redact(second)
    expect(redact(first)).toEqual(once)
    expect(redact(second)).toEqual(elsewhere)
    expect(redact(first)).toEqual(once)
    expect(redact(first).text).toBe(once.text)
  })

  it('leaves no lastIndex state behind in the shared patterns', () => {
    redact(`Authorization: Bearer ${BEARER_TOKEN} ${OPENAI_KEY} ${AWS_KEY}`)
    for (const entry of SECRET_PATTERNS) expect(entry.pattern.lastIndex).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Negatives
// ---------------------------------------------------------------------------

describe('redact: negatives pass through unchanged', () => {
  const untouched = [
    'The token was refreshed successfully.',
    'Please rotate the secret before Friday.',
    'token: abc',
    'password: short',
    'sk-abc',
    'commit 4f3a9c2',
    '/Users/skyzhao/orca/workspaces/tuskfish/src/redaction/patterns.ts',
    '2026-09-10T20:31:00.000Z',
    '这是一段普通的中文说明，其中没有配置任何密钥。',
    'It took 3 iterations to converge.',
    'token,value',
  ] as const

  it.each(untouched)('leaves %j alone', (input) => {
    expect(redact(input)).toEqual({ text: input, masked: [] })
  })

  it('leaves an already-masked string alone', () => {
    for (const input of [
      `Authorization: Bearer [REDACTED:authorization-header]`,
      'api_key=[REDACTED:openai-key]',
      '[REDACTED:assignment]',
      '-----BEGIN [REDACTED:private-key]-----',
    ]) {
      expect(redact(input)).toEqual({ text: input, masked: [] })
    }
  })

  it('is idempotent', () => {
    const input = [
      `Authorization: Bearer ${BEARER_TOKEN}`,
      `api_key=${ASSIGNED_VALUE}`,
      `token=${OPENAI_KEY}`,
      `{"password":"correct horse battery"}`,
      `  "secret": "${ASSIGNED_VALUE}",`,
      `DBPASSWORD=${ASSIGNED_VALUE}`,
      PEM,
    ].join('\n')
    const once = redact(input)
    const twice = redact(once.text)
    expect(twice.text).toBe(once.text)
    expect(twice.masked).toEqual([])
  })

  it('would fail if a secret leaked, proving the assertion is not vacuous', () => {
    const raw = `Authorization: Bearer ${BEARER_TOKEN}`
    const leaked = `Authorization: Bearer ${BEARER_TOKEN}`
    expect(raw).toContain(BEARER_TOKEN)
    expect(leaked).toContain(BEARER_TOKEN)
    expect(() => expect(leaked).not.toContain(BEARER_TOKEN)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// redactDeep
// ---------------------------------------------------------------------------

describe('redactDeep', () => {
  it('reaches strings nested inside objects and arrays', () => {
    const input = {
      command: `curl -H "Authorization: Bearer ${BEARER_TOKEN}"`,
      retries: 3,
      stream: ['stdout', OPENAI_KEY, 42, true, null],
      nested: { note: 'plain prose', deeper: { id: AWS_KEY } },
    }
    const output = redactDeep(input) as {
      command: string
      retries: number
      stream: unknown[]
      nested: { note: string; deeper: { id: string } }
    }
    expect(output.command).not.toContain(BEARER_TOKEN)
    expect(output.stream[1]).toBe('[REDACTED:openai-key]')
    expect(output.nested.deeper.id).toBe('[REDACTED:aws-access-key-id]')
    expect(output.nested.note).toBe('plain prose')
  })

  it('leaves numbers, booleans and null untouched', () => {
    const input = { n: 1.5, b: false, z: null, t: true }
    const output = redactDeep(input) as typeof input
    expect(output).toEqual({ n: 1.5, b: false, z: null, t: true })
    expect(Number.isInteger(output.n)).toBe(false)
  })

  it('handles non-container values', () => {
    expect(redactDeep(7)).toBe(7)
    expect(redactDeep(true)).toBe(true)
    expect(redactDeep(null)).toBeNull()
    expect(redactDeep(undefined)).toBeUndefined()
    expect(redactDeep(OPENAI_KEY)).toBe('[REDACTED:openai-key]')
  })

  it('does not mutate its input', () => {
    const input = { a: `key=${OPENAI_KEY}`, b: [AWS_KEY] }
    redactDeep(input)
    expect(input.a).toContain(OPENAI_KEY)
    expect(input.b[0]).toBe(AWS_KEY)
  })
})

// ---------------------------------------------------------------------------
// truncateBytes
// ---------------------------------------------------------------------------

const MARKER = '…[truncated]'
const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8')

const withoutMarker = (text: string): string =>
  text.endsWith(MARKER) ? text.slice(0, -MARKER.length) : text

describe('truncateBytes', () => {
  it('is a no-op under the limit, reporting the true byte size', () => {
    expect(truncateBytes('hello', 100)).toEqual({ text: 'hello', truncated: false, originalBytes: 5 })
  })

  it('is a no-op exactly at the limit, counted in bytes not characters', () => {
    expect(truncateBytes('ééé', 6)).toEqual({ text: 'ééé', truncated: false, originalBytes: 6 })
  })

  it('is a no-op on the empty string', () => {
    expect(truncateBytes('', 0)).toEqual({ text: '', truncated: false, originalBytes: 0 })
  })

  it('truncates ASCII, keeping within the byte budget', () => {
    const result = truncateBytes('x'.repeat(200), 40)
    expect(result.truncated).toBe(true)
    expect(result.originalBytes).toBe(200)
    expect(result.text.endsWith(MARKER)).toBe(true)
    expect(byteLength(result.text)).toBeLessThanOrEqual(40)
    expect(withoutMarker(result.text)).toBe('x'.repeat(26))
  })

  it('never splits a two-byte codepoint', () => {
    const input = 'é'.repeat(20)
    const result = truncateBytes(input, 17)
    expect(result.truncated).toBe(true)
    expect(result.originalBytes).toBe(40)
    expect(result.text).not.toContain('�')
    expect(byteLength(result.text)).toBeLessThanOrEqual(17)
    expect(withoutMarker(result.text)).toBe('é')
  })

  it('never splits a four-byte codepoint', () => {
    const input = '🚀'.repeat(8)
    const result = truncateBytes(input, 19)
    expect(result.truncated).toBe(true)
    expect(result.originalBytes).toBe(32)
    expect(result.text).not.toContain('�')
    expect(byteLength(result.text)).toBeLessThanOrEqual(19)
    expect(result.text).toBe(`🚀${MARKER}`)
  })

  it('does not walk back when the cut already lands on a boundary', () => {
    const result = truncateBytes('🚀'.repeat(8), 18)
    expect(result.text).toBe(`🚀${MARKER}`)
    expect(byteLength(result.text)).toBe(18)
  })

  it('reports the original size in bytes for multi-byte input', () => {
    const result = truncateBytes('🚀'.repeat(8), 20)
    expect(result.originalBytes).toBe(32)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe(`🚀${MARKER}`)
    expect(byteLength(result.text)).toBeLessThanOrEqual(20)
  })

  it('stays within the budget even when there is no room for the marker', () => {
    const result = truncateBytes('🚀🚀🚀', 3)
    expect(result).toEqual({ text: '', truncated: true, originalBytes: 12 })
  })

  it('treats a non-finite limit as no limit', () => {
    expect(truncateBytes('hello', Number.POSITIVE_INFINITY).truncated).toBe(false)
  })

  it('never returns more bytes than the limit, for any prefix of a mixed string', () => {
    const input = `aa🚀bbécc${'x'.repeat(30)}`
    for (let limit = 0; limit <= 60; limit += 1) {
      const result = truncateBytes(input, limit)
      expect(byteLength(result.text)).toBeLessThanOrEqual(limit)
      expect(result.text).not.toContain('�')
      expect(result.originalBytes).toBe(byteLength(input))
    }
  })
})
