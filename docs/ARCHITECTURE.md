# dsh-turnscope 技术设计文档

> **目标：构建一个确定性的 Turn Attribution + Safety + Recovery 系统，而不是通用 Agent Trace 平台。**

| 字段 | 内容 |
|---|---|
| 文档版本 | v0.2 |
| 状态 | 可进入技术评审 |
| 调研基线 | 2026-09-10 |
| 对应 PRD | `dsh-turnscope-PRD-v0.2.md` |
| 目标平台 | DeepSeek Harness Web |
| 首要工作区 | Git Repository |
| 语言建议 | TypeScript |
| 本地索引 | SQLite |
| 大对象 | Content-addressed Object Store |
| 核心模块 | Adapter / Observer / Attribution / Safety / Recovery |
| 核心原则 | Deterministic / Local-first / Fail-open / Preview-first |

---

# 1. 技术目标

Turnscope 技术系统必须可靠完成五件事：

```text
OBSERVE
采集一轮发生了什么
      ↓
ATTRIBUTE
判断变化属于谁
      ↓
EVALUATE
判断当前是否安全
      ↓
PLAN
给出允许的恢复方式
      ↓
RECOVER
安全 Rewind 或隔离 Fork
```

其中前三步是核心。

如果前三步不可信，后面的 Rewind / Fork 都没有产品价值。

---

# 2. 非技术目标

本项目不追求：

- 记录所有 DSH 内部事件；
- 建设完整 OpenTelemetry；
- 保存全部模型 payload；
- 完整复刻 DSH Session Store；
- 实现 Git GUI；
- 实现全文件系统 snapshot；
- 自动回滚数据库和网络副作用；
- 使用 LLM 判断恢复安全性。

---

# 3. 当前仓库状态与迁移方向

> 以下状态记录的是 2026-09-10 的设计基线。当前开发依赖及 Web 集成已在 DSH `0.1.7-rc.1` 上验证；以 `package.json` 和 README 的兼容说明为准。

当前仓库已经具备：

- DSH native `conversation.view`；
- browser-only read-only timeline；
- Running / Completed / Failed / Output Limit；
- duration；
- tool count；
- error count；
- activity list；
- 中英文 UI；
- tests / typecheck / build。

当前 `package.json` 仍是：

```text
version: 0.0.0
private: true
dsh.client: ...
```

并固定依赖开发基线：

```text
@deepseek-ai/dsh-client-* = 0.1.1-rc.2
```

迁移目标：

```text
Current
Client-only Turn Timeline
        ↓
V0.1
Host + Client Bundle
Turn Evidence
Workspace Observer
Attribution
Safety Verdict
        ↓
V0.2
Recovery Planner
Safe Rewind
        ↓
V0.3
Worktree Fork
Child Session
Retry Compare
```

---

# 4. DSH 插件集成设计

## 4.1 Bundle 化

公开安装必须按照 DSH Bundle 机制发布。

官方 Bundle manifest 形式：

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

因此 Turnscope 应从“只有 `dsh.client` 描述”调整为：

```text
npm package
├── package.json
├── cordis.patch.yml
├── lib/
│   ├── host/
│   └── client/
└── ...
```

具体 `cordis.patch.yml` 插件行应以实际目标 DSH 版本生成并做 boot 验证，不在设计文档中假设尚未验证的配置字段。

---

## 4.2 建议包结构

```text
dsh-turnscope/
├── src/
│   ├── host/
│   │   ├── index.ts
│   │   ├── services/
│   │   ├── adapters/
│   │   ├── domain/
│   │   ├── git/
│   │   ├── storage/
│   │   ├── safety/
│   │   └── recovery/
│   ├── client/
│   │   ├── index.tsx
│   │   ├── views/
│   │   ├── components/
│   │   ├── hooks/
│   │   └── api/
│   └── shared/
│       ├── contracts/
│       └── schemas/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── fixtures/
│   └── boot/
├── cordis.patch.yml
├── package.json
└── docs/
```

---

## 4.3 Client Slot

保留现有：

```text
conversation.view
```

因为当前 DSH 公开 contract 中该 slot 仍是 Session scope 的 conversation view list entry。

Turnscope UI 不应接管：

```text
conversation.session
```

除非未来明确需要替换整个 Session Body。

原因：

- Turnscope 是附加视图；
- 不应破坏原 Chat；
- 避免侵入核心 UI；
- 降低上游兼容成本。

---

# 5. 总体架构

```text
┌─────────────────────────────────────────────┐
│               DeepSeek Harness              │
│                                             │
│ Session / Tool / Command / Client Snapshot  │
└───────────────────┬─────────────────────────┘
                    │
                    ▼
          ┌───────────────────┐
          │ DSH Adapter Layer │
          └─────────┬─────────┘
                    │ NormalizedEvent
                    ▼
          ┌───────────────────┐
          │   Turn Assembler  │
          └─────────┬─────────┘
                    │
       ┌────────────┴─────────────┐
       ▼                          ▼
┌──────────────┐          ┌──────────────────┐
│Turn Evidence │          │Workspace Observer│
└──────┬───────┘          └────────┬─────────┘
       │                           │
       └────────────┬──────────────┘
                    ▼
          ┌──────────────────────┐
          │  Attribution Engine  │
          └──────────┬───────────┘
                     │ TurnChangeSet
                     ▼
          ┌──────────────────────┐
          │     Safety Engine    │
          └──────────┬───────────┘
                     │ SafetyVerdict
         ┌───────────┴────────────┐
         ▼                        ▼
┌─────────────────┐      ┌──────────────────┐
│ Query / Host API│      │ Recovery Planner │
└────────┬────────┘      └─────────┬────────┘
         │                         │
         ▼                         ▼
┌─────────────────┐      ┌──────────────────┐
│ Turnscope Client│      │Rewind / Fork     │
│ conversation.view│     │V0.2 / V0.3       │
└─────────────────┘      └──────────────────┘
```

