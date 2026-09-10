# Host Trace Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Turnscope a real DSH host half that records every agent turn — activity events, redacted payloads, Git checkpoints — into a plugin-private local store, without ever blocking or modifying the user's workspace.

**Architecture:** The package becomes a dual-face DSH plugin. The existing browser face (a read-only `conversation.view`) is unchanged. A new Cordis host plugin subscribes to DSH's `session/event` firehose at the unscoped root context, maps upstream events into a versioned internal `NormalizedEvent` model, runs them through a pure turn state machine, redacts every payload **before** it is persisted, and writes small indexed metadata into a `node:sqlite` index while larger immutable blobs go into a content-addressed object store — both inside a plugin-private directory. A structured `GitPort` observes the workspace at turn boundaries and records checkpoints. This slice is strictly **record-only**: it never writes to Git, never resets, never checks out, and never creates a commit or tag.

**Tech Stack:** TypeScript 6.0.3, Node.js 22.19+, pnpm 11.7, Cordis 4.0.2, DSH public packages 0.1.1-rc.2, Vitest 4.1.8, `node:sqlite` (`DatabaseSync`), tsdown 0.22.2.

## Global Constraints

- Package name is `@zhaolianghz/dsh-turnscope` and all source is ESM.
- The first supported DSH baseline is exactly `0.1.1-rc.2`; do not claim compatibility with other versions.
- **The host event listener MUST be registered on the unscoped root context.** A listener registered inside a scope-tagged context is silently filtered by DSH's scope layer and will observe nothing. Never compose this plugin per-agent or per-session.
- **This slice performs zero Git writes.** No `git reset`, `git checkout`, `git commit`, `git tag`, `git add`, `git write-tree`, or `git hash-object -w`. `git hash-object` is invoked **without** `-w` so it computes a hash without writing a loose object.
- **Git is always invoked with an explicit argv array. Never build a shell string.** No `sh -c`, no interpolation, no `exec` with a composed command line.
- **Redaction happens before persistence, always.** No unredacted byte may reach the SQLite index, the object store, or a diagnostic log. Redaction is not reversible at read time.
- **Fail-open is absolute.** Losing recording capability is acceptable; blocking the agent is not. `apply` must never throw. Every storage, Git, and adapter failure is caught, recorded as a bounded diagnostic, and the turn continues.
- The plugin must never delete, move, or modify anything outside its own data directory. Checkpoints never touch `HEAD`, the branch, the index, or the worktree.
- Unknown or future upstream event types must degrade to an ignored event plus a diagnostic counter — never a throw, never a dropped turn.
- All persisted formats carry an explicit schema version. Incompatible older data is refused for reads with a clear message; it must never prevent DSH from starting.
- Tests are written before implementation and every task ends in a passing focused test plus a commit.
- Host-side tests use the default Vitest `node` environment. Only files named `*.client.spec.tsx` use `// @vitest-environment jsdom`.
- `node:sqlite` emits an `ExperimentalWarning` on Node 22; that is expected and must not be suppressed by muting all warnings.

---

## Reference: verified upstream API

Established empirically against DSH `0.1.1-rc.2`; do not re-derive.

```ts
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'

// Subscription — works on the root/unscoped context, before or after the store mounts.
ctx.on('session/event', (session, event) => { /* ... */ })

// Test harness shape
const ctx = new Context()
await ctx.plugin(SessionStore).await()
ctx.sessions.create('s-1', { meta: { cwd: '/tmp/x' } }).append('turn/start', { turn: 0 })
```

The event envelope is `{ type, seq, time, data }`, and surface events additionally carry a sibling `surfaceOp` (`'append'` or `{ op: 'replace', start, end }`) — `surfaceOp` is **not** inside `data`. Real dumps:

```json
{ "type": "turn/start", "seq": 0, "time": 1789042697930, "data": { "turn": 0 } }
{ "type": "step/start", "seq": 2, "time": 1789042697930, "data": { "turn": 0, "step": 0 } }
{ "type": "tool/call", "seq": 3, "time": 1789042697930,
  "data": { "turn": 0, "step": 0, "callId": "call-1", "name": "read_file", "arguments": "{\"path\":\"/tmp/x\"}" } }
{ "type": "tool/result", "seq": 4, "time": 1789042697930,
  "data": { "turn": 0, "step": 0, "message": { "source": { "kind": "tool", "callId": "call-1" },
            "content": [ { "type": "tool-result", "toolCallId": "call-1",
                           "content": [ { "type": "text", "text": "file body" } ], "isError": false } ],
            "role": "user", "id": "3caf714f-…" } },
  "surfaceOp": "append" }
{ "type": "turn/end", "seq": 7, "time": 1789042697930,
  "data": { "turn": 0, "reason": { "kind": "completed" } } }
```

- `tool/call.arguments` is the **raw unparsed JSON string**.
- All `turn/end` reason kinds are constructible: `completed`, `aborted({reason:{kind:'user'|'parent'|'hook'|'disposed'|'legacy'}})`, `blocked`, `error({message,code,…})`, `max-tokens`, `interrupted`.
- `session.header` is `{ version: 0, id, createdAt, cwd? }` — `cwd` is absolute and round-trips exactly.
- `ctx.sessions` requires a declared `inject: ['sessions']`. Reading it from a plugin fiber without that injection throws.
- `@deepseek-ai/dsh-session` imports `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-scope` as peer deps that pnpm does not hoist to the project root, so `@deepseek-ai/dsh-llm` must be declared as a direct devDependency for its message types to resolve.

## Reference: storage precedent

Verified against shipping code. Follow these, do not invent alternatives.

- The DSH storage hub (`ctx.storageDomain`) has **three first-party consumers and zero third-party ones**, is mounted only by the `dsh-web-app` bundle (absent from `dsh-base`), ships only a JSON backend, and documents "no cross-table transactions, secondary indexes, or multi-segment keys". **Do not depend on it.**
- The one real third-party plugin on this machine (`dshmarket`) owns a private directory (`mode 0o700`) with its own files.
- The single `node:sqlite` consumer in the tree (`dsh-session-query-sqlite`) establishes the pattern to copy: `PRAGMA journal_mode = WAL`, `0o700` directory + `0o600` exclusive-create file, an `application_id` ownership guard that refuses a foreign database, `STRICT` tables, and `BEGIN IMMEDIATE` transactions.

---

## File Map

