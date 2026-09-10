# dsh-turnscope 产品需求文档（PRD）

> **产品定位：Turn-level Safety & Recovery for Agent Coding**
>
> **一句话：看清 Agent 每一轮修改，判断是否安全撤回；不安全时隔离重试。**

| 字段 | 内容 |
|---|---|
| 文档版本 | v0.2 |
| 状态 | 可进入开发评审 |
| 调研基线 | 2026-09-10 |
| 产品阶段 | V0.1 → V0.2 → V0.3 分阶段发布 |
| 目标平台 | DeepSeek Harness Web |
| 首要工作区 | Git 代码工作区 |
| 产品形态 | 本地优先的 DSH 插件 |
| 核心差异 | Turn Attribution + Safety Verdict + Recovery Orchestration |
| 数据策略 | 默认本地、默认无遥测、写入前脱敏 |
| 安全原则 | 无法证明安全时拒绝原地恢复 |

---

## 1. 文档说明

本 PRD 是对原 `dsh-turnscope` 产品方向的重新收敛。

原方案覆盖：

- Turn Timeline；
- 文件 Diff；
- 失败诊断；
- Checkpoint；
- Rewind；
- Git Worktree；
- Session Fork；
- Retry；
- Trace / 导出等。

这些能力单独看都有价值，但 DSH 插件生态中已经存在大量 Timeline、Diff、Checkpoint、Rewind、Replay、Trace、Worktree 类插件。若继续把这些能力平铺为同等权重，Turnscope 容易成为“已有插件功能的集合”，产品心智不够清晰。

因此本版本将产品核心重新定义为：

> **Turnscope 不是一个通用时间线，也不是另一个 Git Undo 插件。**
>
> **Turnscope 是 Agent 编码过程中的“轮次安全判断与恢复决策层”。**

用户真正要解决的问题不是“有没有 Undo 按钮”，而是：

1. 这一轮 Agent 到底改了什么？
2. 哪些变化能够确定属于 Agent？
3. 哪些变化在 Agent 开始之前就已经存在？
4. 当前工作区后来是否又发生了变化？
5. 现在原地撤回，会不会误伤用户自己的代码？
6. 如果不能安全撤回，怎样从历史点重新尝试，同时保留当前成果？

Turnscope 必须优先回答这些问题。

---

# 2. 产品定义

## 2.1 产品名称

**dsh-turnscope**

名称继续保留。

“Turnscope”天然表达：

- Turn：Agent 的一轮任务；
- Scope：观察这一轮的边界、影响范围和证据。

---

## 2.2 产品定位

**English**

> Safety & Recovery for Agent Coding Turns.

**中文**

> Agent 编码轮次安全与恢复工具。

---

## 2.3 产品价值主张

### 核心承诺

> **See what changed. Know what is safe. Recover without losing good work.**

对应中文：

> **看清每一轮修改，判断风险，安全撤回，隔离重试。**

---

## 2.4 核心心智

Turnscope 的产品心智不是：

- 时间线工具；
- Git Diff 工具；
- Undo 工具；
- Agent 日志查看器；
- 通用 Debug 平台。

而是：

> **Agent 改完代码以后，我能立即知道“这一轮是否安全”。**

每一个 Turn 最终都应得到一个可解释的安全结论。

---

# 3. 市场与差异化

## 3.1 已存在的能力类型

DSH 插件生态已经出现以下成熟方向：

- Session / Turn 时间线；
- 单轮修改 Diff；
- Checkpoint；
- Git 快照；
- Session Rewind；
- 文件恢复；
- Replay；
- Trace 分析；
- Git Worktree；
- Session Fork；
- Repro / 导出。

因此 Turnscope 不把“有时间线”“有 Diff”“能回退”本身作为核心差异。

---

## 3.2 Turnscope 的差异化

Turnscope 重点建立三个连续能力：

### A. Attribution —— 归属

回答：

> **这次变化到底是谁产生的？**

变化划分为：

- Agent Change；
- Pre-existing User Change；
- Post-turn Drift；
- Uncertain Change；
- External / Untracked Side Effect。

---

### B. Safety —— 判断

回答：

> **现在执行 Rewind 是否安全？**

安全结论由确定性规则产生，而不是由 LLM 猜测。

---

### C. Recovery —— 恢复策略