---

# 6. 架构原则

## 6.1 上游隔离

禁止：

```text
UI → DSH raw event
Safety Engine → DSH raw event
Storage → DSH raw session snapshot
```

必须：

```text
DSH → Adapter → Internal Domain Model
```

---

## 6.2 Safety 纯函数优先

安全判断核心设计为：

```ts
evaluateSafety(input: SafetyInput): SafetyVerdict
```

原则：

- 无 IO；
- 无 LLM；
- 无隐式全局状态；
- 相同输入得到相同输出；
- 每个 reason 都可追溯。

---

## 6.3 Fail-open

Turnscope 在观察链路失败时：

```text
Agent task continues
Turnscope safety degrades
```

而不是：

```text
Turnscope error
→ Agent task fails
```

---

## 6.4 Recovery Fail-closed

观察阶段：

> fail-open

恢复阶段：

> fail-closed

即：

> 不确定就不写 Workspace。

---

# 7. Domain Model

---

## 7.1 NormalizedEvent

```ts
type EventPhase =
  | 'started'
  | 'updated'
  | 'completed'
  | 'failed'
  | 'interrupted'

type ActivityKind =
  | 'turn'
  | 'model'
  | 'tool'
  | 'command'
  | 'file'
  | 'test'
  | 'approval'
  | 'error'
  | 'system'

interface NormalizedEvent {
  schemaVersion: 1

  workspaceId: string
  sessionId: string
  turnId: string

  activityId: string
  parentActivityId?: string

  kind: ActivityKind
  phase: EventPhase

  occurredAt: string

  summary?: string
  payloadRef?: string

  source: {
    adapter: string
    upstreamType?: string
  }
}
```

---

## 7.2 TurnRecord

```ts
type TurnStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'output_limited'

interface TurnRecord {
  id: string
  workspaceId: string
  sessionId: string
  ordinal: number

  status: TurnStatus

  startedAt: string
  endedAt?: string

  preCheckpointId?: string
  postCheckpointId?: string

  evidenceCompleteness: 'complete' | 'partial' | 'missing'
}
```

---

## 7.3 WorkspaceCheckpoint

```ts
interface WorkspaceCheckpoint {
  id: string
  workspaceId: string
  turnId: string

  phase: 'pre' | 'post' | 'recovery_before' | 'recovery_after'

  repository: {
    rootIdentity: string
    headOid?: string
    branch?: string
  }

  gitState: {
    mergeInProgress: boolean
    rebaseInProgress: boolean
    cherryPickInProgress: boolean
  }

  indexHash?: string
  worktreeHash?: string

  paths: CheckpointPathState[]

  completeness: 'complete' | 'partial' | 'failed'
  createdAt: string
}
```

---

## 7.4 CheckpointPathState

```ts
interface CheckpointPathState {
  path: string

  status:
    | 'clean'
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'untracked'

  staged: boolean
  binary: boolean

  contentHash?: string
  mode?: string

  blobRef?: string
}
```

注意：

> 并不是所有文件都必须保存 blob。

V0.1 只需要保存后续 Safety / Diff 所需材料。

---

# 8. Turn Evidence

```ts
interface TurnEvidence {
  turnId: string

  activities: ActivityRef[]

  commands: CommandEvidence[]
  tests: TestEvidence[]

  preCheckpointId?: string
  postCheckpointId?: string

  fileToolHints: FileToolHint[]

  completeness: {
    session: boolean
    command: boolean
    workspacePre: boolean
    workspacePost: boolean
  }
}
```

---

## 8.1 FileToolHint

这是 Attribution Engine 的辅助证据，不应单独成为真相。

```ts
interface FileToolHint {
  activityId: string
  path: string
  operation?: 'read' | 'write' | 'edit' | 'delete'
  occurredAt: string
}
```

原因：

Agent 可能：

- 通过 shell 修改文件；
- 运行 formatter 间接修改；
- package manager 修改 lockfile；
- codegen 修改多个文件。

因此不能只依赖工具名归属变化。

---

# 9. Change Attribution Engine

这是 Turnscope 技术核心之一。

---

## 9.1 输入

```ts
interface AttributionInput {
  pre: WorkspaceCheckpoint
  post: WorkspaceCheckpoint

  current?: WorkspaceCheckpoint

  evidence: TurnEvidence
}
```

---

## 9.2 输出

```ts
type Attribution =
  | 'AGENT'
  | 'BASELINE'
  | 'DRIFT'
  | 'UNCERTAIN'

interface FileChange {
  path: string
  kind:
    | 'created'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'binary_changed'

  attribution: Attribution
  confidence: 'high' | 'medium' | 'low'

  beforeHash?: string
  afterHash?: string
  currentHash?: string

  evidenceRefs: string[]
}
```

---

# 10. Attribution 算法

## 10.1 基本三态

对每个 Path 比较：

```text
PRE
POST
CURRENT
```

### Case A

```text
PRE == POST
```

本 Turn 没有产生最终变化。

---

### Case B