```text
package.json                                  Host bundle patch, peer deps, files allowlist
cordis.patch.yml                              Bundle patch inserting the host plugin row
src/index.ts                                  Host Cordis plugin entry (name/inject/apply)
src/config.ts                                 Config defaults, never-throwing validation
src/diagnostics.ts                            Bounded in-memory diagnostic recorder
src/domain/types.ts                           NormalizedEvent, TurnRecord, ActivityRecord, CheckpointRecord
src/domain/ids.ts                             Deterministic, idempotent record ids
src/domain/turn-state.ts                      Pure turn status machine
src/redaction/patterns.ts                     Credential and secret detection patterns
src/redaction/redact.ts                       Redaction pipeline (runs before persistence)
src/redaction/truncate.ts                     UTF-8 safe byte-limit truncation
src/storage/paths.ts                          Plugin-private data root resolution
src/storage/atomic.ts                         Temp-write + fsync + atomic rename
src/storage/object-store.ts                   Content-addressed immutable blob store
src/storage/schema.ts                         SQLite DDL, migrations, ownership guard
src/storage/sqlite-index.ts                   DatabaseSync lifecycle
src/storage/repository.ts                     TraceRepository port + SQLite adapter
src/storage/retention.ts                      Pure oldest-first eviction selection
src/adapter/normalize.ts                      Upstream SessionEvent -> NormalizedEvent
src/adapter/assembler.ts                      Turn assembly, out-of-order buffer, state machine
src/adapter/subscribe.ts                      session/event subscription wiring
src/git/command-runner.ts                     argv-only command runner, no shell
src/git/git-port.ts                           Structured GitPort interface + adapter
src/git/checkpoint.ts                         Checkpoint creation from workspace observation
src/trace-core.ts                             Composition root wiring the above into a running core
tests/host-plugin.spec.ts                     Host entry + manifest contract (MODIFIED)
tests/config.spec.ts                          Defaults and never-throwing validation
tests/turn-state.spec.ts                      Status machine transitions
tests/redaction.spec.ts                       Secret masking and truncation
tests/storage-atomic.spec.ts                  Atomic write behaviour
tests/object-store.spec.ts                    Content-addressed put/get/idempotency
tests/repository.spec.ts                      SQLite persistence, restart recovery, transactions
tests/assembler.spec.ts                       Turn assembly, unknown events, out-of-order
tests/git-port.spec.ts                        Real temp-repo Git observation
tests/checkpoint.spec.ts                      Checkpoint creation leaves Git state untouched
tests/retention.spec.ts                       Eviction selection and protected refs
tests/trace-core.spec.ts                      End-to-end recording over a real SessionStore
README.md                                     Development status and local loading (MODIFIED)
```

---

## Task 1: Make the package a real host plugin

**Files:**

- Modify: `package.json`
- Create: `cordis.patch.yml`
- Create: `src/config.ts`
- Create: `src/diagnostics.ts`
- Modify: `src/index.ts`
- Modify: `tests/host-plugin.spec.ts`
- Create: `tests/config.spec.ts`

**Interfaces:**

- Produces: host export `name = 'turnscope'`.
- Produces: host export `apply(ctx: Context, config?: unknown): void` that never throws.
- Produces: `resolveConfig(input: unknown): TurnscopeConfig`.
- Produces: `Diagnostics` with `record(entry)` and `snapshot()`.

- [ ] **Step 1: Write the failing config tests**

```ts
// tests/config.spec.ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('returns documented defaults for absent input', () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG)
    expect(DEFAULT_CONFIG.retentionDays).toBe(30)
    expect(DEFAULT_CONFIG.retentionBytes).toBe(104_857_600)
    expect(DEFAULT_CONFIG.maxOutputBytes).toBe(32_768)
    expect(DEFAULT_CONFIG.ignorePaths).toEqual([])
    expect(DEFAULT_CONFIG.enabled).toBe(true)
  })

  it('accepts well-formed partial input', () => {
    expect(resolveConfig({ retentionDays: 7, ignorePaths: ['secrets/**'] })).toMatchObject({
      retentionDays: 7,
      ignorePaths: ['secrets/**'],
      retentionBytes: 104_857_600,
    })
  })

  it('falls back to safe defaults instead of throwing on garbage', () => {
    for (const bad of [null, 42, 'nope', [], { retentionDays: -1 }, { retentionBytes: 'big' },
                       { ignorePaths: 'not-an-array' }, { dataDir: 123 }, { maxOutputBytes: Number.NaN }]) {
      expect(() => resolveConfig(bad)).not.toThrow()
      const resolved = resolveConfig(bad)
      expect(resolved.retentionDays).toBeGreaterThan(0)
      expect(resolved.retentionBytes).toBeGreaterThan(0)
      expect(resolved.maxOutputBytes).toBeGreaterThan(0)
      expect(Array.isArray(resolved.ignorePaths)).toBe(true)
    }
  })

  it('preserves a valid explicit dataDir and rejects a relative one', () => {
    expect(resolveConfig({ dataDir: '/tmp/turnscope-test' }).dataDir).toBe('/tmp/turnscope-test')
    expect(resolveConfig({ dataDir: 'relative/path' }).dataDir).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/config.spec.ts`

Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 3: Implement config and diagnostics**

```ts
// src/config.ts
export interface TurnscopeConfig {
  readonly enabled: boolean
  readonly dataDir: string | undefined
  readonly retentionDays: number
  readonly retentionBytes: number
  readonly maxOutputBytes: number
  readonly ignorePaths: readonly string[]
}

export const DEFAULT_CONFIG: TurnscopeConfig = Object.freeze({
  enabled: true,
  dataDir: undefined,
  retentionDays: 30,
  retentionBytes: 104_857_600,
  maxOutputBytes: 32_768,
  ignorePaths: Object.freeze([]),
})
```

`resolveConfig` never throws and never returns a value that violates the interface: read each field from the input only when the input is a non-null object and the field has the right runtime type **and** passes its constraint (positive finite integer for the numeric limits, absolute path for `dataDir`, array of strings for `ignorePaths`); otherwise substitute the default for that field alone. An invalid field must not discard the valid ones.

`Diagnostics` keeps a bounded ring (capacity 50) of `{ at, code, message }` entries where `message` is already passed through the redactor by the caller, exposes `record(entry): void` and `snapshot(): readonly DiagnosticEntry[]`, and counts ignored unknown event types by name in a separate bounded map so a noisy upstream cannot grow memory without limit.

- [ ] **Step 4: Add the host entry, bundle patch, and manifest fields**

```ts
// src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.ts'

export const name = 'turnscope'

/**
 * Host entry. Recording is best-effort: a failure here must never surface to
 * the harness, so this function is a hard boundary and never throws.
 */
export function apply(ctx: Context, config?: unknown): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return
  try {
    // Task 6 replaces this body with the real trace core.
    void ctx
  } catch {
    // fail-open: recording is optional, the agent is not
  }
}
```

```yaml
# cordis.patch.yml
# dsh bundle patch: inserts the Turnscope host plugin into a profile's layer stack.
- insert:
    - id: turnscope
      name: '@zhaolianghz/dsh-turnscope'
```

In `package.json` add, without disturbing the existing `dsh.client` block:

- `dsh.bundle.patch` set to `"./cordis.patch.yml"` as a sibling of `dsh.client`;
- `"./cordis.patch.yml": "./cordis.patch.yml"` in `exports`;
- peerDependencies `"@deepseek-ai/dsh-session": "0.1.1-rc.2"` and `"@deepseek-ai/dsh-llm": "0.1.1-rc.2"`;
- a `files` allowlist covering `lib`, `client`, `cordis.patch.yml`, `README.md`, `LICENSE` (mirroring how `dshmarket` ships).
- **Leave the compact one-line formatting of the existing `exports` entries alone** — `pnpm` rewrites them to multi-line on any install, so restore the original single-line form if `pnpm` reformats it.

- [ ] **Step 5: Rewrite the host contract test**

The existing `tests/host-plugin.spec.ts` calls `apply()` with no arguments, which is no longer valid. Replace it with a test that mounts the plugin the way the Cordis loader does and asserts the bundle/manifest contract:

```ts
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, name } from '../src/index.ts'

describe('host plugin contract', () => {
  it('mounts on a real Cordis context without throwing', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({ name, apply })
    await fiber.await()
    await fiber.dispose()
  })

  it('never throws when handed unusable configuration', () => {
    expect(() => apply(new Context(), { retentionDays: 'nope', dataDir: 7 })).not.toThrow()
  })

  it('declares the native DSH web client face and the host bundle patch', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(manifest.dsh.client).toEqual({
      inject: [
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-conversation',
      ],
      platform: 'web',
    })
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports['./client'].default).toBe('./lib/client.js')
    expect(manifest.exports['./cordis.patch.yml']).toBe('./cordis.patch.yml')
  })

  it('ships a patch that inserts exactly this package', () => {
    const patch = readFileSync('cordis.patch.yml', 'utf8')
    expect(patch).toContain('id: turnscope')
    expect(patch).toContain("name: '@zhaolianghz/dsh-turnscope'")
  })
})
```