回答：

> **如果不安全，下一步应该怎么做？**

输出明确 Recovery Plan：

- Rewind Allowed；
- Inspect First；
- Fork Recommended；
- Fork Only；
- Recovery Unavailable。

---

## 3.3 核心护城河

Turnscope 的护城河不是某一个 Git 命令，而是：

> **证据采集 → 变化归属 → 安全判定 → 恢复决策**

形成的完整可信链路。

---

# 4. 目标用户

## 4.1 核心用户

使用 DSH Web 让 Agent 修改代码的个人开发者，包括：

- 使用 Agent 开发功能；
- 修复 Bug；
- 重构代码；
- 补测试；
- 升级依赖；
- 修改多个文件；
- 尝试多种实现路线。

---

## 4.2 高频用户场景

### 场景 1：Agent 改坏了代码

用户发现：

- 编译失败；
- 测试失败；
- 页面行为异常；
- Agent 开始继续错误方向。

用户需要快速找到：

- 从哪一轮开始出错；
- 这一轮改了哪些文件；
- 能不能安全撤回。

---

### 场景 2：用户自己也改了文件

Agent 工作之前，用户本地已经有未提交修改。

用户最担心的是：

> 点击 Rewind 会不会把自己的代码一起覆盖？

Turnscope 必须明确区分：

- 原本存在的变化；
- Agent 本轮新增的变化。

---

### 场景 3：Agent 结束后用户继续编辑

Agent Turn 完成后，用户手工继续修改同一个文件。

此时历史 Turn 的逆向 Patch 可能会损坏后续工作。

Turnscope 应识别：

> Workspace Drift

并阻止危险的原地 Rewind。

---

### 场景 4：想重新试，但不想丢掉当前成果

当前路线虽然失败，但里面可能有部分有用代码。

用户希望：

- 原工作区保持不动；
- 从之前某一轮重新尝试；
- 在隔离目录中执行；
- 最后比较两条路线。

Turnscope 提供：

> Fork & Retry

---

# 5. 产品目标

## 5.1 产品北极星

> **让用户在 Agent 一轮完成后，不需要自行拼接 Chat、Terminal 和 Git 信息，就能判断本轮影响和下一步安全动作。**

---

## 5.2 V0.1 目标

**Turn Safety Inspector**

用户在 10 秒内完成：

1. 找到最近 Turn；
2. 看清 Agent 做了什么；
3. 看清文件影响；
4. 看清测试 / 命令状态；
5. 获取 Safety Verdict；
6. 理解 Verdict 的证据。

V0.1 **只读优先**。

---

## 5.3 V0.2 目标

**Safe Rewind**

只有在安全条件全部通过时允许：

> Preview Rewind → Confirm → Apply

任何关键条件无法证明时：

> Block Rewind

---

## 5.4 V0.3 目标

**Isolated Retry**

对于不适合原地 Rewind 的 Turn：

> Fork from checkpoint → Isolated Worktree → New DSH Session → Retry → Compare

---

# 6. 非目标

以下能力不作为 V0.x 核心目标：

- 通用 Agent Observability 平台；
- OpenTelemetry 后端；
- 云端 Trace 平台；
- Agent Benchmark；
- 模型排行榜；
- LLM Judge；
- 自动选择模型；
- 自动修改 Prompt；
- 自动修复所有失败；
- 通用 Git GUI；
- 通用 Worktree Manager；
- 非 Git 文件系统的强一致恢复；
- 数据库事务回滚；
- 网络 API 副作用回滚；
- 邮件 / 消息撤回；
- 云端多人协作；
- 团队账号权限系统。

---

# 7. 核心概念

## 7.1 Turn

从一条用户请求进入 Agent 执行开始，到该轮：

- completed；
- failed；
- interrupted；
- cancelled；
- output-limited；

之一结束。

---

## 7.2 Activity

Turn 内发生的动作：

- Model Step；
- Tool Call；
- Shell Command；
- File Write；
- File Edit；
- Test；
- Approval；
- Error；
- Context / Compaction；
- System Event。

---

## 7.3 Turn Evidence

用于证明该 Turn 发生过什么的事实集合，包括：

- Turn 起止时间；
- 工具调用；
- 命令；
- 修改路径；
- Git pre-state；
- Git post-state；
- 文件内容指纹；
- 测试结果；
- 错误；
- 当前工作区状态。

