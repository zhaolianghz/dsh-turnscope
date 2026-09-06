# dsh-turnscope 技术架构

| 字段 | 内容 |
| --- | --- |
| 文档版本 | 0.1 |
| 状态 | 待评审 |
| 目标阶段 | 2–3 周 MVP |
| 目标平台 | DeepSeek Harness Web，Git 代码工作区 |

## 1. 架构目标

Turnscope 在不干扰 DSH 主会话的前提下，把 Harness 会话事件、工具活动与 Git 工作区变化组织为可查询的 Turn Trace，并提供两种明确分离的恢复能力：

- **Restore**：仅在能够证明安全时，在当前工作区应用逆向变化；
- **Fork**：从历史检查点创建隔离 Git Worktree 和关联的新会话。

系统必须本地优先、默认无遥测、写入前脱敏，并遵守 fail-open 原则：Turnscope 自身失败可以导致某轮不可观察或不可恢复，但不能阻断 Agent 主任务。

## 2. 总体架构

```text
DSH Web / Harness
        │ public session events
        ▼
Event Adapter ──► Redactor ──► Turn Assembler ──► Rule Engine
                                      │                 │
                                      ▼                 ▼
                              Trace Repository ◄─ Findings
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
                  SQLite index             Object store
               metadata / relations    payload / diff / snapshot
                         │                         │
                         └────────────┬────────────┘
                                      ▼
                              Turnscope UI
                         timeline / diff / actions
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
                   Restore Engine             Fork Engine
                         │                         │
                    current tree             Git Worktree
```

### 2.1 边界

Turnscope 只依赖 DSH 对插件公开的事件和服务，不让 UI、规则或存储直接消费上游原始事件结构。Git 操作封装在单独端口中，便于测试并阻止危险命令进入业务代码。

外部副作用（数据库、网络 API、消息发送等）只记录，不尝试回放或撤销。非 Git 工作区只提供时间线与诊断，不提供 Restore/Fork 保证。

## 3. 模块划分

### 3.1 Event Adapter

负责订阅 Harness Session Event，并转换为版本化内部事件 `NormalizedEvent`。适配器处理字段缺失、未知事件和上游版本差异；无法识别的事件写入受限诊断记录后忽略。

内部事件公共字段：

```ts
type NormalizedEvent = {
  schemaVersion: 1
  workspaceId: string
  sessionId: string
  turnId: string
  activityId: string
  parentActivityId?: string
  kind: 'turn' | 'model' | 'tool' | 'command' | 'approval' | 'test' | 'error' | 'system'
  phase: 'started' | 'updated' | 'completed' | 'failed' | 'interrupted'
  occurredAt: string
  payloadRef?: string
}
```

### 3.2 Redactor

所有可持久化内容先经过脱敏器。它遮盖常见 Token、API Key、Authorization Header、私钥块与用户配置的敏感路径，不保存完整进程环境。大输出在脱敏后按字节上限截断，并记录截断标志。

### 3.3 Turn Assembler

根据用户消息入队、Agent 开始/结束、失败与中断事件构建轮次状态机。每个 Activity 保留父子关系；乱序事件先放入短期缓冲区，超过窗口仍无法关联时归入该轮的“未关联活动”，不得丢失整个轮次。

轮次状态只允许以下转换：

```text
pending → running → completed
                  ↘ failed
                  ↘ interrupted
```

终态不可被普通更新覆盖；迟到事件作为补充活动追加。

### 3.4 Workspace Observer

在每轮前后采集 Git 状态、HEAD、分支、索引摘要、工作树摘要与相关文件指纹。开始前已存在的变化标记为 baseline，不归因给 Agent。大文件与二进制文件只保存元数据和内容哈希。

### 3.5 Rule Engine

使用纯函数规则消费固定事件序列，输出 `FindingRecord`。MVP 规则包括失败、超时、重复调用、修改后验证失败、修改后未验证、异常中断或输出限制。规则结果包含证据引用和严重程度，不宣称启发式提示就是根因。