- [ ] **Step 6: Run focused verification**

Run: `pnpm vitest run tests/host-plugin.spec.ts tests/config.spec.ts && pnpm typecheck && pnpm build`

Expected: all tests PASS, typecheck exits 0, build exits 0.

- [ ] **Step 7: Commit**

```bash
git add package.json cordis.patch.yml src/index.ts src/config.ts src/diagnostics.ts tests/host-plugin.spec.ts tests/config.spec.ts
git commit -m "feat: make turnscope a loadable DSH host plugin"
```

## Task 2: Domain model and turn state machine

**Files:**

- Create: `src/domain/types.ts`
- Create: `src/domain/ids.ts`
- Create: `src/domain/turn-state.ts`
- Create: `tests/turn-state.spec.ts`

**Interfaces:**

- Produces: `SCHEMA_VERSION`, `TurnStatus`, `NormalizedEvent`, `ActivityRecord`, `TurnRecord`, `CheckpointRecord`, `WorkspaceRecord`, `SessionRecord`, `ObjectRecord`.
- Produces: `activityIdFor(sessionId, seq)`, `turnIdFor(sessionId, turn)`, `checkpointIdFor(turnId, phase)`.

**Pinned id formats — every producer must go through these functions; never hand-build an id.** `turnIdFor(sessionId, turn)` → `${sessionId}:turn:${turn}`; `activityIdFor(sessionId, seq)` → `${sessionId}:act:${seq}`; `checkpointIdFor(turnId, phase)` → `${turnId}:cp:${phase}`. Deriving a checkpoint id from `turnId` rather than `sessionId` is deliberate: it makes a turn's `pre` and `post` ids structurally incapable of colliding.
- Produces: `transitionTurn(current: TurnStatus, next: TurnStatus): TurnStatus`.

- [ ] **Step 1: Write the failing state-machine tests**

Cover the full legal matrix and the terminal-state rule:

- `pending -> running` yields `running`; `pending -> completed` yields `completed`.
- `running -> completed`, `running -> failed`, `running -> interrupted` all succeed.
- Terminal states are absorbing: `completed -> running`, `failed -> failed`, `interrupted -> running`, `completed -> failed` all return the **current** value unchanged.
- An `interrupted -> completed` late event must **not** resurrect the turn.

Also assert id determinism and idempotency:

- `activityIdFor('s1', 7)` equals `activityIdFor('s1', 7)` and differs from `activityIdFor('s1', 8)` and `activityIdFor('s2', 7)`.
- `turnIdFor('s1', 3)` is stable across calls.
- Selecting any id twice produces byte-identical strings.

And assert the `NormalizedEvent` shape is honoured by a representative construction:

```ts
const event: NormalizedEvent = {
  schemaVersion: SCHEMA_VERSION,
  workspaceId: 'w1',
  sessionId: 's1',
  turnId: turnIdFor('s1', 0),
  activityId: activityIdFor('s1', 3),
  kind: 'tool',
  phase: 'started',
  occurredAt: '2026-09-10T00:00:00.000Z',
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/turn-state.spec.ts`

Expected: FAIL because the domain modules do not exist.

- [ ] **Step 3: Implement the domain model**

`SCHEMA_VERSION = 1`, exported as a `const` so every persisted record can carry it.

`NormalizedEvent` matches `docs/ARCHITECTURE.md §3.1` exactly — `schemaVersion`, `workspaceId`, `sessionId`, `turnId`, `activityId`, optional `parentActivityId`, `kind` (`'turn' | 'model' | 'tool' | 'command' | 'approval' | 'test' | 'error' | 'system'`), `phase` (`'started' | 'updated' | 'completed' | 'failed' | 'interrupted'`), `occurredAt` as an ISO-8601 string, and optional `payloadRef`.

`TurnRecord`: `{ schemaVersion, id, sessionId, ordinal, status, startedAt, endedAt?, activityCount, errorCount, preCheckpointId?, postCheckpointId? }` with epoch-millisecond times.

`ActivityRecord`: `{ schemaVersion, id, turnId, sessionId, parentId?, kind, phase, seq, label, occurredAt, payloadRef?, truncated? }`.

`CheckpointRecord`: `{ schemaVersion, id, workspaceId, turnId, phase: 'pre' | 'post', headOid?, branch?, cleanStart, indexDigest?, worktreeDigest?, fileDigests?, restorable, createdAt, failureReason? }`.

`WorkspaceRecord`: `{ schemaVersion, id, repoRoot, repoRootHash, settingsJson, createdAt }` — `repoRootHash` is the sha256 of the canonical root path, so the record can be keyed without storing a raw user path anywhere it is not needed.

`SessionRecord`: `{ schemaVersion, id, workspaceId, upstreamSessionId, parentSessionId?, createdAt }`.

`ObjectRecord`: `{ schemaVersion, ref, kind, byteSize, sha256, createdAt }`.

`turnIdFor` produces `${sessionId}:turn:${turn}` and `activityIdFor` produces `${sessionId}:act:${seq}`. Because DSH's `seq` is unique and monotonic per session, these are naturally idempotent — a replayed event maps to the same row and an upsert is a no-op.

`transitionTurn` returns `next` only when `current` is non-terminal; if `current` is `completed`, `failed`, or `interrupted` it returns `current` unchanged. `pending` and `running` are the only non-terminal states. Keep the function total over `TurnStatus` and free of side effects.

- [ ] **Step 4: Run focused verification**

Run: `pnpm vitest run tests/turn-state.spec.ts && pnpm typecheck`

Expected: all tests PASS, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/domain tests/turn-state.spec.ts
git commit -m "feat: add turnscope domain model and turn state machine"
```

## Task 3: Redaction and truncation

**Files:**

- Create: `src/redaction/patterns.ts`
- Create: `src/redaction/redact.ts`
- Create: `src/redaction/truncate.ts`
- Create: `tests/redaction.spec.ts`

**Interfaces:**

- Produces: `redact(input: string): RedactResult` where `RedactResult = { text: string; masked: readonly string[] }` and `masked` lists the pattern kinds that fired.
- Produces: `redactDeep(value: unknown): unknown` applying `redact` to every string in a JSON-shaped value.
- Produces: `truncateBytes(input: string, maxBytes: number): TruncateResult` where `TruncateResult = { text: string; truncated: boolean; originalBytes: number }`.

- [ ] **Step 1: Write the failing redaction tests**

Every case must assert that the secret's **distinctive substring is absent from the output**, not merely that a marker is present — a test that only checks for `[REDACTED]` passes even when the secret leaks.

Required positives, each with a real-looking sample value:

- OpenAI/Anthropic style: `sk-` followed by 20+ of `[A-Za-z0-9_-]`.
- `Authorization: Bearer <token>` and `authorization: bearer <token>` (case-insensitive header name).
- AWS access key id: `AKIA` + 16 uppercase alphanumerics.
- GitHub token: `ghp_`, `gho_`, `ghu_`, `ghs_`, or `ghr_` + 36+ alphanumerics.
- Slack token: `xoxb-` / `xoxp-` followed by digits and dashes.
- PEM private key blocks: `-----BEGIN … PRIVATE KEY-----` through `-----END … PRIVATE KEY-----`, including multi-line bodies, replaced wholesale.
- JWT: three dot-separated base64url segments starting `eyJ`.
- Assignment forms: `api_key=…`, `apiKey: "…"`, `secret: '…'`, `password=…`, `token: …` with an 8+ character value.

Required negatives — these must pass through **unchanged**:

- Ordinary prose containing the word "token" or "secret" with no value.
- A short literal like `token: abc`.
- A commit short-hash, a file path, an ISO timestamp, and a Chinese sentence.
- An already-masked string (redaction must be idempotent — `redact(redact(x).text).text === redact(x).text`).

Also assert:

- `redact` reports exactly the expected kind labels in `masked`, sorted and de-duplicated.
- `redactDeep` reaches strings nested inside objects and arrays and leaves numbers, booleans, and `null` untouched.
- Truncation: `truncateBytes` never splits a multi-byte UTF-8 codepoint — truncating a string of `é` or `🚀` at an odd byte boundary yields valid UTF-8 whose `Buffer.byteLength` is `<= maxBytes`.
- Truncation is a no-op when under the limit, reporting `truncated: false` and the true `originalBytes`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/redaction.spec.ts`