```text
PRE != POST
CURRENT == POST
```

变化在 Turn 内发生，并且 Turn 后没有继续漂移。

候选：

> AGENT

---

### Case C

```text
PRE != POST
CURRENT != POST
```

Turn 后发生变化。

标记：

> DRIFT

---

## 10.2 Baseline

如果 Turn 开始时：

```text
PRE(path) != Git HEAD(path)
```

说明该文件已经脏。

此文件带：

> baseline = true

如果本轮又修改同一文件，需要进一步计算增量，而不能简单把整个最终 diff 都归给 Agent。

---

## 10.3 脏文件增量归属

对于 baseline 文件：

```text
HEAD → PRE = user baseline
PRE  → POST = turn delta
```

Turnscope 的目标是保存 / 计算：

```text
delta(PRE, POST)
```

而不是：

```text
delta(HEAD, POST)
```

---

## 10.4 Uncertain

以下情况默认 UNCERTAIN：

- pre-state 缺失；
- post-state 缺失；
- 文件在观察窗口被外部进程并发修改；
- file hash 无法稳定获取；
- rename 判断存在冲突；
- binary 只保留元数据且无法恢复；
- workspace watcher 与 checkpoint 结果互相矛盾。

---

## 10.5 Attribution Confidence

### High

至少满足：

- 完整 PRE；
- 完整 POST；
- hash 可用；
- delta 明确；
- evidence 时间一致。

### Medium

例如：

- 有 hash；
- 缺少精确 tool hint；
- 但 PRE/POST 清楚。

### Low

信息部分缺失。

注意：

> `low` 的 AGENT 不能直接等价于 Rewind SAFE。

---

# 11. Workspace Observer

## 11.1 作用

Workspace Observer 负责提供确定性事实：

```text
Git state
HEAD
branch
index
worktree
file fingerprints
```

---

## 11.2 Repo Identity

不能只用绝对路径。

建议：

```ts
rootIdentity = sha256(
  canonicalRemoteIfAvailable
  + '\0'
  + gitCommonDirIdentity
)
```

若没有 remote：

使用：

- git common dir canonical path；
- repository metadata fingerprint。

目的：

避免 Worktree / symlink / cwd 变化导致误认仓库。

---

## 11.3 Git 命令白名单

所有 Git 调用通过：

```ts
interface GitPort
```

业务层禁止直接 `spawn('git', ...)`。

建议 V0.1 允许：

- `git rev-parse`
- `git status --porcelain=v2`
- `git diff`
- `git diff --cached`
- `git ls-files`
- `git hash-object`
- `git cat-file`
- 必要 plumbing read operations

V0.2 写操作必须独立白名单。

明确禁止恢复逻辑偷偷使用：

```text
git reset --hard
git clean -fd
git checkout -- .
```

---

# 12. Checkpoint 策略

原设计中“干净 Workspace 才可恢复”过于保守。

新的核心定位要求 Turnscope 能处理：

> 用户已有未提交改动。

因此 Checkpoint 应支持脏工作区。

---

## 12.1 V0.1 Checkpoint

存储：

- HEAD；
- status；
- relevant path hashes；
- relevant before blob；
- relevant after blob；
- index state；
- worktree state。

---

## 12.2 Relevant Path

为控制存储：

优先保存：

1. PRE 已脏路径；
2. Agent tool hint 路径；
3. POST 新变化路径；
4. command 执行后检测到的变化路径。

V0.1 不要求复制整个 Repo。

---

## 12.3 内容对象

建议对象寻址：

```text
objects/
  sha256[0:2]/
    sha256[2:]
```

对象内容先经过 redaction policy 判断。

代码文件 snapshot 默认不做字符串 secret 替换，否则会破坏可恢复性。

因此必须区分：

### Diagnostic Payload

允许脱敏。

### Recovery Blob

本地原样保存，但：

- 不上传；
- 权限限制；
- 明确容量；
- 明确用户可清理。

这是非常重要的技术边界。

---

# 13. Safety Engine

## 13.1 API

```ts
interface SafetyInput {
  turn: TurnRecord

  pre?: WorkspaceCheckpoint
  post?: WorkspaceCheckpoint
  current?: WorkspaceCheckpoint

  changeSet?: TurnChangeSet

  reversePatchCheck?: PatchCheckResult

  externalEffects?: ExternalEffectEvidence[]
}
```

---

## 13.2 输出

```ts
type SafetyLevel =
  | 'SAFE'
  | 'CAUTION'
  | 'FORK_ONLY'
  | 'UNPROTECTED'

type RecoveryAction =
  | 'INSPECT'
  | 'PREVIEW_REWIND'
  | 'REWIND'
  | 'FORK'
  | 'NONE'

interface SafetyReason {
  code: string
  severity: SafetyLevel

  title: string
  detail: string

  path?: string
  evidenceRefs: string[]
}

interface SafetyVerdict {
  level: SafetyLevel
  reasons: SafetyReason[]

  allowedActions: RecoveryAction[]
  recommendedAction: RecoveryAction

  evaluatedAt: string

  engineVersion: number
}
```

---

# 14. Safety Rules

每条规则实现：

```ts
interface SafetyRule {
  id: string
  evaluate(input: SafetyInput): SafetyReason[]
}
```

最终：

```text
highestSeverity(reasons)
```

决定 Verdict。

---

## 14.1 P0 Rules

### S001_PRE_CHECKPOINT_MISSING

```text
if !pre
→ UNPROTECTED
```

