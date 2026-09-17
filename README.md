# dsh-turnscope

**Understand every agent turn. Rewind safely. Retry without losing good work.**

`dsh-turnscope` is a DeepSeek Harness plugin for developers who use agents to change code. The 0.1.0 release ships a native, read-only turn timeline with per-file diffs and deterministic warnings, plus preview-first safe rewind (the `Preview / Apply` buttons in the turns panel). Forked retries remain planned for V0.3. The 0.1.1 / 0.1.2 / 0.1.3 / 0.1.4 / 0.1.5 patches refine renderer behavior (see Changelog below).

> Status: **V0.1.5 published** (`@zhaolianghz/dsh-turnscope@0.1.5`) for DSH `0.1.6-alpha.1` (the plugin's bundled client code consumes the runtime types shipped in `0.1.1-rc.2`, which are forward-compatible with the actual `ChatSnapshot` shape `0.1.6-alpha.1` exposes via the `useChat` hook). V0.2 (preview-first safe rewind) is shipping in the same build; the API_VERSION is `4` (since 0.1.1). The 0.1.1 / 0.1.2 / 0.1.3 / 0.1.4 / 0.1.5 patches refine renderer behavior without bumping `API_VERSION`. Forked retries remain planned for V0.3.

## Changelog

### 0.1.5 — 2026-09-17

Chat data source fix. The V0.1 → V0.1.4 renderer was reading chat nodes / turn timings / turn ends through `useSession((s) => s.nodes.filter(...))` etc., but DSH `0.1.6-alpha.1`'s `SessionSnapshot` no longer carries those fields — the chat builder output lives behind a separate `useChat` hook that returns a `ChatSnapshot` (with `legacy.{nodes, turnTimings, turnEnds}`). The renderer now reads from `useChat()` (and only `openState` continues to come from `useSession`). Renderer-only fix; no `API_VERSION` bump, no host changes, no DB migration. 599 tests (599 → 599, fixtures rebuilt around `ChatSnapshot`), typecheck clean.

### 0.1.4 — 2026-09-15

Crash fix. The 0.1.3 renderer crashed DSH's `conversation.view` slot whenever the `useSession` selector received a snapshot whose `nodes` field was not yet populated — a normal first-render case in this DSH build, where `getSnapshot()` can return `undefined` or a stub before the first real emission. The selector now treats a missing `nodes` / `turnTimings` / `turnEnds` as "no data" and returns an empty list; the `openState` reader does the same. The V0.1.3 bootstrap-context filter is unchanged. Renderer-only fix; no `API_VERSION` bump. 599 tests (598 → 599, +1), typecheck clean, client bundle 78.42 kB.

### 0.1.3 — 2026-09-15

DSH records a session's startup burst — the instructions, catalog, and recall the harness injects before the first user prompt — as `context` conversation nodes. The renderer now drops those pre-prompt context events from the turn activity list, so a fresh session's turn 1 and turn 2 cards no longer show `Context/Context/Context` rows. Mid-session context injections (seq ≥ first user/assistant seq) are unaffected; a session that has not yet received any user message keeps the entries, since there is no signal to distinguish bootstrap from "the user is composing their first prompt". Renderer-only fix; no `API_VERSION` bump. 598 tests (595 → 598, +3), typecheck clean, client bundle 78.21 kB (+0.32).

### 0.1.2 — 2026-09-15

The detail page's change list now groups inherited baseline-dirty paths under a labelled `本轮开始时已脏 (N)` divider, so a reader opening the detail to see what the agent did this turn no longer has to scroll past the inherited worktree state. The per-row `本轮开始时已脏` badge is unchanged. Renderer-only fix; no `API_VERSION` bump, no DB migration, no worktree write. 595 tests (593 → 595, +2), typecheck clean.

### 0.1.1 — 2026-09-15

Baseline-dirty clarity. The per-turn "Changed files" count was summing the agent's edits with paths the worktree was already dirty with at session start, so any session whose worktree wasn't clean on open reported the same misleading 76-file headline on every turn. The fix splits the wire-shape into `agentChangeCount` + `baselineChangeCount` (additive, `API_VERSION 4`), the turn card shows the agent count with a muted `+N 本轮开始时已脏` chip when the baseline number is non-zero, and the detail header does the same. The per-file `本轮开始时已脏` badge is unchanged. 593 tests, typecheck clean, client bundle 77.09 kB.

### 0.1.0 — 2026-09-11

First published release. Ships V0.1 (turn timeline + diffs + warnings) and V0.2 (preview-first safe rewind) in one bundle — the rewind feature needs the same `recovery_before` / `recovery_after` checkpoint phase that V0.1 already allocates, and the only safe moment to publish a real rewind is when the worktree-state drift guard is verified end-to-end against a real Git repository.

Highlights:

- Native `conversation.view` integration; turn timeline with running / completed / failed / output-limit states
- Per-turn duration, tool count, error count, activity list, command outcomes, file summaries, file diffs
- Deterministic safety warnings for common failure patterns
- **Preview / Apply safe rewind**: preview drafts a plan with zero worktree writes; apply commits it with atomic rename + per-file journal, and any mid-apply crash rolls files back to their pre-apply bytes on the next boot
- Drift guard: apply refuses if the live worktree has changed since the preview was drafted (real `git.blobAt(HEAD)` bytes compared against the live file, not just a hash)
- `recovery_before` and `recovery_after` checkpoint phases captured around the apply; a future rewind-the-rewind can compare against either
- Local-only storage (managed root, mode `0o600`), no telemetry, no `git reset --hard`, no branch rewrite
- English + Simplified Chinese copy

## Why

Coding agents can touch many files and run many commands in a single turn. When a turn goes wrong, users need clear answers:

- What did the agent change?
- Which command or tool failed?
- Where did the session start to drift?
- Can I undo that turn without losing later or unrelated work?
- Can I retry from that point in an isolated workspace?

Turnscope is designed around those questions.

## Available now

- Native `conversation.view` integration
- Live, newest-first turn timeline
- Running, completed, failed, and output-limit states
- Per-turn duration, tool count, error count, and activity list
- Commands, test outcomes, and changed-file summaries
- Per-turn file diffs
- Deterministic warnings for common failure patterns
- **V0.2 — Preview-first safe rewind**: a *Preview* button drafts a plan
  with zero worktree writes; a separate *Apply* button commits the plan
  with atomic rename + journal, and any mid-apply crash rolls back the
  files to their pre-apply bytes on the next start.
- Simplified Chinese and English copy
- Browser-only, read-only behavior with no telemetry

## Planned MVP

- Forked retry in an isolated Git worktree and a linked DSH session
- Local-only storage with no telemetry by default
- V0.3 — Fork & Retry (after the §10 spike; no automatic apply, no
  automatic model run, no LLM-as-judge).

## Safety boundary

Turnscope will never run `git reset --hard`, rewrite the user's branch, or silently overwrite a workspace that has drifted since a checkpoint. When safe rewind cannot be proven, the plugin must refuse the operation and offer inspection or isolated fork instead.

## Requirements

- Node.js 22.19 or newer
- pnpm 11.7
- A local DSH `0.1.6-alpha.1` installation (the plugin's bundled client code consumes the runtime types shipped in `0.1.1-rc.2`, which are forward-compatible with the `ChatSnapshot` shape `0.1.6-alpha.1` exposes via the `useChat` hook)

## Develop

```sh
corepack enable
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

The build emits the host entry, the browser handoff bundle expected by DSH's `window.__ModuleLoader__`, and TypeScript declarations under `lib/`.

## Load in local DSH

Build Turnscope first. From a local DSH `0.1.6-alpha.1` source checkout, add it as a development dependency of the `web` profile:

```sh
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add /path/to/dsh-turnscope
```

Start DSH Web. `pnpm dsh plugin add` already inserts the plugin into the
`web` profile's bundle layer; do **not** also pass the bundled
`examples/cordis.patch.yml` to `--patch`, or the loader will see a
duplicate `turnscope` id and refuse to boot. The patch overlay is
only needed when linking turnscope into a profile that does not have
the bundle layer (rare; documented for completeness):

```sh
pnpm dsh --profile web
```

Verified on `0.1.6-alpha.1`: the home page serves with turnscope in the
boot manifest (`/plugins/@zhaolianghz/dsh-turnscope/client.js`), and
the client bundle exports `previewRewind`, `listTurns`,
`RecoverySection`, and the other DTOs.


Open a session and select the **Turns / 轮次** conversation tab. Because this package is not published yet, there is intentionally no npm installation command.

## Project documentation

- [Product requirements](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)

## Scope

The first release targets Git-backed coding projects in DSH Web. Non-Git workspaces receive timeline and inspection features, but not rewind or fork guarantees.

## 中文简介

`dsh-turnscope` 是一个面向 DSH 编程用户的开发者工具插件。V0.1 在 DSH `0.1.1-rc.2` 上提供只读轮次时间线和文件差异；V0.2 增加 preview-first 安全回退（`轮次` 面板中的 Preview / Apply 按钮）；分叉重试仍在后续计划中。0.1.1 补丁修复了会话启动时工作区已脏导致的"变更文件"误报（详见下方 Changelog）。

首版坚持本地优先、默认无遥测，并且绝不通过重置分支或覆盖 Git 历史来实现回退。

## License

MIT