---

## 7.4 Change Attribution

对文件变化进行归属。

### AGENT

能够较高可信度证明由本轮 Agent 产生。

### BASELINE

Turn 开始之前已经存在。

### DRIFT

Turn 完成之后才出现。

### UNCERTAIN

无法证明归属。

---

## 7.5 Checkpoint

Checkpoint 是 Turnscope 用来判断状态的本地记录。

Checkpoint **不是**用户分支上的提交。

至少记录：

- Repository Identity；
- HEAD OID；
- Branch；
- Index 状态；
- Worktree 状态；
- Relevant File Fingerprints；
- Timestamp；
- Checkpoint Completeness。

---

## 7.6 Safety Verdict

每个 Turn 都应得到一个安全结论。

V0.x 使用四级模型：

### SAFE

满足自动恢复安全要求。

UI：

> Safe to rewind

---

### CAUTION

没有发现确定冲突，但存在需要用户确认的问题。

UI：

> Inspect before recovery

---

### FORK_ONLY

无法证明原地恢复安全，但具备隔离 Fork 条件。

UI：

> Rewind blocked · Fork recommended

---

### UNPROTECTED

证据不足，无法提供可靠恢复。

UI：

> Recovery unavailable

---

# 8. Safety Verdict 判定原则

## 8.1 SAFE 必须满足

至少满足：

- pre-checkpoint 完整；
- post-checkpoint 完整；
- Repository Identity 未变化；
- 当前 HEAD 与安全预期兼容；
- 目标文件不存在 Turn 后漂移；
- 不存在未归属的目标文件变化；
- 不处于 unresolved merge；
- 不处于 unresolved rebase；
- inverse patch 可 dry-run；
- 不需要执行 `git reset --hard`；
- 不需要改写用户分支历史。

---

## 8.2 CAUTION 示例

- 检测到非目标文件发生变化；
- 某些大文件仅保存 hash，没有完整 diff；
- 二进制文件发生变化；
- 工作区状态复杂但不直接影响本次目标文件；
- 测试状态未知。

CAUTION 默认不直接执行恢复。

---

## 8.3 FORK_ONLY 示例

- Turn 后目标文件被再次编辑；
- 当前 HEAD 已变化；
- 相同文件同时包含无法可靠归属的修改；
- reverse patch 无法 clean apply；
- 当前存在 merge / rebase 风险；
- 用户本地变化与 Agent Change 交叉。

---

## 8.4 UNPROTECTED 示例

- Turn 开始时没有建立有效 checkpoint；
- Git Repository Identity 无法确认；
- 关键文件没有足够证据；
- 数据已被清理；
- 非 Git Workspace；
- Turnscope 在关键采集阶段失效。

---

# 9. 核心产品流程

## 9.1 Flow A：查看 Turn

```text
Agent 完成一轮
      ↓
Turnscope 聚合活动
      ↓
计算 Change Attribution
      ↓
运行 Safety Engine
      ↓
生成 Turn Card
      ↓
用户查看：
What Changed / Evidence / Safety / Next Action
```

---

## 9.2 Flow B：Safe Rewind

```text
用户选择历史 Turn
      ↓
点击 Preview Rewind
      ↓
重新获取当前 Workspace State
      ↓
重新运行 Safety Engine
      ↓
SAFE ?
 ┌────┴────┐
 YES       NO
 ↓          ↓
显示逆向Diff   禁止Rewind
 ↓          ↓
用户确认      推荐Inspect/Fork
 ↓
Apply
 ↓
建立Recovery Record
```

---

## 9.3 Flow C：Fork & Retry

```text
选择历史 Turn / Checkpoint
      ↓
Create Fork
      ↓
创建隔离 Git Worktree
      ↓
创建关联 DSH Session
      ↓
预填 Retry Context
      ↓
用户修改 Prompt
      ↓
运行新的 Agent Turn
      ↓
Compare original vs retry
```

---

# 10. 信息架构

Turnscope 在 DSH 会话中提供独立 Conversation View。

建议一级结构：

```text
Turnscope
├── Turns
├── Turn Detail
│   ├── Summary
│   ├── Changes
│   ├── Commands
│   ├── Tests
│   ├── Evidence
│   └── Recovery
└── Settings
```