---

### S002_POST_CHECKPOINT_MISSING

```text
if !post
→ UNPROTECTED
```

---

### S003_REPOSITORY_CHANGED

```text
pre.repoIdentity != current.repoIdentity
→ UNPROTECTED
```

---

### S004_HEAD_DRIFT

如果 Rewind 计划依赖当前 HEAD 与 post HEAD 一致：

```text
post.headOid != current.headOid
→ FORK_ONLY
```

后续可升级为更细的 commit ancestry 判断。

---

### S005_TARGET_FILE_DRIFT

任意 Agent affected path：

```text
current.hash != post.hash
→ FORK_ONLY
```

---

### S006_UNCERTAIN_ATTRIBUTION

如果待恢复变化包含：

```text
attribution == UNCERTAIN
```

→ FORK_ONLY

---

### S007_GIT_OPERATION_IN_PROGRESS

检测：

- merge；
- rebase；
- cherry-pick；

→ FORK_ONLY

---

### S008_REVERSE_PATCH_CONFLICT

```text
reverse patch dry-run fail
→ FORK_ONLY
```

---

### S009_NON_GIT_WORKSPACE

→ UNPROTECTED

---

### S010_EVIDENCE_INCOMPLETE

关键证据缺失：

→ UNPROTECTED

非关键证据缺失：

→ CAUTION

---

### S011_BINARY_CHANGE

V0.2 若没有可靠 before blob：

→ FORK_ONLY / UNPROTECTED

如果有完整恢复材料，可继续判定。

---

### S012_EXTERNAL_SIDE_EFFECT

如果 Turn 有 deploy / network mutation 等迹象：

不直接阻止“文件恢复”，但至少：

→ CAUTION

并显示：

> Files may be rewindable, external effects are not.

---

# 15. Verdict 聚合

严重度：

```text
SAFE
  <
CAUTION
  <
FORK_ONLY
  <
UNPROTECTED
```

注意：

`UNPROTECTED` 和 `FORK_ONLY` 并不完全是“危险程度”关系。

含义区别：

- FORK_ONLY：有历史基线，适合隔离重试；
- UNPROTECTED：证据不足，连可靠恢复起点都可能不存在。

因此 allowedActions 单独计算。

---

# 16. Safety Cache

Safety 不能永久缓存。

原因：

> CURRENT workspace 随时会变化。

策略：

- Turn close 时计算 `initialVerdict`；
- UI 打开时可展示 initial；
- 用户点击 Recovery 时必须重新抓 `CURRENT`；
- Recovery Preview 前强制 re-evaluate；
- Confirm 前再次验证关键 fingerprint。

---

# 17. Recovery Planner

V0.2 引入。

---

## 17.1 RecoveryPlan

```ts
interface RecoveryPlan {
  id: string
  turnId: string

  verdict: SafetyVerdict

  operations: RecoveryFileOperation[]

  beforeCheckpointId: string

  status:
    | 'planned'
    | 'previewed'
    | 'applying'
    | 'completed'
    | 'failed'
    | 'cancelled'
}
```

---

## 17.2 File Operation

```ts
type RecoveryFileOperation =
  | {
      kind: 'restore'
      path: string
      expectedCurrentHash: string
      targetBlobRef: string
    }
  | {
      kind: 'delete_created_file'
      path: string
      expectedCurrentHash: string
    }
  | {
      kind: 'recreate_deleted_file'
      path: string
      targetBlobRef: string
    }
```

---

# 18. Rewind 设计

## 18.1 核心原则

Rewind 不是：

```text
git reset
```

Rewind 是：

> 根据 Turn delta 生成一组显式文件操作，把该 Turn 对文件系统产生的变化抵消。

---

## 18.2 Apply 前检查

每一个 Operation：

```text
CURRENT HASH
必须等于
PLAN.expectedCurrentHash
```

否则：

```text
ABORT WHOLE PLAN
```

不要自动 merge。

---

## 18.3 原子性

跨多个文件无法依赖普通 FS 完美事务。

建议：

1. 建 `recovery_before checkpoint`；
2. 所有目标写入 temp；
3. validate；
4. 尽量 atomic rename；
5. 每步记录 journal；
6. 任一步失败停止；
7. 使用 journal + before checkpoint 尝试恢复；
8. 如果无法证明恢复完成，提示用户 inspect。

---

# 19. Recovery Journal

```ts
interface RecoveryJournalEntry {
  planId: string
  seq: number

  operation: RecoveryFileOperation

  state:
    | 'prepared'
    | 'applied'
    | 'verified'
    | 'rolled_back'
    | 'failed'

  occurredAt: string
}
```

如果 DSH / Node 进程中途退出，下次启动：

> 检测 unfinished recovery

不要自动继续。

显示：

```text
Interrupted recovery detected
[Inspect]
```

---

# 20. Fork Engine

V0.3。

---

## 20.1 Fork 目标

创建：

```text
historical checkpoint
       ↓
isolated git worktree
       ↓
new DSH session
```

原 Workspace：

> untouched

---

## 20.2 ForkRecord

```ts
interface ForkRecord {
  id: string

  workspaceId: string

  parentSessionId: string
  parentTurnId: string

  checkpointId: string

  worktreePath: string
  childSessionId?: string

  status:
    | 'creating'
    | 'ready'
    | 'failed'
    | 'cleaning'
    | 'removed'

  createdAt: string
}
```

---

## 20.3 Fork 基线

