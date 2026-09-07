# dsh-turnscope

**Understand every agent turn. Rewind safely. Retry without losing good work.**

`dsh-turnscope` is a DeepSeek Harness plugin for developers who use agents to change code. Its first development slice adds a native, read-only turn timeline to DSH coding sessions. File diffs, safe rewind, and forked retries remain planned.

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
- Simplified Chinese and English copy
- Browser-only, read-only behavior with no telemetry

## Planned MVP

- Commands, test outcomes, and changed-file summaries
- Per-turn file diffs
- Deterministic warnings for common failure patterns
- Preview-first safe rewind for supported Git workspaces
- Forked retry in an isolated Git worktree and a linked DSH session
- Local-only storage with no telemetry by default

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

Start DSH Web with the provided overlay:

```sh
pnpm dsh --profile web --patch /path/to/dsh-turnscope/examples/cordis.patch.yml
```

Open a session and select the **Turns / 轮次** conversation tab. Because this package is not published yet, there is intentionally no npm installation command.

## Project documentation

- [Product requirements](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)

## Scope

The first release targets Git-backed coding projects in DSH Web. Non-Git workspaces receive timeline and inspection features, but not rewind or fork guarantees.

## 中文简介

`dsh-turnscope` 是一个面向 DSH 编程用户的开发者工具插件。当前开发版已按照 DSH `0.1.1-rc.2` 原生插件机制实现只读轮次时间线；文件差异、安全回退和隔离重试仍在后续计划中。

首版坚持本地优先、默认无遥测，并且绝不通过重置分支或覆盖 Git 历史来实现回退。

## License

MIT