V0.1 不建议增加大量一级菜单。

---

# 11. Turn Card 设计

每轮默认展示：

```text
Turn #18                                  FAILED

Fix authentication timeout

Duration       1m 42s
Tools          9
Commands       4
Files          7
Tests          1 failed

Safety
FORK ONLY

Reason
• src/auth.ts changed again after this turn
• package-lock.json attribution is uncertain

Recommended
[Inspect changes] [Fork & Retry]
```

---

## 11.1 卡片必须回答四件事

### 发生了什么

- 状态；
- 时间；
- 工具；
- 命令。

### 改了什么

- 文件；
- 类型；
- Diff。

### 哪里有问题

- 测试；
- 错误；
- 失败 Activity。

### 现在怎么办

- SAFE；
- CAUTION；
- FORK_ONLY；
- UNPROTECTED；
- 推荐动作。

---

# 12. 功能需求

---

## FR-01 DSH 安装与插件发布（P0）

### 要求

- 以 DSH Bundle 形式发布；
- `package.json` 必须声明 `dsh.bundle`；
- Bundle 包含 `cordis.patch.yml`；
- 支持通过 `dsh plugin --profile web add <package>` 安装；
- GitHub Repository 添加 `dsh-plugin` topic；
- README 给出明确兼容版本；
- README 给出开发安装和正式安装两种方式；
- 插件禁用不能影响 DSH 核心会话。

### 当前项目差距

当前仓库：

- `version = 0.0.0`；
- `private = true`；
- 当前只有 `dsh.client`；
- 尚未形成可公开安装的 `dsh.bundle`。

### 验收

用户安装后无需手工编辑 DSH 源码即可启用 Turnscope。

---

## FR-02 DSH 版本兼容层（P0）

DSH 仍处于 Developer Preview，存在兼容性破坏风险。

要求：

- 所有 DSH 上游 API 通过 Adapter 层接入；
- Domain Model 不直接引用上游 Event 类型；
- UI 不直接解析上游 Session 原始结构；
- 至少维护：
  - 当前开发基线；
  - 当前发布支持版本；
- CI 对支持版本进行 Build / Typecheck / Boot Smoke Test；
- 不使用无限宽泛 peerDependency 范围宣称未验证兼容。

验收：

> 上游字段变化时，主要修改集中在 Adapter 层。

---

## FR-03 Turn 采集（P0）

采集：

- Turn start；
- Turn end；
- Turn status；
- Model activities；
- Tools；
- Commands；
- Failures；
- Interruptions；
- Test-like commands；
- File-related activities。

要求：

- 未识别事件安全忽略；
- Turnscope 异常不得中断 Agent；
- 支持迟到事件；
- 支持 Session 重开后的重建。

---

## FR-04 Turn Timeline（P0）

V0.1 保留当前已实现的 native `conversation.view` 模式。

要求：

- newest-first；
- Running 实时更新；
- Completed 稳定；
- Failed 突出；
- 显示：
  - duration；
  - tools；
  - commands；
  - files；
  - tests；
  - errors；
  - Safety Verdict。

Timeline 是入口，不是核心卖点。

---

## FR-05 Workspace Baseline（P0）

Turn 开始时记录工作区基线：

- repo identity；
- HEAD；
- branch；
- staged state；
- unstaged state；
- untracked path list；
- relevant file fingerprint。

Turn 开始之前已存在的变化：

> BASELINE

不得默认归因给 Agent。

---

## FR-06 Turn ChangeSet（P0）

Turn 结束后计算：

- created；
- modified；
- deleted；
- renamed；
- binary changed。

每个文件必须拥有 Attribution：

- AGENT；
- BASELINE；
- DRIFT；
- UNCERTAIN。

---

## FR-07 Diff Viewer（P0）

支持：

- Unified Diff；
- Added / Modified / Deleted；
- 基础 rename；
- 大文件截断；
- Binary metadata；
- Copy path；
- 跳转到相关 Activity（可用时）。

---

## FR-08 Test / Command Summary（P0）

识别常见验证行为：

- test；
- typecheck；
- lint；
- build；
- compile。

每条输出：

- command；
- exit status；
- duration；
- result；
- evidence。

不需要在 V0.1 做复杂根因分析。

---

## FR-09 Safety Engine（P0）

