# dsh-turnscope

**Understand every agent turn. Rewind safely. Retry without losing good work.**

`dsh-turnscope` is a planned DeepSeek Harness plugin for developers who use agents to change code. It adds a turn-level activity timeline, file diffs, safe rewind, and forked retries to DSH coding sessions.

> Status: requirements-first. The MVP is specified; implementation has not started.

## Why

Coding agents can touch many files and run many commands in a single turn. When a turn goes wrong, users need clear answers:

- What did the agent change?
- Which command or tool failed?
- Where did the session start to drift?
- Can I undo that turn without losing later or unrelated work?
- Can I retry from that point in an isolated workspace?

Turnscope is designed around those questions.

## Planned MVP

- Live turn-by-turn activity timeline
- Commands, tool calls, test outcomes, and changed-file summaries
- Per-turn file diffs
- Deterministic warnings for common failure patterns
- Preview-first safe rewind for supported Git workspaces
- Forked retry in an isolated Git worktree and a linked DSH session
- Local-only storage with no telemetry by default

## Safety boundary

Turnscope will never run `git reset --hard`, rewrite the user's branch, or silently overwrite a workspace that has drifted since a checkpoint. When safe rewind cannot be proven, the plugin must refuse the operation and offer inspection or isolated fork instead.

## Requirements

Project documentation:

- [Product requirements](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)

## Scope

The first release targets Git-backed coding projects in DSH Web. Non-Git workspaces receive timeline and inspection features, but not rewind or fork guarantees.

## 中文简介

`dsh-turnscope` 是一个面向 DSH 编程用户的开发者工具插件：按轮次展示 Agent 做过的操作和文件变化，支持安全回退，并可从任意检查点创建隔离工作区重新尝试。

首版坚持本地优先、默认无遥测，并且绝不通过重置分支或覆盖 Git 历史来实现回退。

## License

MIT