### 3.6 Trace Repository

向 UI 和引擎提供稳定查询接口：

- `appendEvent(event)`
- `closeTurn(turnId, status)`
- `listTurns(sessionId, cursor)`
- `getTurn(turnId)`
- `getActivities(turnId, filter)`
- `getDiff(turnId, path)`
- `getCheckpoint(checkpointId)`
- `listFindings(turnId)`

仓储负责事务边界、schema 迁移、容量统计和保留策略。

## 4. 数据模型与存储

### 4.1 SQLite 只做索引

SQLite 保存可查询的小型结构数据：Workspace、Session、Turn、Activity、Checkpoint、Finding、Fork，以及对象引用、状态和时间戳。它不保存大型命令输出、完整 Diff 或文件内容，避免数据库膨胀和锁竞争。

核心表：

```text
workspaces(id, repo_root_hash, settings_json, created_at)
sessions(id, workspace_id, upstream_session_id, parent_session_id, created_at)
turns(id, session_id, ordinal, status, started_at, ended_at, pre_checkpoint_id, post_checkpoint_id)
activities(id, turn_id, parent_id, kind, phase, payload_ref, occurred_at)
checkpoints(id, workspace_id, head_oid, branch, tree_ref, index_hash, worktree_hash, restorable)
findings(id, turn_id, rule_id, severity, evidence_json)
forks(id, checkpoint_id, parent_session_id, child_session_id, worktree_path, status)
objects(ref, kind, byte_size, sha256, created_at)
```

写入采用短事务和 WAL；对象先写临时文件、校验哈希后原子改名，再提交 SQLite 引用。启动时清理没有索引引用的临时对象。

### 4.2 对象存储

插件数据目录按内容哈希保存：

```text
turnscope/
├── index.sqlite3
├── objects/ab/cdef...
├── worktrees/<fork-id>/
└── diagnostics/
```

对象内容包括脱敏后的命令输出、统一 Diff、必要的文件内容和导出报告。对象不可变，可由多个记录复用。

### 4.3 Git Snapshot

检查点不在用户分支创建 Commit 或 Tag。对于干净 Git 工作区，记录 HEAD 与通过 Git plumbing 生成的临时树/提交对象引用；对象可被插件私有引用保护，用户分支历史保持不变。脏工作区在 MVP 中仍可记录状态用于观察，但标记为不可原地恢复。

## 5. Checkpoint 生命周期

1. 轮次开始前读取仓库身份、HEAD、分支与工作区状态。
2. 若仓库干净，创建 pre-checkpoint 并记录内容指纹。
3. 轮次结束后创建 post-checkpoint，计算 pre/post 变化与验证摘要。
4. 若任一步失败，关闭轮次但将 `restorable=false`，不影响 Harness。
5. 保留策略先清理未被 Fork、固定记录或活动轮次引用的最旧对象。

检查点不是强制恢复点；它只提供 Restore/Fork 的证据和材料。

## 6. Restore Engine

Restore 以“追加一次抵消性工作区变化”实现，不移动 HEAD、不改写历史。

### 6.1 预览

预览阶段执行所有安全检查：

- pre/post checkpoint 完整且来自同一仓库；
- 轮次开始时工作区干净；
- 当前 HEAD 与 post-checkpoint 预期一致；
- 当前受影响文件的内容指纹未发生额外漂移；
- 没有未归属的新文件、冲突、合并或变基状态；
- 所需对象仍在且哈希校验通过。

任一检查失败即返回明确拒绝原因，且不修改文件。

### 6.2 应用

用户确认后，先创建 recovery-checkpoint，再把预览中确定的逆向补丁应用到临时目录并校验结果；校验通过后按文件原子替换。失败时使用 recovery-checkpoint 尽可能回到操作前状态，并保留诊断记录。

禁止使用 `git reset --hard`、强制 checkout、重写分支或静默解决冲突。

## 7. Fork Engine