Safety Engine 为产品核心。

输入：

- pre checkpoint；
- post checkpoint；
- Turn ChangeSet；
- current workspace；
- repo state；
- attribution confidence；
- dry-run result。

输出：

```text
SafetyVerdict {
  level
  reasons[]
  evidenceRefs[]
  allowedActions[]
  recommendedAction
  evaluatedAt
}
```

要求：

- 确定性；
- 可解释；
- 同样输入必须产生同样结果；
- LLM 不参与 P0 Safety 决策。

---

## FR-10 Safety Reasons（P0）

不能只显示：

> Unsafe

必须显示具体原因。

例如：

```text
Rewind blocked

1. src/auth.ts changed after Turn #18
2. package-lock.json has uncertain attribution
3. reverse patch does not apply cleanly

Recommended: Fork & Retry
```

---

## FR-11 Recovery Action Model（P0）

不同 Verdict 对应不同按钮。

| Verdict | Inspect | Rewind | Fork |
|---|---:|---:|---:|
| SAFE | ✓ | ✓ | ✓ |
| CAUTION | ✓ | 默认关闭 | ✓ |
| FORK_ONLY | ✓ | ✗ | ✓ |
| UNPROTECTED | ✓ | ✗ | 视 checkpoint 而定 |

禁止出现“按钮可点，但点击后才告诉用户危险”的模式。

---

## FR-12 Preview Rewind（V0.2 / P0）

执行恢复前必须展示：

- 目标 Turn；
- affected files；
- reverse changes；
- conflicts；
- safety checks；
- 当前 Workspace State；
- 执行后预期状态。

Preview 不产生工作区修改。

---

## FR-13 Safe Rewind（V0.2 / P0）

仅 SAFE 可执行。

原则：

- 不执行 `git reset --hard`；
- 不移动用户分支到历史提交；
- 不删除历史会话；
- 不静默覆盖漂移文件；
- 不改写 Git history；
- 恢复本身记录为新的 Recovery Event。

---

## FR-14 Fork & Retry（V0.3 / P0）

输入：

- source session；
- source turn；
- source checkpoint。

输出：

- isolated worktree；
- child session；
- parent-child linkage；
- retry context。

要求：

- 原工作区不变；
- 原 session 不变；
- 新 session 默认不自动执行模型；
- 用户最终确认 Prompt 后开始执行。

---

## FR-15 Compare Retry（V0.3 / P1）

对比：

- original Turn；
- retry Turn。

维度：

- status；
- duration；
- changed files；
- test result；
- commands；
- safety verdict；
- final diff summary。

不做 LLM Judge。

---

## FR-16 Findings（P1）

V0.1 只做极少数确定性提示：

- command failed；
- test failed；
- changed but not validated；
- repeated failed command；
- interrupted after changes；
- output limit after changes。

Finding 不宣称“根因”。

---

## FR-17 本地存储（P0）

默认：

- Local only；
- No account；
- No cloud；
- No telemetry。

用户可：

- 查看占用；
- 清理历史；
- 设置保留期；
- 设置最大容量。

---

## FR-18 脱敏（P0）

持久化前处理：

- API key；
- bearer token；
- authorization header；
- private key；
- 常见 secret pattern；
- 用户自定义敏感路径。

不保存完整环境变量快照。

---

## FR-19 Fail-open（P0）

Turnscope 的错误不得中断 Agent。

例如：

- checkpoint 失败；
- SQLite 写失败；
- diff 失败；
- Git observer 失败。

处理：

- Turn 保持继续；
- 标记 `UNPROTECTED`；
- 记录插件内部诊断。

---

# 13. Safety Engine 产品规则矩阵

| 条件 | SAFE | CAUTION | FORK_ONLY | UNPROTECTED |
|---|---:|---:|---:|---:|
| pre/post checkpoint 完整 | 必须 | 建议 | 建议 | 缺失时可能 |
| repo identity 一致 | 必须 |  |  | 不一致 |
| 当前 HEAD 兼容 | 必须 |  | 不兼容 | 无法读取 |
| 目标文件无 post-turn drift | 必须 |  | 有 drift | 无证据 |
| 所有目标变化可归属 | 必须 | 部分不确定 | 关键变化不确定 | 大量缺失 |
| reverse patch dry-run 成功 | 必须 |  | 失败 | 无材料 |
| merge/rebase clean | 必须 |  | 非 clean | 无法判断 |
| Git workspace | 必须 | 必须 | 必须 | 非 Git |

