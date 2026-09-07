# Native Turn Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first installable dsh-turnscope slice: a DSH-native TypeScript plugin that registers a read-only Turnscope conversation view and summarizes the current session by turn.

**Architecture:** The package follows DSH's dual-face plugin contract: an empty Node/Host `apply()` lets Cordis load the package, while the manifest's `dsh.client` declaration exposes a browser `apply(ctx)` that registers into `conversation.view`. The view consumes the framework-owned `ConversationSnapshot` through the slot-standard `useSession` hook and derives immutable `TurnModel` values with a pure function; this slice performs no Git writes, creates no database, and sends no telemetry.

**Tech Stack:** TypeScript 6.0.3, Node.js 22.19+, pnpm 11.7, React 18.2, Cordis 4.0.2, DSH public packages 0.1.1-rc.2, tsdown 0.22.2, Vitest 4.1.8, Testing Library 16.3.

## Global Constraints

- Package name is `@zhaolianghz/dsh-turnscope` and all source is ESM.
- The first supported DSH baseline is exactly `0.1.1-rc.2`; do not claim compatibility with other versions.
- The client registers only through public DSH services and the `conversation.view` slot.
- The Node entry has no side effects; all client registrations must be disposed with their Cordis fiber.
- The view is read-only: no Git commands, filesystem writes, SQLite, Restore, or Fork in this plan.
- No network access and no telemetry are introduced.
- Unknown future conversation-node kinds degrade to an `unknown` activity instead of throwing.
- User-facing copy ships in Simplified Chinese and English through the DSH locale service.
- Tests are written before implementation and every task ends in a passing focused test plus a commit.

---

## File Map

```text
package.json                         Package metadata, DSH client manifest, scripts and versions
pnpm-lock.yaml                       Reproducible dependency graph
tsconfig.json                        Strict TypeScript build for src and tests
tsdown.config.ts                     Node ESM and DSH browser-handoff bundles
src/index.ts                         Side-effect-free Host Cordis entry
src/client/index.ts                  Client Cordis registration and locale mount
src/client/locales.ts                zh/en dictionary and namespace typing
src/client/turn-model.ts             Pure ConversationSnapshot -> TurnModel projection
src/client/styles.ts                 Cordis-scoped style installation and removal
src/client/TurnscopeView.tsx         Session-bound view states and turn list
tests/host-plugin.spec.ts            Host entry and manifest contract
tests/turn-model.client.spec.ts      Turn grouping, status and unknown-kind behavior
tests/client-plugin.client.spec.tsx  Real Cordis/SlotRegistry registration and disposal
tests/view.client.spec.tsx           Loading, empty, complete, running and failed UI states
tests/client-bundle.client.spec.ts   Built handoff artifact contract
examples/cordis.patch.yml            Local DSH profile patch example
README.md                            Honest development and local-loading instructions
```