不能默认历史 Turn 都对应 Git commit。

Checkpoint 可能包括：

```text
HEAD
+
baseline dirty state
+
historical turn state
```

创建 Worktree 后需要重建 checkpoint 所描述的状态。

因此算法：

```text
git worktree add <path> <base-head>
        ↓
apply checkpoint working tree material
        ↓
verify hashes
        ↓
mark READY
```

---

# 21. DSH Session Fork Adapter

不要让 Fork Engine 直接依赖某个 DSH Session API。

设计：

```ts
interface SessionForkPort {
  createSession(input: {
    cwd: string
    parentSessionId: string
    parentTurnId: string
    metadata: Record<string, unknown>
  }): Promise<{ sessionId: string }>
}
```

上游变化只修改：

```text
DshSessionForkAdapter
```

---

# 22. Retry Context

V0.3 新 Session 默认不自动提交。

预填：

```text
Retry from Turn #18.

Original task:
<summary>

Previous failure:
<narrow factual summary>

Relevant files:
...

Please retry with a different approach.
```

用户可编辑。

不要把大量原始 Trace 自动塞进 Prompt。

---

# 23. Compare Engine

```ts
interface TurnComparison {
  leftTurnId: string
  rightTurnId: string

  status: ComparisonField
  duration: ComparisonField

  files: FileComparison[]
  tests: TestComparison[]
  commands: CommandComparison[]

  safety: {
    left: SafetyLevel
    right: SafetyLevel
  }
}
```

V0.3 只做事实对比。

不输出：

> retry is objectively better

除非有用户明确标准。

---

# 24. Storage Architecture

建议：

```text
$DSH_HOME/.../turnscope/
├── index.sqlite3
├── objects/
│   ├── aa/
│   └── bb/
├── recovery/
│   └── journals/
├── worktrees/
└── diagnostics/
```

最终目录应使用 DSH 提供的插件数据目录规范，而不是硬编码 `$HOME`。

---

# 25. SQLite Schema

V0.1 建议：

```sql
workspaces(
  id,
  repo_identity,
  created_at,
  updated_at
)

sessions(
  id,
  workspace_id,
  upstream_session_id,
  created_at
)

turns(
  id,
  session_id,
  ordinal,
  status,
  started_at,
  ended_at,
  pre_checkpoint_id,
  post_checkpoint_id,
  evidence_completeness
)

activities(
  id,
  turn_id,
  parent_id,
  kind,
  phase,
  occurred_at,
  summary,
  payload_ref
)

checkpoints(
  id,
  workspace_id,
  turn_id,
  phase,
  repo_identity,
  head_oid,
  branch,
  index_hash,
  worktree_hash,
  completeness,
  created_at
)

checkpoint_paths(
  checkpoint_id,
  path,
  status,
  staged,
  binary,
  content_hash,
  blob_ref
)

file_changes(
  id,
  turn_id,
  path,
  kind,
  attribution,
  confidence,
  before_hash,
  after_hash,
  evidence_json
)

commands(
  id,
  turn_id,
  activity_id,
  command_summary,
  exit_code,
  duration_ms,
  output_ref
)

tests(
  id,
  turn_id,
  command_id,
  test_kind,
  status,
  summary
)

safety_verdicts(
  id,
  turn_id,
  level,
  reasons_json,
  allowed_actions_json,
  recommended_action,
  engine_version,
  evaluated_at,
  current_state_hash
)

objects(
  ref,
  kind,
  byte_size,
  sha256,
  created_at
)
```

V0.2：

```sql
recovery_plans(...)
recovery_journal(...)
```

V0.3：

```sql
forks(...)
comparisons(...)
```

---

# 26. Object Store

保存：

- truncated command output；
- sanitized diagnostic payload；
- unified diff；
- recovery blob；
- optional exported report。

对象：

```text
immutable
content-addressed
deduplicated
```

写流程：

```text
write temp
→ fsync if needed
→ sha256
→ atomic rename
→ sqlite reference
```

---

# 27. 数据一致性

SQLite：

- WAL；
- short transaction；
- foreign keys；
- migrations；
- busy timeout。

Object：

> object first → DB reference second

启动清理：

- orphan temp；
- unreferenced object（按 grace period）；
- interrupted write。

---

# 28. Host API

Client 不直接读 SQLite。

定义稳定 Host API。

---

## 28.1 listTurns

```ts
listTurns({
  sessionId,
  cursor,
  limit,
  filter
})
```

返回轻量 Summary。

---

## 28.2 getTurnDetail

```ts
getTurnDetail({
  turnId
})
```

返回：

- summary；
- changes；
- commands；
- tests；
- latest safety verdict。

---

## 28.3 getDiff

```ts
getDiff({
  turnId,
  path
})
```

---

## 28.4 evaluateSafety

```ts
evaluateSafety({
  turnId
})
```

强制刷新 Current Workspace。

---

## 28.5 previewRewind

V0.2。

---

## 28.6 applyRewind

V0.2。

需要：

- recoveryPlanId；
- expected evaluation id / state hash。

防止：

> 用户 Preview 后 Workspace 已变化，但仍点击旧 Confirm。

---

## 28.7 createFork

V0.3。

---

# 29. Client Architecture

```text
TurnscopeConversationView
├── TurnList
│   └── TurnCard
│       ├── Status
│       ├── Metrics
│       ├── SafetyBadge
│       └── RecommendedAction
└── TurnDetail
    ├── SummaryTab
    ├── ChangesTab
    ├── CommandsTab
    ├── TestsTab
    ├── EvidenceTab
    └── RecoverySection
```