说明：

> 最终 Verdict 取所有命中规则中最严格级别。

---

# 14. UX 原则

## 14.1 安全信息优先于日志

首屏优先显示：

1. Turn Status；
2. Safety；
3. Changed Files；
4. Tests；
5. Recommended Action。

原始事件放后面。

---

## 14.2 不使用模糊安全表达

禁止：

- Probably safe；
- Should be okay；
- Maybe safe。

使用：

- Safe to rewind；
- Rewind blocked；
- Evidence incomplete；
- Workspace changed；
- Fork recommended。

---

## 14.3 危险动作必须 Preview

任何写 Workspace 的动作：

> Preview first

---

## 14.4 不用红色表示普通失败以外的一切

Safety 状态必须依靠：

- 文字；
- icon；
- label；

不能只依赖颜色。

---

# 15. V0.1 详细范围

## 必须做

- DSH bundle 化；
- 兼容适配层；
- Turn timeline；
- commands；
- tests；
- changed files；
- baseline detection；
- change attribution；
- diff；
- checkpoints metadata；
- Safety Engine；
- Safety Verdict UI；
- local persistence；
- redaction；
- fail-open；
- cleanup settings。

---

## 明确不做

- 真正 Rewind 写操作；
- Worktree 自动创建；
- Retry 自动创建 Session；
- Run comparison；
- 大量 Rule Engine；
- AI 根因分析；
- Trace export；
- Repro bundle；
- 非 Git snapshot engine。

---

# 16. V0.2 详细范围

新增：

- Preview Rewind；
- Re-evaluate Safety；
- reverse patch planner；
- dry-run；
- confirm；
- apply；
- recovery record；
- recovery result；
- failure rollback / fail-safe。

---

# 17. V0.3 详细范围

新增：

- Worktree Fork；
- DSH child session；
- lineage；
- Retry prompt；
- Compare；
- cleanup worktree。

---

# 18. 发布节奏

```text
V0.1
Turn Safety Inspector
        ↓
验证用户是否在意“安全判断”
        ↓
V0.2
Safe Rewind
        ↓
验证恢复使用率和安全失败率
        ↓
V0.3
Fork & Retry
        ↓
形成完整 Recovery Loop
```

---

# 19. 成功指标

## 19.1 产品指标

### Activation

用户安装后 10 分钟内至少打开一次 Turnscope。

### Turn Inspection Rate

出现 failed Turn 后打开 Turnscope 的比例。

### Safety View Rate

打开 Turn Detail 后查看 Safety / Reasons 的比例。

### Recovery Intent

V0.2：

- Preview Rewind 点击率；
- Rewind blocked 次数。

V0.3：

- Fork & Retry 启动率。

---

## 19.2 安全指标

必须重点监控：

- 错误归属用户修改为 Agent 修改：**0 容忍目标**；
- 在已有 drift 时错误允许 SAFE：**0 容忍目标**；
- Rewind 导致用户未关联修改丢失：**0 容忍目标**；
- Turnscope 导致 DSH Agent 主任务失败：**0 容忍目标**。

---

# 20. 性能指标

V0.1 目标：

- Timeline 首屏打开：P95 < 500ms（本地已有索引）；
- Turn detail：P95 < 300ms；
- 1000 Turn session 仍支持分页；
- Safety Evaluate：典型项目 < 1s；
- 后台采集不得显著影响 Agent 命令执行。

大型仓库可异步延迟计算完整 diff，但 Safety 所需关键状态必须明确标记是否完成。

---

# 21. 兼容性策略

当前 `dsh-turnscope` 仓库开发版固定在 DSH `0.1.1-rc.2`。

由于 DSH 官方仍明确处于 Developer Preview，并提示会发生兼容性破坏：

- PRD 不永久锁死某一个 DSH 版本；
- Release 必须公布 Verified Versions；
- 每次 DSH 大版本 / RC train 变化都跑兼容测试；
- `conversation.view` 等 UI 接口统一封装；
- Host / Client API 均经过 Adapter。

---

# 22. 隐私与安全

## 默认策略

