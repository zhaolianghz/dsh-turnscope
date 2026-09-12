# dsh-turnscope

**Understand every agent turn. Rewind safely. Retry without losing good work.**

`dsh-turnscope` is a DeepSeek Harness plugin for developers who use agents to change code. The V0.1 slice adds a native, read-only turn timeline to DSH coding sessions with per-file diffs and deterministic warnings. The V0.2 slice adds preview-first safe rewind (the `Preview / Apply` buttons in the turns panel). Forked retries remain planned.

> Status: unreleased development build for DSH `0.1.1-rc.2`. It is not published to npm.

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
- A local DSH `0.1.1-rc.2` installation

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

Build Turnscope first. From a local DSH `0.1.1-rc.2` source checkout, add it as a development dependency of the `web` profile:

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

Verified on `0.1.1-rc.2`: the home page serves with turnscope in the
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

`dsh-turnscope` 是一个面向 DSH 编程用户的开发者工具插件。V0.1 在 DSH `0.1.1-rc.2` 上提供只读轮次时间线和文件差异；V0.2 增加 preview-first 安全回退（`轮次` 面板中的 Preview / Apply 按钮）；分叉重试仍在后续计划中。

首版坚持本地优先、默认无遥测，并且绝不通过重置分支或覆盖 Git 历史来实现回退。

## License

MIT