---

# 30. UI 状态

必须区分：

```text
LOADING
LIVE
STABLE
STALE
ERROR
```

Safety Verdict 还应显示：

```text
evaluated 3s ago
```

因为 CURRENT 会变化。

用户进入 Recovery 时：

> Refresh Safety

---

# 31. 实时更新策略

V0.1 不需要让每个 Git change 都实时推送。

建议：

### Running Turn

实时：

- status；
- activity；
- tools；
- commands；
- errors。

### Turn Close

执行：

- post checkpoint；
- change attribution；
- safety initial evaluation；
- persistence。

这样降低运行中 Git 扫描成本。

---

# 32. Command / Test 分类

使用确定性规则。

例如 command basename / args：

```text
npm test
pnpm test
yarn test
vitest
jest
pytest
go test
cargo test
```

typecheck：

```text
tsc
pnpm typecheck
npm run typecheck
```

build：

```text
npm run build
pnpm build
cargo build
go build
```

分类只是 UI summary。

不参与高风险 Safety 判断，除非规则只表示：

> validation passed / failed / unknown

---

# 33. Findings Engine

降级为 P1。

接口：

```ts
interface FindingRule {
  evaluate(turn: TurnAnalysisInput): Finding[]
}
```

P1 规则：

- failed command；
- repeated failed command；
- changes without validation；
- failed validation after changes；
- interruption after file change；
- output limit after changes。

Findings 与 Safety 完全解耦。

---

# 34. Security Design

## 34.1 威胁模型

Turnscope 本身是本地插件，能够访问：

- repo；
- Git；
- session activity；
- command output。

因此风险包括：

- Secret 落盘；
- Path Traversal；
- Symbolic Link；
- Recovery 覆盖非目标文件；
- Worktree 路径逃逸；
- 恶意 path；
- shell injection。

---

## 34.2 Path Safety

所有 path：

```text
normalize
→ resolve
→ ensure descendant of allowed root
```

处理 symlink：

恢复写入前必须确认最终目标仍在 workspace 安全边界内。

---

## 34.3 禁止 Shell 字符串拼接

Git：

```ts
spawn('git', ['diff', '--', path], ...)
```

禁止：

```ts
exec(`git diff ${path}`)
```

---

## 34.4 Secret Strategy

分两类。

### Logs / Diagnostics

脱敏：

- API key；
- Authorization；
- Token；
- Private key；
- known patterns。

### Recovery Blobs

为了字节级恢复：

> 不应修改原始内容。

但必须：

- local-only；
- filesystem permission；
- retention；
- user cleanup；
- no telemetry。

---

# 35. External Effect Detector

V0.1 可以弱检测：

- curl；
- wget POST；
- deploy command；
- kubectl apply；
- terraform apply；
- cloud CLI mutation；
- git push；
- package publish。

只输出：

```text
Possible external side effect detected.
File rewind does not undo external effects.
```

不阻止普通 Inspect。

安全级别至少 CAUTION。

---

# 36. Compatibility Layer

DSH 公开说明仍处 Developer Preview。

因此建立：

```text
src/host/adapters/dsh/
  contract.ts
  current.ts
  versions/
```

如果确实需要多版本：

```text
v0_1_1.ts
v0_1_x.ts
```

不要在 Domain 中出现：

```ts
import type {...} from '@deepseek-ai/dsh-...'
```

除 Adapter / Client integration 之外。

---

# 37. Compatibility Matrix

README 自动维护：

| Turnscope | DSH | Status |
|---|---|---|
| dev | 0.1.7-rc.1 | verified: tests, typecheck, Web host and browser smoke |
| historical baseline | 0.1.1-rc.2 | design-time reference |
| v0.1.x | release-time verified version(s) | verified |
| other | unknown | not claimed |

发布前将第二行改成真实验证结果。

---

# 38. CI 设计

每次 PR：

```text
lint / format
typecheck
unit tests
integration tests
npm pack
install packed bundle
DSH boot smoke
```

重要：

> 只 typecheck 不够。

必须真正 Boot DSH。

---

# 39. Boot Smoke Test

最低场景：

```text
1. 新建临时 DSH profile
2. 安装 npm pack 产物
3. dsh --dump-config
4. 确认 Turnscope bundle 激活
5. 启动 web
6. 打开测试 session
7. conversation.view 中存在 Turnscope
```

如果 CI 难以做完整 Browser：

至少先做：

- profile reconcile；
- bundle load；
- host service registration。

---

# 40. Unit Test Matrix

## Attribution

- clean → agent edit；
- baseline dirty → agent different file；
- baseline dirty → agent same file；
- create file；
- delete file；
- rename；
- binary；
- post-turn manual edit；
- concurrent-looking edit；
- missing pre；
- missing post。

---

## Safety

每一个 Safety Rule：

- positive；
- negative；
- reason code；
- precedence；
- allowedActions。

---

## Storage

- migration；
- orphan object；
- WAL；
- interrupted write；
- dedupe；
- retention。

---

# 41. Integration Test Matrix

创建 fixture repo：

```text
fixture-clean
fixture-dirty
fixture-rename
fixture-binary
fixture-drift
fixture-merge
fixture-rebase
fixture-large
```

自动执行模拟 Turn。

---

# 42. V0.2 Recovery Tests

必须覆盖：