- 无遥测；
- 不上传代码；
- 不上传 Diff；
- 不上传 Prompt；
- 不上传命令输出；
- 不建立云账号。

---

## 数据目录

只存：

- 本地 metadata；
- 必要 diff；
- 必要 checkpoint material；
- 脱敏后的有限活动 payload。

---

## 外部副作用

Turnscope 只能告诉用户某 Turn 调用了：

- network；
- database；
- external command；
- deployment；
- message API；

但不得宣称能够把这些副作用回滚。

UI 显示：

> External effects are not rewindable by Turnscope.

---

# 23. 错误处理

错误分三类：

## Observation Error

例如 Git status 读取失败。

结果：

> Turn 仍存在，Safety = UNPROTECTED。

---

## Analysis Error

例如 diff parser 失败。

结果：

> 保留原始安全证据，关闭自动恢复。

---

## Recovery Error

V0.2。

原则：

- Recovery 前先建立 recovery-before checkpoint；
- 写入逐步验证；
- 任一步不确定时停止；
- 不执行危险 fallback。

---

# 24. 首次发布验收标准

V0.1 达到以下条件才允许公开发布：

- [ ] 能作为 DSH Bundle 安装；
- [ ] GitHub 添加 `dsh-plugin` topic；
- [ ] npm package 非 private；
- [ ] 有正式 semver；
- [ ] README 有 install / uninstall；
- [ ] README 有兼容矩阵；
- [ ] 已验证至少一个当前 DSH 版本；
- [ ] native `conversation.view` 可正常打开；
- [ ] Turn 状态正确；
- [ ] Changed Files 基本正确；
- [ ] Baseline 不被误归因；
- [ ] Drift 能被识别；
- [ ] Safety Verdict 可解释；
- [ ] unsafe case 不显示 Rewind 可执行；
- [ ] 插件异常不阻断 Agent；
- [ ] Secret redaction 有测试；
- [ ] 100+ Turn session 无明显性能问题；
- [ ] npm pack 后安装验证通过。

---

# 25. V0.1 Demo 脚本

公开发布时 README 首页建议使用一个非常具体的 Demo。

```text
1. 用户本地 README.md 已有未提交修改
2. Agent Turn #12 修改 src/auth.ts 和 tests/auth.test.ts
3. 测试失败
4. 用户随后手工修改 src/auth.ts
5. 打开 Turnscope
6. Turn #12 显示 FAILED
7. Change Attribution：
   - README.md = BASELINE
   - src/auth.ts = AGENT + POST-TURN DRIFT
   - tests/auth.test.ts = AGENT
8. Safety = FORK ONLY
9. Reason：
   src/auth.ts changed after Turn #12
10. Recommended Action：
   Fork & Retry
```

这个 Demo 直接体现：

> **Turnscope 不只是能 Undo，而是知道什么时候不应该 Undo。**

---

# 26. 后续路线

## V0.4+

只有在 V0.1～V0.3 已证明价值后再考虑：

- Recovery comparison enhancement；
- shareable sanitized report；
- cross-session safety history；
- optional AI explanation；
- external side-effect warnings；
- plugin API；
- team policies。

---

# 27. 产品最终定义

Turnscope 应始终遵守下面这一条：

> **当证据不足时，宁可少做，也不能假装安全。**

最终用户体验不是：

> “这里有一个 Undo 按钮。”

而是：

```text
Turn #18

What changed?
→ 7 files

What failed?
→ npm test

Whose changes?
→ 5 Agent / 1 baseline / 1 uncertain

Is rewind safe?
→ NO

Why?
→ Workspace drift detected

What should I do?
→ Fork & Retry
```

这就是 Turnscope 的产品核心。

---

# 28. 参考基线

本 PRD 重写时参考：

- `zhaolianghz/dsh-turnscope` 当前 README、PRD、ARCHITECTURE 与 package.json；
- DeepSeek Harness 官方 Architecture / Plugin Publish 文档；
- DSH `conversation.view` 当前公开 contract；
- awesome-dsh-plugin 收录要求；
- DSH 社区中 Timeline / Rewind / Checkpoint / Diff / Replay / Worktree / Trace 类型插件的市场重叠情况。

相关公开资料：

- https://github.com/zhaolianghz/dsh-turnscope
- https://github.com/deepseek-ai/deepseek-harness
- https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish
- https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