Expected: FAIL because the redaction modules do not exist.

- [ ] **Step 3: Implement the redaction pipeline**

`src/redaction/patterns.ts` exports a frozen, ordered `SECRET_PATTERNS` array of `{ kind: string; pattern: RegExp }`. Every pattern is created with a global, case-insensitive flag set **as appropriate for that pattern** and is instantiated fresh per use (or reset via `lastIndex = 0`) so a `/g` regex is never shared in a way that makes results depend on call order — assert this with a test that redacts the same input twice and compares.

`redact` replaces each match with `[REDACTED:<kind>]`, collecting the distinct kinds that fired. It runs PEM blocks first so a multi-line key body is consumed before inner patterns can fragment it.

`truncateBytes` encodes to a `Buffer`, slices to `maxBytes`, then decodes a prefix that does not end mid-codepoint — walk back at most three bytes from the cut while the byte at that position is a UTF-8 continuation byte (`0b10xxxxxx`). Append `…[truncated]` only when something was actually dropped.

Every one of these functions is **pure and synchronous** — no I/O, no clock, no randomness — so they can run inside the write path without any chance of a partial failure.

- [ ] **Step 4: Run focused verification**

Run: `pnpm vitest run tests/redaction.spec.ts && pnpm typecheck`

Expected: all tests PASS, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/redaction tests/redaction.spec.ts
git commit -m "feat: redact secrets and truncate output before persistence"
```

## Task 4: Private data directory, atomic writes, and the object store

**Files:**

- Create: `src/storage/paths.ts`
- Create: `src/storage/atomic.ts`
- Create: `src/storage/object-store.ts`
- Create: `tests/storage-atomic.spec.ts`
- Create: `tests/object-store.spec.ts`

**Interfaces:**

- Produces: `resolveDataRoot(config, env, homeDir): string`.
- Produces: `writeFileAtomic(targetPath: string, bytes: Uint8Array): Promise<void>`.
- Produces: `createObjectStore(root: string): ObjectStore` with `put(kind, bytes)`, `get(ref)`, `has(ref)`, `stat(ref)`, `listRefs()`.

**Pinned object kinds.** `kind` is a plain `string`, but this slice uses exactly one literal value and no others: `'activity-payload'` — the redacted, truncated tool and command output that Task 6 stores. Define it as a frozen `OBJECT_KINDS` constant and use the constant at the call site. `fileDigests` does *not* go here; it is a JSON column on `checkpoints` (see Task 5). A later Restore/Fork plan adds `'diff'` and `'snapshot'` by extending that one object.
- Produces: `ObjectRef = { ref: string; sha256: string; byteSize: number }`.

- [ ] **Step 1: Write the failing storage tests**

Path resolution:

- `resolveDataRoot` with an explicit `dataDir` returns it verbatim.
- With `dataDir` absent but `DSH_HOME` set, returns `<DSH_HOME>/turnscope`.
- With neither, returns `<homeDir>/.dsh/turnscope`.
- **Never** returns anything derived from `process.cwd()`, even when both `dataDir` and `DSH_HOME` are absent.

Atomic writes:

- `writeFileAtomic` creates the parent directory with mode `0o700` and the file with mode `0o600`.
- The target file's content equals the input bytes after the call.
- No `.tmp` sibling survives a successful write — assert the directory contains exactly the target file.
- Overwriting an existing file replaces its contents.

Object store:

- `put` returns a `ref` of the form `sha256:<64 lowercase hex>` and a `byteSize` equal to the input length.
- `put`ing identical bytes twice returns the **same** `ref` and does not create a second file — assert the object file count is unchanged.
- `get(ref)` returns bytes that are `toEqual` the originals for arbitrary binary input including a zero byte and a `0xFF` byte.
- `has` is `false` for an unknown ref; `get` on an unknown ref **rejects** with an error naming the ref.
- `get` on a ref whose stored bytes were corrupted on disk **rejects** with a hash-mismatch error rather than returning wrong bytes. Write a file by hand whose name is a valid-looking sha256 but whose content does not match.
- Object files are stored under a two-character prefix subdirectory and are mode `0o600`.
- `stat` on an unknown ref resolves to `undefined`, not a throw.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/storage-atomic.spec.ts tests/object-store.spec.ts`

Expected: FAIL because the storage modules do not exist.

- [ ] **Step 3: Implement the storage foundation**

`resolveDataRoot` resolves in exactly this order: an explicit absolute `config.dataDir`; else `join(env.DSH_HOME, 'turnscope')` when `DSH_HOME` is a non-empty absolute path; else `join(homeDir, '.dsh', 'turnscope')`. It must never consult `process.cwd()` — a cwd fallback would scatter data across every project the user opens. Return an absolute path always.

`writeFileAtomic` writes to a temp file in the **same directory** as the target (so the rename stays on one filesystem), named with a random suffix, created with `mode: 0o600` and the `'wx'` flag; `fsync`s the file handle, closes it, `rename`s over the target, then best-effort `fsync`s the containing directory. On any failure it removes the temp file and rethrows. Use `node:fs/promises` throughout.

`createObjectStore` computes `createHash('sha256')` over the input, forms the ref as `sha256:<hex>`, and stores bytes at `<root>/objects/<hex[0:2]>/<hex[2:]>`. `put` is idempotent: if the target already exists it returns the existing ref without rewriting. `get` reads the file, recomputes the hash, and rejects with a message naming the ref when the recomputed hash does not match the path-derived hash — this is the detection path for on-disk corruption and must not silently return the wrong bytes. Create directories with `0o700`.

- [ ] **Step 4: Run focused verification**

Run: `pnpm vitest run tests/storage-atomic.spec.ts tests/object-store.spec.ts && pnpm typecheck`