- modified file rewind；
- created file rewind；
- deleted file rewind；
- multi-file rewind；
- baseline preserved；
- current drift blocked；
- stale preview blocked；
- crash during recovery；
- permission denied；
- symlink；
- binary；
- rename；
- interrupted process。

安全恢复没有这些测试，不应发布。

---

# 43. Property-based Testing

Safety Engine 非常适合 property test。

例如不变量：

### Invariant 1

只要：

```text
target current hash != post hash
```

不能输出：

```text
SAFE + REWIND
```

### Invariant 2

只要关键 checkpoint missing：

不能允许 Rewind。

### Invariant 3

Recovery apply 后：

baseline 用户修改必须保留。

---

# 44. 性能设计

## 44.1 避免全仓库 Hash

大型仓库不能每 Turn：

> hash every file

策略：

- Git status 获取 changed paths；
- 只对 relevant path hash；
- 利用 Git blob OID；
- untracked 才额外 hash；
- 大文件仅必要时处理。

---

## 44.2 Lazy Diff

Timeline：

不加载完整 Diff。

用户点击 path：

```text
getDiff()
```

再加载。

---

## 44.3 Pagination

Session > 1000 Turns：

```text
cursor-based pagination
```

不要一次性发全部 Activity。

---

# 45. Retention

默认建议：

- metadata：较长；
- command payload：短；
- recovery blob：按容量限制；
- worktree：用户显式删除或 TTL 提示；
- pinned Turn：不自动清理。

配置：

```text
Retention days
Max storage
Keep recovery material
```

---

# 46. Cleanup 安全

清理前检查引用。

不能删除：

- active recovery 使用的 object；
- active fork checkpoint；
- pinned Turn；
- unfinished journal。

---

# 47. Observability of Turnscope

虽然产品默认无遥测，但本地需要：

```text
diagnostics/
```

记录：

- adapter error；
- checkpoint error；
- storage error；
- safety evaluation error；
- recovery error。

禁止默认包含：

- full prompt；
- full source code；
- secret。

---

# 48. Error Model

```ts
type TurnscopeErrorCode =
  | 'ADAPTER_FAILED'
  | 'CHECKPOINT_FAILED'
  | 'GIT_STATE_FAILED'
  | 'ATTRIBUTION_INCOMPLETE'
  | 'STORAGE_FAILED'
  | 'SAFETY_EVALUATION_FAILED'
  | 'RECOVERY_BLOCKED'
  | 'RECOVERY_STALE'
  | 'RECOVERY_APPLY_FAILED'
  | 'FORK_FAILED'
```

---

# 49. API Versioning

Host ↔ Client contract：

```ts
interface TurnscopeApiEnvelope<T> {
  apiVersion: 1
  data: T
}
```

这样 Client 和 Host 升级时可以明确失败，而不是 silent mismatch。

---

# 50. Migration Strategy

SQLite：

```text
schema_version
```

migration：

```text
001_initial
002_safety
003_recovery
004_fork
```

禁止 destructive auto-migration。

发生不支持版本：

> Read-only recovery / migration error UI

而不是删除数据库重建。

---

# 51. V0.1 开发拆分

建议按依赖顺序，而不是 UI 顺序。

---

## Phase 0：发布基础

- package version；
- remove private；
- `dsh.bundle`；
- `cordis.patch.yml`；
- npm pack；
- boot smoke；
- DSH compatibility adapter。

---

## Phase 1：Domain & Storage

- NormalizedEvent；
- TurnRecord；
- Checkpoint；
- SQLite；
- ObjectStore；
- migrations。

---

## Phase 2：Workspace Observer

- GitPort；
- repo identity；
- pre checkpoint；
- post checkpoint；
- relevant paths；
- hashes。

---

## Phase 3：Attribution

- ChangeSet；
- BASELINE；
- AGENT；
- DRIFT；
- UNCERTAIN；
- unit tests。

---

## Phase 4：Safety Engine

- SafetyInput；
- rules；
- Verdict；
- reasons；
- action policy；
- property tests。

---

## Phase 5：Host API

- listTurns；
- detail；
- diff；
- evaluateSafety。

---

## Phase 6：Client UI

在现有 Timeline 上增加：

- file count；
- tests；
- Safety Badge；
- reasons；
- detail；
- recommended action。

---

## Phase 7：Hardening

- large repo；
- dirty workspace；
- crash；
- secret；
- cleanup；
- DSH boot compatibility。

---

# 52. V0.2 开发拆分

```text
RecoveryPlan
→ Preview
→ Safety refresh
→ reverse planner
→ dry-run
→ recovery-before checkpoint
→ apply journal
→ verify
→ UI confirmation
→ crash recovery
```

---

# 53. V0.3 开发拆分

```text
ForkRecord
→ worktree adapter
→ checkpoint materialize
→ verify
→ session fork adapter
→ retry context
→ parent/child lineage
→ compare
→ cleanup
```

---

# 54. Definition of Done：V0.1

工程上满足：

- [ ] bundle 可安装；
- [ ] DSH boot 成功；
- [ ] native conversation view 正常；
- [ ] Adapter 与 Domain 解耦；
- [ ] GitPort 无危险命令；
- [ ] PRE / POST checkpoint；
- [ ] baseline detection；
- [ ] Turn ChangeSet；
- [ ] drift detection；
- [ ] Safety Engine；
- [ ] reason code；
- [ ] Safety UI；
- [ ] local DB；
- [ ] object store；
- [ ] redaction；
- [ ] retention；
- [ ] fail-open；
- [ ] unit / integration / boot tests；
- [ ] README compatibility matrix；
- [ ] npm pack install verification。