## Task 1: Bootstrap the DSH dual-face package

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsdown.config.ts`
- Create: `src/index.ts`
- Create: `tests/host-plugin.spec.ts`
- Modify: `.gitignore`

**Interfaces:**

- Produces: Host export `apply(): void`.
- Produces: package export `./client` backed by `lib/client.js`.
- Produces: manifest declaration `dsh.client.platform = "web"`.

- [ ] **Step 1: Add the package contract test**

```ts
// tests/host-plugin.spec.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('host plugin contract', () => {
  it('has a side-effect-free host apply', () => {
    expect(apply()).toBeUndefined()
  })

  it('declares the native DSH web client face', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(manifest.dsh.client).toEqual({
      inject: [
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-conversation',
      ],
      platform: 'web',
    })
    expect(manifest.exports['./client'].default).toBe('./lib/client.js')
  })
})
```

- [ ] **Step 2: Create package metadata and run the test to verify the missing entry fails**

Use exact dependency versions:

```json
{
  "name": "@zhaolianghz/dsh-turnscope",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-conversation"
      ],
      "platform": "web"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json && tsdown",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "4.0.2",
    "@deepseek-ai/dsh-client-locale": "0.1.1-rc.2",
    "@deepseek-ai/dsh-client-runtime": "0.1.1-rc.2",
    "@deepseek-ai/dsh-client-ui-conversation": "0.1.1-rc.2",
    "react": "18.2.0"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "4.0.2",
    "@deepseek-ai/dsh-client-locale": "0.1.1-rc.2",
    "@deepseek-ai/dsh-client-runtime": "0.1.1-rc.2",
    "@deepseek-ai/dsh-client-test-runtime": "0.1.1-rc.2",
    "@deepseek-ai/dsh-client-ui-conversation": "0.1.1-rc.2",
    "@deepseek-ai/dsh-client-ui-slots": "0.1.1-rc.2",
    "@testing-library/react": "16.3.2",
    "@types/node": "22.20.0",
    "@types/react": "18.3.27",
    "@types/react-dom": "18.3.7",
    "react": "18.2.0",
    "react-dom": "18.2.0",
    "tsdown": "0.22.2",
    "typescript": "6.0.3",
    "vitest": "4.1.8"
  },
  "engines": { "node": ">=22.19.0" },
  "packageManager": "pnpm@11.7.0",
  "license": "MIT"
}
```

Run: `pnpm install && pnpm vitest run tests/host-plugin.spec.ts`

Expected: FAIL because `src/index.ts` does not exist.

- [ ] **Step 3: Add the minimal Host entry and strict compiler config**

```ts
// src/index.ts
/** Host loader entry; this first slice is browser-only. */
export function apply(): void {}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "declarationMap": true,
    "outDir": "lib/types",
    "rootDir": "src",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "tests"]
}
```

Add a two-entry `tsdown.config.ts`: Node ESM from `lib/types/index.js` to `lib/index.js`, and browser CJS from `lib/types/client/index.js`; keep React and all `@deepseek-ai/*` imports external. Task 5 adds and verifies the exact ModuleLoader wrapper after the unwrapped baseline is proven to fail.

- [ ] **Step 4: Run focused verification**

Run: `pnpm vitest run tests/host-plugin.spec.ts && pnpm typecheck`

Expected: 2 tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json tsdown.config.ts src/index.ts tests/host-plugin.spec.ts .gitignore
git commit -m "build: bootstrap native DSH plugin package"
```

## Task 2: Derive stable turn summaries from ConversationSnapshot

**Files:**

- Create: `src/client/turn-model.ts`
- Create: `tests/turn-model.client.spec.ts`

**Interfaces:**

- Consumes: `ConversationSnapshot` from `@deepseek-ai/dsh-client-runtime/client`.
- Produces: `deriveTurnModels(snapshot: ConversationSnapshot): readonly TurnModel[]`.
- Produces: `TurnModel` and `ActivityModel` types used only by the client view.

- [ ] **Step 1: Write failing grouping and status tests**

Build minimal typed fixtures with `as ConversationSnapshot` covering:

```ts
import type { ConversationNode, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

const snapshotWith = (
  nodes: readonly ConversationNode[],
  turnTimings: ConversationSnapshot['turnTimings'],
  turnEnds: ConversationSnapshot['turnEnds'] = new Map([[1, 5]]),
): ConversationSnapshot => ({ nodes, turnTimings, turnEnds } as unknown as ConversationSnapshot)

expect(deriveTurnModels(snapshotWith([
  { kind: 'assistant', seq: 2, turn: 1, step: 1, time: 120, blocks: [] },
  {
    kind: 'tool-result', seq: 4, time: 150, callId: 'c1', call: null,
    callTime: 130, content: [], isError: true, callView: null, resultView: null, subCalls: [],
  },
  { kind: 'turn-error', seq: 5, turn: 1, step: 1, time: 160, message: 'failed' },
], new Map([[1, { startTime: 100, endTime: 160 }]])))).toEqual([expect.objectContaining({
  turn: 1,
  status: 'failed',
  durationMs: 60,
  toolCount: 1,
  errorCount: 1,
})])
```

Also test an open timing becomes `running`, a closed turn without error becomes `completed`, results are newest-first, and an unknown node kind becomes an `unknown` activity instead of throwing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/turn-model.client.spec.ts`

Expected: FAIL because `deriveTurnModels` does not exist.

- [ ] **Step 3: Implement the pure projection**

```ts
import type { ConversationNode, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

export type TurnStatus = 'running' | 'completed' | 'failed' | 'max-tokens'

export interface ActivityModel {
  readonly id: string
  readonly seq: number
  readonly kind: 'user' | 'assistant' | 'tool' | 'command' | 'error' | 'max-tokens' | 'system' | 'unknown'
  readonly label: string
  readonly time: number
}

export interface TurnModel {
  readonly turn: number
  readonly status: TurnStatus
  readonly startedAt: number
  readonly endedAt?: number
  readonly durationMs?: number
  readonly toolCount: number
  readonly errorCount: number
  readonly activities: readonly ActivityModel[]
}

function activityFromNode(node: ConversationNode): ActivityModel {
  const base = { id: `${node.kind}:${node.seq}`, seq: node.seq, time: node.time }
  switch (node.kind) {
    case 'user': return { ...base, kind: 'user', label: 'User message' }
    case 'assistant': return { ...base, kind: 'assistant', label: `Assistant step ${node.step}` }
    case 'tool-result': return {
      ...base, kind: 'tool', label: `Tool: ${node.call?.name ?? node.callId}`,
    }
    case 'command': return {
      ...base, kind: 'command', label: `Command: /${node.name ?? 'unknown'}`,
    }
    case 'turn-error': return { ...base, kind: 'error', label: 'Turn failed' }
    case 'turn-max-tokens': return { ...base, kind: 'max-tokens', label: 'Token limit reached' }
    case 'context': return { ...base, kind: 'system', label: 'Context' }
    case 'steering': return { ...base, kind: 'user', label: 'Steering message' }
    case 'model-retry': return { ...base, kind: 'system', label: 'Model retry' }
    case 'compaction': return { ...base, kind: 'system', label: 'Compaction' }
    case 'unknown': return { ...base, kind: 'unknown', label: `Unknown: ${node.type}` }
    default: {
      const future = node as { kind?: unknown; seq: number; time: number }
      return {
        id: `unknown:${future.seq}`,
        seq: future.seq,
        time: future.time,
        kind: 'unknown',
        label: `Unknown: ${String(future.kind ?? 'event')}`,
      }
    }
  }
}

export function deriveTurnModels(snapshot: ConversationSnapshot): readonly TurnModel[] {
  const endSeqs = [...snapshot.turnEnds.entries()].sort((a, b) => a[1] - b[1])
  const openTurn = [...snapshot.turnTimings.keys()].sort((a, b) => b - a)
    .find(turn => !snapshot.turnEnds.has(turn))
  const turnForSeq = (seq: number): number | undefined =>
    endSeqs.find(([, endSeq]) => seq <= endSeq)?.[0] ?? openTurn
  const groups = new Map<number, ConversationNode[]>()
  for (const node of snapshot.nodes) {
    const explicit = 'turn' in node && typeof node.turn === 'number' ? node.turn : undefined
    const turn = explicit ?? turnForSeq(node.seq)
    if (turn === undefined || !snapshot.turnTimings.has(turn)) continue
    const group = groups.get(turn) ?? []
    group.push(node)
    groups.set(turn, group)
  }
  return [...snapshot.turnTimings.entries()].map(([turn, timing]): TurnModel => {
    const nodes = groups.get(turn) ?? []
    const activities = nodes.map(activityFromNode)
    const hasTurnError = nodes.some(node => node.kind === 'turn-error')
    const hasMaxTokens = nodes.some(node => node.kind === 'turn-max-tokens')
    const status: TurnStatus = hasTurnError
      ? 'failed'
      : hasMaxTokens
        ? 'max-tokens'
        : timing.endTime === undefined ? 'running' : 'completed'
    const errorCount = nodes.filter(node =>
      node.kind === 'turn-error'
      || (node.kind === 'tool-result' && node.isError)
      || (node.kind === 'command' && node.outcome?.kind === 'error')).length
    return Object.freeze({
      turn,
      status,
      startedAt: timing.startTime,
      ...(timing.endTime === undefined
        ? {}
        : { endedAt: timing.endTime, durationMs: Math.max(0, timing.endTime - timing.startTime) }),
      toolCount: nodes.filter(node => node.kind === 'tool-result').length,
      errorCount,
      activities: Object.freeze(activities),
    })
  }).sort((a, b) => b.turn - a.turn)
}
```

Do not inspect tool content or persist payloads. The `default` guard is intentional: DSH's event model is merge-extensible, so a future runtime kind must remain visible instead of crashing the view.

- [ ] **Step 4: Run focused verification**

Run: `pnpm vitest run tests/turn-model.client.spec.ts && pnpm typecheck`

Expected: all turn-model tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/client/turn-model.ts tests/turn-model.client.spec.ts
git commit -m "feat: derive read-only turn summaries"
```

## Task 3: Register the native conversation view

**Files:**

- Create: `src/client/locales.ts`
- Create: `src/client/styles.ts`
- Create: `src/client/index.ts`
- Create: `tests/client-plugin.client.spec.tsx`

**Interfaces:**

- Consumes: Cordis `Context`, DSH `SlotRegistry`, `sessions`, and `locale`.
- Produces: `inject = ['slots', 'sessions', 'locale']`.
- Produces: a `conversation.view` entry with id `turnscope`, order `20`, localized label, and session-scoped rendering.

- [ ] **Step 1: Write the failing registration/disposal test**

Use a real Cordis `Context`, mount `SlotRegistry`, declare a root `conversation.view` list slot, provide a fake `sessions` face and DSH locale runtime, then assert:

```ts
const fiber = ctx.plugin({ inject: [...inject], apply })
await fiber.await()
expect(ctx.slots.entries('conversation.view')[0]?.options).toMatchObject({
  id: 'turnscope', order: 20,
})
await fiber.dispose()
expect(ctx.slots.entries('conversation.view')).toHaveLength(0)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/client-plugin.client.spec.tsx`

Expected: FAIL because the client plugin files do not exist.

- [ ] **Step 3: Add locale types and client registration**

```ts
// src/client/locales.ts
export const NS = 'turnscope'
export type TurnscopeKey =
  | 'view.title' | 'state.loading' | 'state.empty'
  | 'status.running' | 'status.completed' | 'status.failed' | 'status.maxTokens'
  | 'summary.tools' | 'summary.errors' | 'summary.duration'

export const zh: Record<TurnscopeKey, string> = {
  'view.title': '轮次',
  'state.loading': '正在加载时间线',
  'state.empty': '此会话还没有可显示的轮次',
  'status.running': '运行中',
  'status.completed': '已完成',
  'status.failed': '失败',
  'status.maxTokens': '达到输出限制',
  'summary.tools': '工具',
  'summary.errors': '异常',
  'summary.duration': '耗时',
}

export const en: Record<TurnscopeKey, string> = {
  'view.title': 'Turns',
  'state.loading': 'Loading timeline',
  'state.empty': 'No turns to display in this session',
  'status.running': 'Running',
  'status.completed': 'Completed',
  'status.failed': 'Failed',
  'status.maxTokens': 'Output limit reached',
  'summary.tools': 'Tools',
  'summary.errors': 'Errors',
  'summary.duration': 'Duration',
}
```

```ts
// src/client/index.ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TurnscopeView } from './TurnscopeView.tsx'
import { en, NS, zh } from './locales.ts'
import { installStyles } from './styles.ts'

export const inject = ['slots', 'sessions', 'locale']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'turnscope: dictionaries')
  ctx.effect(installStyles, 'turnscope: styles')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'turnscope',
    order: 20,
    locale: NS,
    label: () => t('view.title'),
  }, TurnscopeView))
}
```

Add the `LocaleNamespaceMap` module augmentation for `turnscope` in `locales.ts`.

Implement `installStyles()` to append one `<style data-plugin="@zhaolianghz/dsh-turnscope">` containing `.turnscope-root`, `.turnscope-card`, `.turnscope-header`, `.turnscope-status`, `.turnscope-summary`, and `.turnscope-activities` rules, and return a disposer that removes that exact node. It returns a no-op disposer when `document` is unavailable.

```ts
const STYLE_ID = '@zhaolianghz/dsh-turnscope'
const CSS = `
.turnscope-root{display:grid;gap:12px;padding:16px;overflow:auto}
.turnscope-card{border:1px solid var(--border-color,currentColor);border-radius:8px;padding:12px}
.turnscope-header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.turnscope-status{font-weight:600}
.turnscope-summary{display:flex;gap:16px;margin:10px 0}.turnscope-summary div{display:flex;gap:6px}
.turnscope-activities{display:grid;gap:6px;margin:0;padding-inline-start:22px}
`
let mountedStyle: HTMLStyleElement | null = null
let styleRefs = 0

export function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  styleRefs += 1
  mountedStyle ??= document.querySelector<HTMLStyleElement>(`style[data-plugin="${STYLE_ID}"]`)
  if (mountedStyle === null) {
    mountedStyle = document.createElement('style')
    mountedStyle.dataset.plugin = STYLE_ID
    mountedStyle.textContent = CSS
    document.head.append(mountedStyle)
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    styleRefs -= 1
    if (styleRefs === 0) {
      mountedStyle?.remove()
      mountedStyle = null
    }
  }
}
```

- [ ] **Step 4: Run focused verification**

Run: `pnpm vitest run tests/client-plugin.client.spec.tsx && pnpm typecheck`

Expected: registration and HMR-style disposal tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/index.ts src/client/locales.ts src/client/styles.ts tests/client-plugin.client.spec.tsx
git commit -m "feat: register Turnscope conversation view"
```

## Task 4: Render the read-only timeline

**Files:**

- Create: `src/client/TurnscopeView.tsx`
- Create: `tests/view.client.spec.tsx`

**Interfaces:**

- Consumes: `ConvViewProps['useSession']` and `deriveTurnModels`.
- Produces: accessible loading, empty and turn-card UI.

- [ ] **Step 1: Write failing UI tests**

Test these exact outcomes with Testing Library:

- `openState === 'loading'` renders `role="status"` with “正在加载时间线”；
- no derived turns renders “此会话还没有可显示的轮次”；
- a running turn exposes text “运行中” and no numeric duration;
- a failed turn exposes status “失败”, tool/error counts, and its activities;
- every card is reachable as an `<article aria-label="Turn N">` and state is not conveyed only by color.

- [ ] **Step 2: Run the UI test to verify it fails**

Run: `pnpm vitest run tests/view.client.spec.tsx`

Expected: FAIL because `TurnscopeView` does not exist.

- [ ] **Step 3: Implement the view**

```tsx
const STATUS_KEYS = {
  running: 'status.running',
  completed: 'status.completed',
  failed: 'status.failed',
  'max-tokens': 'status.maxTokens',
} as const satisfies Record<TurnStatus, TurnscopeKey>

export function TurnscopeView({ useSession, t }: ConvViewProps & PropsLocale<'turnscope'>) {
  const openState = useSession(snapshot => snapshot.openState)
  const turns = useSession(deriveTurnModels)
  if (openState === 'loading') return <div role="status">{t('state.loading')}</div>
  if (turns.length === 0) return <div>{t('state.empty')}</div>
  return (
    <section aria-label={t('view.title')} className="turnscope-root">
      {turns.map(turn => (
        <article key={turn.turn} aria-label={`Turn ${turn.turn}`} className="turnscope-card" data-status={turn.status}>
          <header className="turnscope-header">
            <strong>Turn {turn.turn}</strong>
            <span className="turnscope-status">{t(STATUS_KEYS[turn.status])}</span>
          </header>
          <dl className="turnscope-summary">
            <div><dt>{t('summary.tools')}</dt><dd>{turn.toolCount}</dd></div>
            <div><dt>{t('summary.errors')}</dt><dd>{turn.errorCount}</dd></div>
            {turn.durationMs === undefined ? null : (
              <div><dt>{t('summary.duration')}</dt><dd>{turn.durationMs} ms</dd></div>
            )}
          </dl>
          <ol className="turnscope-activities">
            {turn.activities.map(activity => <li key={activity.id}>{activity.label}</li>)}
          </ol>
        </article>
      ))}
    </section>
  )
}
```

Use CSS custom properties already provided by DSH where available; keep layout one-column, responsive, and free of fixed viewport heights. Add `data-status` only for styling—the visible localized status remains authoritative.

- [ ] **Step 4: Run focused verification**

Run: `pnpm vitest run tests/view.client.spec.tsx tests/turn-model.client.spec.ts && pnpm typecheck`

Expected: all model and UI tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/TurnscopeView.tsx tests/view.client.spec.tsx
git commit -m "feat: render read-only turn timeline"
```

## Task 5: Prove the browser handoff artifact

**Files:**

- Modify: `tsdown.config.ts`
- Create: `tests/client-bundle.client.spec.ts`

**Interfaces:**

- Consumes: compiled `lib/types/client/index.js`.
- Produces: `lib/client.js` calling `window.__ModuleLoader__.load` with package id and a DI `require` factory.

- [ ] **Step 1: Write the built-artifact test**

Model the native DSH `ui-trajectory` artifact test. Install a fake `window.__ModuleLoader__`, execute `lib/client.js`, then assert:

```ts
expect(handoff.id).toBe('@zhaolianghz/dsh-turnscope')
expect(exports.apply).toBeTypeOf('function')
expect(exports.inject).toEqual(['slots', 'sessions', 'locale'])
```

Mount the returned plugin on a real SlotRegistry and confirm it registers and disposes `conversation.view`. Also assert no unexpected external module is requested.

- [ ] **Step 2: Build and run the test to expose wrapper defects**

Run: `pnpm build && pnpm vitest run tests/client-bundle.client.spec.ts`

Expected: FAIL until the client output uses the exact ModuleLoader handoff shape.

- [ ] **Step 3: Complete the tsdown wrapper**

Configure a Node ESM library build for `lib/types/index.js` and a browser CJS build for `lib/types/client/index.js`. Use a final `renderChunk` plugin on the client config to wrap tsdown's emitted `code` exactly as follows:

```ts
renderChunk(code) {
  return {
    code: [
      'window.__ModuleLoader__.load({',
      "  id: '@zhaolianghz/dsh-turnscope',",
      '  factory(require) {',
      '    const module = { exports: {} };',
      '    const exports = module.exports;',
      code,
      '    return module.exports;',
      '  },',
      '});',
    ].join('\n'),
    map: null,
  }
}
```

Keep `react`, `react/jsx-runtime`, `react-dom`, `@deepseek-ai/cordis`, and all `@deepseek-ai/*` client services external. Styling is emitted by `installStyles()` rather than the bundler; the client-plugin test must prove a second mounted fiber does not create a duplicate style tag and disposing the last fiber removes it.

- [ ] **Step 4: Run full verification**

Run: `pnpm build && pnpm test && pnpm typecheck`

Expected: build exits 0, all tests PASS, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add tsdown.config.ts tests/client-bundle.client.spec.ts lib
git commit -m "build: emit DSH client handoff bundle"
```

## Task 6: Add a reproducible local DSH loading path

**Files:**

- Create: `examples/cordis.patch.yml`
- Modify: `README.md`

**Interfaces:**

- Consumes: built package root.
- Produces: one profile patch row loading `@zhaolianghz/dsh-turnscope`.

- [ ] **Step 1: Add the profile patch**

```yaml
- insert:
    - id: turnscope
      name: '@zhaolianghz/dsh-turnscope'
```

- [ ] **Step 2: Document the verified developer workflow**

README must state that this is an unreleased development build and document:

```bash
corepack enable
pnpm install
pnpm build
pnpm test
```

Document linking the package into a local DSH `0.1.1-rc.2` installation and applying `examples/cordis.patch.yml`. Do not publish an npm installation command until the package is actually published.

- [ ] **Step 3: Verify documentation facts and links**

Run: `test -f examples/cordis.patch.yml && pnpm build && pnpm test && git diff --check`

Expected: all commands exit 0 and every referenced file exists.

- [ ] **Step 4: Run the manual smoke test**

Start local DSH Web with the patch, open a session containing at least one completed turn, and verify:

1. a “Turnscope” conversation tab is visible;
2. opening it renders the completed turn;
3. starting another prompt changes the newest card to “Running” without refresh;
4. completion changes it to “Completed”;
5. disabling the plugin removes the tab and the conversation remains usable.

- [ ] **Step 5: Commit**

```bash
git add examples/cordis.patch.yml README.md
git commit -m "docs: add local DSH development workflow"
```

## Final Verification

Run all of the following from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
git diff --check
git status --short
```

Expected: dependency installation, build, tests, typecheck and whitespace checks all exit 0; status contains only intentionally uncommitted planning changes, if any. Confirm the source contains no `node:fs`, `node:sqlite`, Git subprocess, network client, Restore, or Fork implementation in this first slice.