Expected: all tests PASS, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/storage/paths.ts src/storage/atomic.ts src/storage/object-store.ts tests/storage-atomic.spec.ts tests/object-store.spec.ts
git commit -m "feat: add plugin-private storage with atomic writes and content-addressed objects"
```

## Task 5: SQLite index and TraceRepository

**Files:**

- Create: `src/storage/schema.ts`
- Create: `src/storage/sqlite-index.ts`
- Create: `src/storage/repository.ts`
- Create: `tests/repository.spec.ts`

**Interfaces:**

- Produces: `TRACESCOPE_APPLICATION_ID = 1414035280` and `SCHEMA_VERSION`.
- Produces: `openIndex(dbPath: string): IndexHandle` with `db`, `close()`, and `migrate()`.
- Produces: `createRepository(handle: IndexHandle): TraceRepository`.
- Produces interface `TraceRepository` — the port the rest of the system consumes. **No module under `src/` outside `src/storage/` may import `node:sqlite`.** The rule binds production source only: a *test* may import the driver to forge a foreign fixture independently of the code under test, which is the stronger way to write that guard test.

```ts
export interface TraceRepository {
  upsertWorkspace(record: WorkspaceRecord): Promise<void>
  upsertSession(record: SessionRecord): Promise<void>
  upsertTurn(record: TurnRecord): Promise<void>
  closeTurn(turnId: string, status: TurnStatus, endedAt: number): Promise<void>
  listTurns(sessionId: string, limit: number): Promise<readonly TurnRecord[]>
  getTurn(turnId: string): Promise<TurnRecord | undefined>
  appendActivity(record: ActivityRecord): Promise<void>
  getActivities(turnId: string): Promise<readonly ActivityRecord[]>
  putCheckpoint(record: CheckpointRecord): Promise<void>
  getCheckpoint(id: string): Promise<CheckpointRecord | undefined>
  listCheckpoints(turnId: string): Promise<readonly CheckpointRecord[]>
  putObjectRecord(record: ObjectRecord): Promise<void>
  statObject(ref: string): Promise<ObjectRecord | undefined>
  referencedRefs(): Promise<readonly string[]>
  storageUsage(): Promise<{ readonly objectBytes: number; readonly objectCount: number }>
  close(): Promise<void>
}
```

- [ ] **Step 1: Write the failing repository tests**

Use a fresh `mkdtemp` directory per test and always close handles in `afterEach`.

- `openIndex` on a new path creates the schema; `listTurns` on an empty index returns `[]`.
- Round-trip: append a turn plus three activities, read them back with every field equal, including the optional ones absent.
- Ordering: `listTurns(sessionId, limit)` returns **newest first by `ordinal`**, and `limit` is honoured.
- `closeTurn` sets status and `endedAt`; a turn closed as `failed` reads back as `failed`.
- **Terminal-state protection:** calling `closeTurn` again with a different status after a terminal status must leave the original status intact.
- **Idempotency:** `appendActivity` with the same id twice leaves exactly one row.
- Restart recovery: write records, `close()` the handle, `openIndex()` the same path again, and confirm every record is readable.
- **Ownership guard:** pointing `openIndex` at a SQLite file created by something else — create a database with a different `application_id` and a `STRICT` table — **rejects** with an error mentioning a foreign database, and does not modify that file.
- **Corrupt-file guard:** pointing `openIndex` at a non-SQLite file (write `not a database` as bytes) rejects rather than throwing an opaque error.
- Transaction rollback: begin a transaction, insert rows, roll it back, and confirm none are visible.
- `referencedRefs` returns the union of object refs referenced by activities and checkpoints, de-duplicated.
- `storageUsage` sums object byte sizes and counts.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/repository.spec.ts`

Expected: FAIL because the storage modules do not exist.

- [ ] **Step 3: Implement the SQLite index**

`openIndex` mirrors the verified `dsh-session-query-sqlite` sequence:

1. `mkdir` the parent with `mode: 0o700`.
2. Create the file exclusively with the `'wx'` flag and `mode: 0o600` when it does not exist — this both hardens permissions and defeats symlink planting. Tolerate `EEXIST`.
3. `const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(actual)`.
4. Read `PRAGMA application_id` and `PRAGMA user_version`. If `application_id` is non-zero and is not `TRACESCOPE_APPLICATION_ID`, close and reject with a message naming the path and stating it belongs to another application. If it is `0` but the database already contains user tables, close and reject — that is someone else's file. On a fresh or own database, set `PRAGMA application_id = 1414035280`.
5. `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, `PRAGMA synchronous = NORMAL`.
6. Run migrations when `user_version` is below `SCHEMA_VERSION`; set `PRAGMA user_version` afterwards. A `user_version` **above** `SCHEMA_VERSION` must reject with "written by a newer version of Turnscope" rather than reading it.

Tables are `STRICT`, with `INTEGER` epoch-millisecond timestamps and `TEXT` ids, following `docs/ARCHITECTURE.md §4.1`: `workspaces`, `sessions`, `turns`, `activities`, `checkpoints`, `findings`, `forks`, `objects`. Create the `findings` and `forks` tables now even though this slice does not write them — the schema is versioned and adding tables later would force a migration. Index `activities(turn_id)`, `turns(session_id, ordinal)`, `checkpoints(turn_id)`, and `objects(sha256)`.

**Columns must correspond one-to-one with the Task 2 record fields — this is the contract, and a missing column is a defect, not a simplification.** In particular:

- `workspaces(id, repo_root, repo_root_hash, settings_json, created_at)`
- `sessions(id, workspace_id, upstream_session_id, parent_session_id, created_at)` — `parent_session_id` is nullable.
- `turns(id, session_id, ordinal, status, started_at, ended_at, activity_count, error_count, pre_checkpoint_id, post_checkpoint_id)` — `ended_at`, `pre_checkpoint_id` and `post_checkpoint_id` are nullable; `activity_count` and `error_count` are `INTEGER NOT NULL`.
- `activities(id, turn_id, session_id, parent_id, kind, phase, seq, label, occurred_at, payload_ref, truncated)` — `parent_id` and `payload_ref` nullable; `truncated` is `INTEGER NOT NULL` holding 0 or 1.
- `checkpoints(id, workspace_id, turn_id, phase, head_oid, branch, clean_start, index_digest, worktree_digest, file_digests, restorable, created_at, failure_reason)` — `head_oid`, `branch`, `index_digest`, `worktree_digest`, `file_digests` and `failure_reason` nullable; `clean_start` and `restorable` are `INTEGER NOT NULL` holding 0 or 1; `file_digests` holds the JSON-encoded `Record<string, string>`.
- `objects(ref, kind, byte_size, sha256, created_at)` — all `NOT NULL`.

Note there is deliberately **no `tree_ref` column**. `docs/ARCHITECTURE.md §4.1` lists one, but this slice performs zero Git writes and therefore never creates a tree object to reference. A later Restore/Fork plan that needs it adds the column with a schema migration, which is exactly what the versioned schema is for. Do not add a column that nothing in this slice can populate.

Map SQL `NULL` onto the record's explicit `undefined` for `TurnRecord.endedAt` (which Task 2 declared `number | undefined` under `exactOptionalPropertyTypes`) — a round-trip of a turn with no `ended_at` must read back with `endedAt === undefined`, not `null`.

`closeTurn` implements the terminal-state rule in SQL: `UPDATE turns SET status = ?, ended_at = ? WHERE id = ? AND status NOT IN ('completed','failed','interrupted')`. Let the database enforce it rather than reading first and racing.

`createRepository` wraps the synchronous `DatabaseSync` API in `async` methods (the port is async so a future backend can be too) and uses `db.exec('BEGIN IMMEDIATE')` / `COMMIT` / `ROLLBACK` around multi-statement writes, matching the shipped pattern.

- [ ] **Step 4: Run focused verification**

Run: `pnpm vitest run tests/repository.spec.ts && pnpm typecheck`

Expected: all tests PASS, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts src/storage/sqlite-index.ts src/storage/repository.ts tests/repository.spec.ts
git commit -m "feat: persist trace records in a plugin-private SQLite index"
```