---

# 55. Definition of Done：V0.2

- [ ] 只有 SAFE 能进入 Apply；
- [ ] Preview 与 Apply 之间有 state hash；
- [ ] stale preview 必须阻止；
- [ ] baseline 修改完整保留；
- [ ] drift 修改完整保留；
- [ ] 不使用 `git reset --hard`；
- [ ] 不改写用户分支；
- [ ] recovery journal；
- [ ] crash test；
- [ ] multi-file test；
- [ ] symlink / traversal test。

---

# 56. Definition of Done：V0.3

- [ ] fork 不修改原 workspace；
- [ ] worktree 与 checkpoint 一致；
- [ ] child session 有 lineage；
- [ ] 自动执行模型默认关闭；
- [ ] retry context 可编辑；
- [ ] compare 可工作；
- [ ] fork cleanup 有引用保护。

---

# 57. 最重要的技术决策

## 决策 1

**Safety Engine 不使用 LLM。**

原因：

安全动作必须：

- repeatable；
- testable；
- explainable。

---

## 决策 2

**Timeline 不是数据源，Evidence 才是数据源。**

UI 可以变。

Evidence Contract 保持稳定。

---

## 决策 3

**Rewind 是逆向文件变化，不是 Git 历史重置。**

---

## 决策 4

**支持脏 Workspace，但必须做 delta attribution。**

如果只支持干净 workspace，会削弱 Turnscope 最重要的差异化。

---

## 决策 5

**Turn 后 drift 默认阻止原地 Rewind。**

不尝试“聪明地自动 merge”。

---

## 决策 6

**恢复材料和诊断日志采用不同数据策略。**

诊断可脱敏。

恢复 blob 必须保持原字节，否则无法保证恢复。

---

# 58. 未来可扩展点

V0.4 之后：

```ts
interface SafetyRulePlugin
interface EvidenceProvider
interface RecoveryStrategy
```

未来第三方可以增加：

- Docker workspace evidence；
- remote sandbox evidence；
- special build validation；
- organization policy。

但首版不要提前做复杂插件化。

---

# 59. README 技术描述建议

建议把项目描述更新为：

> Turn-level safety inspection, change attribution, safe rewind, and isolated retry for DeepSeek Harness coding sessions.

中文：

> DeepSeek Harness 的 Agent 轮次安全检查、修改归属、安全撤回与隔离重试插件。

README 首屏四个词：

```text
Inspect
Attribute
Decide
Recover
```

---

# 60. 技术风险清单

| 风险 | 级别 | 应对 |
|---|---|---|
| DSH API 快速变化 | 高 | Adapter + Boot CI |
| 脏 Workspace 归属错误 | 极高 | PRE/POST delta + tests |
| Turn 后 drift | 极高 | current hash + fail closed |
| Recovery 中途崩溃 | 高 | journal + before checkpoint |
| 大仓库性能 | 中高 | relevant paths + lazy diff |
| Recovery blob 含 secret | 中高 | local-only + permissions + retention |
| Worktree 基线重建 | 高 | checkpoint materialization + verify |
| 非 Git 场景 | 中 | Inspection only |
| 外部副作用无法撤回 | 高 | 明确 warning，不虚假承诺 |

---

# 61. 推荐首个工程里程碑

不是先实现 Rewind。

第一个真正有价值的工程里程碑应该是：

```text
一个真实 DSH Turn 完成
        ↓
Turnscope 得到 PRE / POST / CURRENT
        ↓
输出：
AGENT / BASELINE / DRIFT / UNCERTAIN
        ↓
输出：
SAFE / CAUTION / FORK_ONLY / UNPROTECTED
        ↓
UI 显示原因
```

只要这条链路正确，Turnscope 的产品核心就已经成立。

---

# 62. 推荐第二个里程碑

构造下面这个 fixture：

```text
README.md
用户在 Turn 前修改

src/auth.ts
Agent 在 Turn 内修改
用户在 Turn 后继续修改

tests/auth.test.ts
Agent 在 Turn 内创建
```

期望：

```text
README.md
BASELINE

src/auth.ts
DRIFT

tests/auth.test.ts
AGENT

Safety
FORK_ONLY

Reason
src/auth.ts changed after the recorded turn
```

这个测试建议成为：

> Turnscope Golden Scenario

以后每个版本都必须通过。

---

# 63. 发布前 package.json 改造要点

从当前：

```json
{
  "version": "0.0.0",
  "private": true
}
```

进入正式发布前至少需要：

```text
version = valid semver
private = false / remove
files = published artifacts
dsh.bundle.patch = ./cordis.patch.yml
repository
bugs
homepage
keywords
```

以及：

```text
npm pack
```

检查最终 tarball。

---

# 64. 上游资料基线

本文设计基于以下公开信息：

- Turnscope 当前仓库代码与 docs；
- DSH 官方“Everything is a Plugin”架构；
- DSH Bundle / Profile 发布机制；
- `conversation.view` 当前公开 slot contract；
- DSH 官方 Developer Preview 兼容性说明；
- awesome-dsh-plugin 对 `dsh.bundle` 与 `dsh-plugin` topic 的收录要求。

相关资料：

- https://github.com/zhaolianghz/dsh-turnscope
- https://github.com/deepseek-ai/deepseek-harness
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
- https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-conversation/src/client/contract/views.ts
- https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md