Fork 从 checkpoint 对应的 Git 基线创建插件管理的 Worktree。流程如下：

1. 校验 checkpoint 与 Git 对象可用性；
2. 分配不可碰撞的 fork ID 和受管路径；
3. 创建临时分支引用与 Worktree；
4. 创建关联的新 DSH 会话，写入父会话、父轮次和 checkpoint ID；
5. 打开新会话并预填重试提示，但不自动调用模型；
6. 记录 Fork 生命周期，支持安全列出和清理。

清理只处理插件登记且路径、仓库身份均匹配的 Worktree。存在未提交改动时必须拒绝自动清理并要求用户确认处理方式。

## 8. UI 与数据流

右侧面板按游标分页读取轮次。实时事件先通过内存订阅更新，落盘后以仓储结果为准。轮次详情分为概览、变化和活动；原始诊断默认折叠。

Restore/Fork 操作采用 `prepare → preview → confirm → execute → record` 协议。预览包含一次性操作 ID；执行时必须重新验证，防止用户在确认期间修改工作区造成 TOCTOU 风险。

## 9. 错误处理

- 采集失败：记录有限诊断并继续主会话；
- 存储失败：内存中标记该轮不完整，禁用恢复；
- Git 命令失败：不修改工作区，返回可读原因；
- 对象损坏：隔离对象并使相关操作不可用；
- schema 不兼容：停止读取旧数据，提示迁移或清理，不阻止 DSH 启动；
- UI 崩溃：错误边界只卸载 Turnscope 面板。

诊断日志不得包含未脱敏载荷、环境变量或完整用户路径。

## 10. 并发与一致性

每个工作区只有一个写入队列；不同工作区可并行。轮次与 Activity 使用幂等 ID，重复事件不产生重复记录。Checkpoint 和 Restore/Fork 使用工作区级互斥锁；锁等待超过阈值时拒绝操作，不抢占用户 Git 操作。

## 11. 测试策略

### 单元测试

- 事件适配与版本兼容；
- 轮次状态机、乱序和重复事件；
- 脱敏与截断，确认密钥不落盘；
- 六类规则固定输入输出；
- Restore 安全判定矩阵；
- 保留策略与对象引用计数。

### 集成测试

- SQLite 事务、迁移和异常恢复；
- 干净/脏工作区、暂存区、重命名、二进制与大文件 Diff；
- checkpoint → 预览 → Restore；
- checkpoint → Worktree → 新会话关联 → 清理；
- 并发用户编辑、HEAD 漂移、冲突和对象丢失。

### 端到端测试

在受支持 DSH 版本上覆盖完成、失败、中断三类轮次，验证时间线、文件 Diff、拒绝路径、成功 Restore 和隔离 Fork。故意破坏 Turnscope 存储时，Agent 主轮次仍必须完成。

## 12. 安全与隐私

- 所有持久化载荷写入前脱敏；
- 存储目录使用用户私有权限；
- 路径规范化后必须位于仓库或插件管理目录；
- Git 参数通过结构化调用传入，不拼接 Shell；
- 不自动提交、推送、变基或重置用户分支；
- 默认无网络请求和遥测；
- 导出属于 P1，必须预览并二次扫描敏感信息。

## 13. 可演进接口

上游兼容性集中在 Event Adapter；存储通过 Repository 接口隔离；Git 通过 `GitPort` 隔离；UI 只消费稳定 View Model。未来增加 Windows、OTel 导出、Session Compare 或云同步时，不改变 MVP 的 Restore 安全边界。

## 14. 架构验收门槛

- Checkpoint 创建不改变 HEAD、分支、索引或工作树；
- Restore 从不调用危险重置，不在漂移时修改文件；
- Fork 的 Commit、文件与工具活动不影响原工作区；
- 测试密钥在 SQLite、对象文件和诊断日志中均不存在明文；
- 1,000 条活动记录下首屏可交互目标不超过 2 秒；
- Turnscope 采集或存储故障不阻断 Harness 主流程。