## Task 6: Event adapter, turn assembler, and subscription

**Files:**

- Create: `src/adapter/normalize.ts`
- Create: `src/adapter/assembler.ts`
- Create: `src/adapter/subscribe.ts`
- Create: `src/trace-core.ts`
- Create: `tests/assembler.spec.ts`
- Create: `tests/trace-core.spec.ts`
- Modify: `src/index.ts`

**Interfaces:**

- Consumes: `TraceRepository`, `Diagnostics`, `redact`, `truncateBytes`, `TurnscopeConfig`.
- Produces: `normalizeEvent(sessionId, workspaceId, event, config): NormalizedEvent | undefined`.
- Produces: `createTurnAssembler()` with `ingest(event: NormalizedEvent): AssemblerOutput` where `AssemblerOutput = { readonly turns: readonly TurnRecord[]; readonly activities: readonly ActivityRecord[]; readonly ignored: boolean }`.
- Produces: `startTraceCore(ctx, config, diagnostics): Promise<{ stop(): Promise<void> }>`.
- Produces: `describeLabel(normalized): string` — user-facing activity text that never contains a raw payload.

- [ ] **Step 1: Write the failing assembler tests**

Feed real-shaped `SessionEvent` objects (copy the dumps from the Reference section) through `normalizeEvent` and then the assembler. Assert:

- A `turn/start` alone produces one turn record with status `running` and `ordinal` equal to the event's `turn`.
- A full completed sequence — `turn/start`, `user/message`, `step/start`, `tool/call`, `tool/result`, `assistant/message`, `step/end`, `turn/end{reason:{kind:'completed'}}` — produces exactly one turn, closed as `completed`, with the expected activity kinds in `seq` order and `errorCount` of 0.
- A `tool/result` whose `isError` is `true` increments `errorCount` and yields an activity with phase `failed`.
- Each `turn/end` reason maps as specified: `completed`→`completed`; `error`→`failed`; `blocked`→`failed`; `max-tokens`→`failed`; `interrupted`→`interrupted`; `aborted`→`interrupted`.
- A late `turn/end{completed}` arriving **after** the turn was closed `interrupted` does **not** change the status, and the extra activity is still appended.
- **Unknown events:** an event with `type: 'vendor/custom'` produces `ignored: true`, no activities, and does not throw. A second such event is counted in diagnostics by type name.
- **Malformed upstream data:** `turn/start` with `data` missing the `turn` field, `tool/result` with no `message`, and an event whose `data` is `null` are each ignored rather than throwing.
- **Out-of-order:** a `tool/result` for turn 2 arriving before its `turn/start` is buffered, then emitted with turn 2's records once `turn/start` arrives. Assert the activity's `turnId` ends up correct.
- **Buffer bound:** feeding 1,000 orphaned events never grows the buffer past the documented ceiling, and none of them throws.
- Redaction: a `tool/result` whose text content contains `sk-` + 24 characters produces an activity whose `payloadRef` points at a stored object, and **no string anywhere in the assembler output or the stored object contains the secret**. Recompute the stored object's bytes and assert the secret substring is absent.
- Truncation: a tool result larger than `maxOutputBytes` is stored truncated, and the activity carries `truncated: true` with the true `originalBytes`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/assembler.spec.ts`

Expected: FAIL because the adapter modules do not exist.

- [ ] **Step 3: Implement the adapter**

`normalizeEvent` switches on `event.type` and returns `undefined` for anything it does not recognise — a total function with a `default` arm, never a throw. The mapping is:

| Upstream `type` | `kind` | `phase` |
| --- | --- | --- |
| `turn/start` | `turn` | `started` |
| `turn/end` | `turn` | `completed` / `failed` / `interrupted` per `reason.kind` |
| `step/start` | `model` | `started` |
| `step/end` | `model` | `completed` |
| `user/message` | `system` | `updated` |
| `assistant/message` | `model` | `completed` |
| `tool/call` | `tool` | `started` |
| `tool/result` | `tool` | `failed` when `message.content[].isError`, else `completed` |
| `approval/asked` / `approval/decided` | `approval` | `started` / `completed` |
| `compaction/*` | `system` | `updated` |

Guard every field access: `data` may be `null`, arrays may be missing, `arguments` is a raw JSON string that must never be `JSON.parse`d during normalization (parse failures are a recorded diagnostic, not a crash). Set `occurredAt` from `event.time` converted to an ISO-8601 string.

`createTurnAssembler` is a closure holding only in-memory state: a map of open turns and a bounded buffer (ceiling 256) of events whose turn is not yet known. `ingest` returns the records to persist and performs no I/O — that separation is what makes the state machine testable without a database. The buffer is keyed by `sessionId:turn`; on `turn/start` the buffer for that key drains and its events are emitted with correct ids. When the buffer is at its ceiling, the oldest entry is dropped and a diagnostic recorded — the turn itself is still created, so no turn is ever lost.

**This layer owns the transition graph, not just terminal absorption.** Task 2's `transitionTurn` is deliberately permissive: it returns `next` whenever `current` is non-terminal, so `pending -> failed` is allowed there and the diagram in `docs/ARCHITECTURE.md §3.3` is *not* validated at that layer. The assembler is what decides which transitions actually occur — it emits `running` on `turn/start` and a terminal status only on `turn/end`. Do not assume an illegal transition has been filtered out upstream of you, and do not rely on `transitionTurn` to reject anything beyond a post-terminal update.

**Guard the terminal state before every `upsertTurn` — this is a live hazard, not a theoretical one.** `TraceRepository.upsertTurn` is a plain last-write-wins upsert and deliberately does *not* apply the terminal-state rule; only `closeTurn` does (in SQL). So if the assembler replays an older, non-terminal `TurnRecord` for a turn that has since been closed — a late or duplicated event, a buffered event draining after `turn/end` — the upsert will **resurrect the closed turn** and silently revert its status. Apply `transitionTurn(existing.status, incoming.status)` and carry the existing status forward before writing. The index deliberately does not do this for you because a blanket DB-side rule would also discard the non-status fields (`activity_count`, `error_count`) the assembler is legitimately updating. Add a test that closes a turn and then re-upserts a stale `running` record, asserting the status stays terminal.

`describeLabel` produces short user-facing text from the normalized event's kind and the upstream tool or command name — for example `Tool: read_file`, `Turn failed`, `Step 2`. It reads **only** names and identifiers, never payload text, so a label can never leak a secret even if redaction were bypassed.

- [ ] **Step 4: Wire the subscription**

```ts
// src/adapter/subscribe.ts — the shape that is proven to work
export function subscribeSessionEvents(ctx: Context, onEvent: SessionObserver): () => void {
  const listener = (session: Session, event: SessionEvent): void => {
    try {
      onEvent(session, event)
    } catch (error) {
      // fail-open: one bad event must not detach the listener
    }
  }
  return ctx.on('session/event', listener)
}
```

Register with `ctx.on` on the context `apply` receives. **Do not** wrap this in a scope-tagged composition — a scoped listener observes nothing. The whole callback body is wrapped in `try/catch` so a single malformed event cannot break the subscription for the rest of the session.

`startTraceCore` composes the pieces: resolve the data root, open the index, run migrations, build the repository, subscribe, and return a `stop()` that unsubscribes, flushes, and closes the handle. Every step is wrapped so that a failure at any point returns a no-op core and records a diagnostic instead of throwing — the plugin must remain loaded and inert rather than take the harness down. Redaction runs on every string payload **before** it is handed to the object store; the object store never sees unredacted bytes.

Update `src/index.ts` to call `startTraceCore` inside its existing `try/catch` and to register the returned `stop` on `ctx.effect` so the resources are released with the plugin's fiber.

- [ ] **Step 5: Write and pass the end-to-end core test**

`tests/trace-core.spec.ts` mounts a real `Context` with the real `SessionStore` and the real plugin, then drives a complete turn through `ctx.sessions.create(...).append(...)` and asserts the records landed in the repository:

```ts
const ctx = new Context()
await ctx.plugin(SessionStore).await()
const fiber = ctx.plugin({ name, apply }, { dataDir: tmpDir })
await fiber.await()

const session = ctx.sessions.create('s-e2e', { meta: { cwd: tmpDir } })
session.append('turn/start', { turn: 0 })
session.append('step/start', { turn: 0, step: 0 })
session.append('tool/call', { turn: 0, step: 0, callId: 'c1', name: 'read_file', arguments: '{}' })
session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
await flush()
```

Assert one turn row read back as `completed`. Then assert the **fail-open** property directly: point the plugin at an unwritable `dataDir`, mount it, drive a turn, and confirm the session still accepts events and the plugin is loaded but inert.

Because writes are asynchronous, `flush()` awaits a settled microtask plus a short timeout rather than a fixed sleep; if the implementation exposes a `flush()` on the core, await that instead.

- [ ] **Step 6: Run focused verification**

Run: `pnpm vitest run tests/assembler.spec.ts tests/trace-core.spec.ts && pnpm typecheck && pnpm test`

Expected: all tests PASS including the pre-existing suites, typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/adapter src/trace-core.ts src/index.ts tests/assembler.spec.ts tests/trace-core.spec.ts
git commit -m "feat: record session turns and activities through the host event firehose"
```

## Task 7: GitPort, workspace observation, and checkpoints

**Files:**

- Create: `src/git/command-runner.ts`
- Create: `src/git/git-port.ts`
- Create: `src/git/checkpoint.ts`
- Create: `tests/git-port.spec.ts`
- Create: `tests/checkpoint.spec.ts`

**Interfaces:**

- Produces: `createExecFileRunner(): CommandRunner` with `run(command, args, options): Promise<CommandResult>`.
- Produces: `createGitPort(runner: CommandRunner): GitPort`.
- Produces: `createCheckpoint(port, input): Promise<CheckpointRecord>` — total, never throws.

```ts
export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string },
  ): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>
}

export interface GitPort {
  resolveRoot(cwd: string): Promise<string | undefined>
  head(cwd: string): Promise<string | undefined>
  branch(cwd: string): Promise<string | undefined>
  isRepository(cwd: string): Promise<boolean>
  isClean(cwd: string): Promise<boolean>
  statusEntries(cwd: string): Promise<readonly GitStatusEntry[]>
  fileDigests(cwd: string, paths: readonly string[]): Promise<ReadonlyMap<string, string>>
  worktreeDigest(cwd: string): Promise<string | undefined>
  indexDigest(cwd: string): Promise<string | undefined>
}
```

- [ ] **Step 1: Write the failing Git tests**

Every test builds a **real temporary repository** with `mkdtemp` + `git init` and configures `user.email`/`user.name` locally so commits work. Skip nothing — these are hermetic.

`CommandRunner`:

- Runs `git --version` and returns exit code 0 with non-empty stdout.
- A non-zero exit resolves with the real `exitCode` and captured `stderr` — it does **not** reject.
- An argument containing shell metacharacters such as `; touch /tmp/pwned` is passed through as a literal argument and creates no file. **This is the injection test — make it explicit.**

`GitPort`:

- `isRepository` is `true` inside a temp repo and `false` in a bare temp directory.
- `resolveRoot` returns the toplevel path from a nested subdirectory.
- `head` returns the 40-character commit oid after an initial commit, and `undefined` in a repo with no commits.
- `branch` returns the current branch name.
- `isClean` is `true` right after a commit; `false` after modifying a tracked file; `false` with an untracked file.
- `statusEntries` distinguishes modified, added, deleted, and renamed (perform a real `git mv`) — parse `--porcelain=v1 -z` so paths with spaces survive intact.
- `fileDigests` returns a stable digest per path that **changes** when content changes and is **identical** across two calls with unchanged content. Implement it with `git hash-object --stdin`, feeding content over stdin — there must be **no `-w` flag**, and a test asserts no new loose object was created by counting `.git/objects` entries before and after.
- `worktreeDigest` and `indexDigest` are stable across repeated calls on unchanged state.

Checkpoints:

- `createCheckpoint` on a clean repo returns a record with `restorable: true`, the real `headOid`, the real `branch`, `cleanStart: true`, and non-empty digests.
- On a **dirty** repo it returns `cleanStart: false` and `restorable: false`, while still recording the observation. This is `docs/PRD.md FR-05`: a workspace with pre-existing changes gets observation only.
- Outside a repository it returns a record with `restorable: false` and a `failureReason` — it does not throw.
- **The central safety assertion:** snapshot `git rev-parse HEAD`, `git symbolic-ref --short HEAD`, `git status --porcelain=v1 -z`, and the full `.git/objects` entry count before and after `createCheckpoint`; all four must be byte-identical. Also assert `.git/refs` and `.git/index` mtimes are unchanged where the filesystem reports them reliably, and that no new ref, tag, or commit exists.
- Two checkpoints for the same turn and phase are distinguishable (`pre` vs `post`) and each carries a stable id.
- A `CommandRunner` that always fails produces a checkpoint with `restorable: false` and a `failureReason`, and **never throws** — this is the checkpoint-failure half of the PRD acceptance criterion.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/git-port.spec.ts tests/checkpoint.spec.ts`

Expected: FAIL because the git modules do not exist.

- [ ] **Step 3: Implement the GitPort**

```ts
// src/git/command-runner.ts
import { execFile } from 'node:child_process'

export function createExecFileRunner(): CommandRunner {
  return {
    run: (command, args, options) => new Promise(resolve => {
      // argv array only — no shell, so no interpolation and no metacharacter risk
      execFile(command, [...args], { cwd: options.cwd, shell: false, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const exitCode = error === null
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : 1
          resolve({ stdout: String(stdout), stderr: String(stderr), exitCode })
        })
    }),
  }
}
```

Note the deliberate choices: `shell: false` so no argument is ever reinterpreted; a non-zero exit **resolves** so callers branch on `exitCode` rather than on exceptions; and a bounded `maxBuffer` so a pathological repository cannot exhaust memory.

`createGitPort` builds only `git` argv arrays — `['rev-parse', '--show-toplevel']`, `['rev-parse', 'HEAD']`, `['symbolic-ref', '--short', '-q', 'HEAD']`, `['status', '--porcelain=v1', '-z']`, `['hash-object', '--stdin']`. There is no string concatenation anywhere in the module; the only literal argument lists are constants. Parse `-z` output by splitting on `\0` and reading the two-character status code, handling the rename form (`R` is followed by two NUL-terminated paths). Treat a non-zero `git` exit as "not available" and return `undefined` rather than a partial value — a repository in a conflicted or unusual state must degrade, not lie.

`fileDigests` reads each file through `node:fs/promises` and pipes the bytes to `git hash-object --stdin`. Deliberately **without** `-w`: the hash is computed but nothing is written into the object database, so checkpointing cannot grow or alter the user's repository.

**Conversion point you must implement here.** `GitPort.fileDigests` returns a `ReadonlyMap<string, string>`, but `CheckpointRecord.fileDigests` is a `Readonly<Record<string, string>>` because the record is JSON-serialized into SQLite (a `Map` would silently serialize to `{}`). `createCheckpoint` owns that conversion — `Object.fromEntries(map)` — and a test must assert the stored record round-trips through `JSON.parse(JSON.stringify(...))` with the digests intact.

**Checkpoint ids come from `checkpointIdFor(turnId, phase)`** (Task 2) — never hand-build one.

- [ ] **Step 4: Implement checkpoint creation**

`createCheckpoint(port, { workspaceId, turnId, phase, cwd })` gathers repo root, HEAD, branch, cleanliness, index digest, worktree digest, and per-changed-file digests, then assembles a `CheckpointRecord` with `restorable = cleanStart && everyObservationSucceeded`. It is **total**: every internal failure path produces a record with `restorable: false` and a `failureReason` string, never a rejection. That is what lets a failing checkpoint mark a single turn as non-restorable instead of interrupting the agent.

- [ ] **Step 5: Wire checkpoints into the turn lifecycle**

Extend `startTraceCore` so a `turn/start` triggers a `pre` checkpoint and a `turn/end` triggers a `post` checkpoint, using the session's `header.cwd` as the repository working directory. Persist each through `putCheckpoint` and record the resulting ids on the turn via `upsertTurn`. Both calls run off the event-handling path (do not await them inside the subscriber's synchronous body in a way that can throw into the harness) and are individually wrapped so a Git failure cannot affect event recording.

- [ ] **Step 6: Run focused verification**

Run: `pnpm vitest run tests/git-port.spec.ts tests/checkpoint.spec.ts tests/trace-core.spec.ts && pnpm typecheck`

Expected: all tests PASS, typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/git src/trace-core.ts tests/git-port.spec.ts tests/checkpoint.spec.ts
git commit -m "feat: observe the workspace and record turn checkpoints"
```

## Task 8: Retention, diagnostics, and documentation

**Files:**

- Create: `src/storage/retention.ts`
- Create: `tests/retention.spec.ts`
- Modify: `src/trace-core.ts`
- Modify: `README.md`

**Interfaces:**

- Produces: `selectEvictions(entries, limits): readonly string[]` — pure.

```ts
export interface RetentionEntry {
  readonly ref: string
  readonly byteSize: number
  readonly createdAt: number
  readonly pinned: boolean
}
export function selectEvictions(
  entries: readonly RetentionEntry[],
  limits: { readonly now: number; readonly retentionDays: number; readonly retentionBytes: number },
): readonly string[]
```

- [ ] **Step 1: Write the failing retention tests**

`selectEvictions` is a pure function — test it exhaustively without any filesystem:

- Under both limits: evicts nothing.
- Over the age limit only: evicts exactly the entries older than `now - retentionDays * 86_400_000`, oldest first.
- Over the size limit only: evicts oldest-first until the surviving total is at or below `retentionBytes`.
- Over both: the union, de-duplicated.
- **Pinned entries are never returned**, even when they are the oldest and largest — assert that a pinned 1 GB entry is retained while older unpinned entries are evicted, and that the result still satisfies the size limit computed over unpinned survivors only.
- An empty input, a zero limit, and a `retentionBytes` smaller than a single entry all behave predictably without throwing.
- The result is deterministic: two calls with identical input return identical arrays in identical order.

Plus one integration assertion in `tests/trace-core.spec.ts`: a core started against a directory seeded with an already-expired object removes it, while an object still referenced by an **activity** (via `activities.payload_ref`) survives. Do not write this against a checkpoint row: in this slice `CheckpointRecord` carries only Git-derived fingerprints (`indexDigest`, `worktreeDigest`, `fileDigests`), never a `sha256:` object ref, and `OBJECT_KINDS` admits only `'activity-payload'`. `referencedRefs()` therefore unions over `activities.payload_ref` alone, and the checkpoint arm is empty by construction. A later Restore/Fork plan that makes a checkpoint own a content object extends that union with its schema migration.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/retention.spec.ts`

Expected: FAIL because `src/storage/retention.ts` does not exist.

- [ ] **Step 3: Implement retention and finish the core**

`selectEvictions` is pure and total. Collect the set of expired-or-over-limit candidates, remove every `pinned` entry, sort by `createdAt` ascending (ties broken by `ref` so the order is fully deterministic), and take entries until the survivors satisfy both limits. A `pinned` entry means "referenced by a checkpoint or a fork", computed by the caller from `referencedRefs()`, not by this function.

Wire a retention sweep into `startTraceCore`: run once after startup and after each `post` checkpoint. Pin every ref returned by `repository.referencedRefs()`. Delete evicted objects from the object store and their `objects` rows. **Add `deleteObject(ref): Promise<void>` to the `TraceRepository` port for that row deletion** — do not reach through `IndexHandle.db` with raw SQL. Retention is a storage concern and the port is where it belongs; keeping the statements behind the port is also what stops the row-deletion SQL from drifting out of sync with the column constants. **The sweep may only ever delete inside the object store directory** — it must never touch `worktrees/`, the SQLite file, or anything outside the plugin's own data root. Enforce this by constructing every deletion path from the object store's own root and rejecting any candidate that does not resolve inside it.

Finally, complete the diagnostics requirement of `docs/PRD.md FR-11`: expose plugin version, the resolved data root, storage usage, enabled state, and the most recent bounded errors through `diagnostics.snapshot()`. Every diagnostic message must already be redacted — pass it through `redact` at the `record` call site, and add a test asserting that recording a message containing a fake key stores the masked form.

- [ ] **Step 4: Update the README**

Add a short status section that is honest about what exists: the package is an unreleased development build; it now has a host half that records turns locally; Restore and Fork are **not** implemented; there is no published install command. Document the data directory (`<DSH_HOME>/turnscope` by default, overridable via config `dataDir`), the default retention limits (30 days / 100 MiB), and the two commands developers actually have:

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

Do not document a local DSH loading procedure that has not been smoke-tested.

- [ ] **Step 5: Run full verification**

Run: `pnpm install --frozen-lockfile && pnpm build && pnpm test && pnpm typecheck && git diff --check`

Expected: every command exits 0 and all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/storage/retention.ts src/trace-core.ts tests/retention.spec.ts README.md
git commit -m "feat: add retention, diagnostics, and record-only status documentation"
```

---

## Final Verification

Run from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
git diff --check
git status --short
```

Then confirm the safety properties by inspection, since they are the point of this slice:

1. `grep -rn "reset --hard\|checkout\|write-tree\|hash-object -w\|git tag\|git commit" src/` returns **no** Git-mutating invocation.
2. `grep -rn "exec(\|execSync\|shell: true\|sh -c" src/` returns **no** shell execution path.
3. `grep -rln "node:sqlite" src/` matches only files under `src/storage/`.
4. A deliberately corrupted data directory (unwritable path, or a foreign SQLite file at the index path) leaves the harness running and the plugin loaded but inert.

## Out of Scope For This Plan

Explicitly deferred, each its own later plan: the Restore engine (safety checks, reverse-diff preview, recovery checkpoint, atomic apply), the Fork engine (managed worktrees, linked sessions, cleanup), the deterministic rule engine and `FindingRecord` production, the settings and diagnostics UI, the code-change inspector in the existing client panel, and any wiring of `GitPort` to DSH's sandbox-aware `ctx.shell` rather than the local `execFile` runner.
