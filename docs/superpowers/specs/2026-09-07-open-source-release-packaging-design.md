# dsh-turnscope 开源发布包装设计

| 字段 | 内容 |
| --- | --- |
| 日期 | 2026-09-07 |
| 状态 | 已确认，待实施 |
| 项目阶段 | 设计完成，代码尚未开始 |
| 定位 | 预发布贡献型开源仓库 |

## 1. 目标

把当前以 PRD、架构和实施计划为主的仓库整理成真实、清晰、可参与的预发布开源项目。仓库必须让访客迅速理解三个事实：Turnscope 要解决什么问题，哪些内容已经完成，以及项目目前没有可安装实现。

成功标准：

1. README 首屏明确显示 pre-implementation 状态，不暗示已有可运行版本。
2. 产品范围、安全边界、架构和文档入口在 GitHub 首页可快速找到。
3. 潜在贡献者能通过 Roadmap、贡献指南、Issue 模板和 ADR 找到合适参与入口。
4. 所有功能、版本和安装描述与当前仓库真实状态一致。
5. 不添加无法执行或无法验证的 CI 配置、安装命令、截图和 Demo。

## 2. 目标读者

- 对 Agent 编码可观察性、回退或分叉感兴趣的开发者；
- 使用或开发 DSH 插件、能够验证事件接口的贡献者；
- 愿意评审产品范围、Git 安全模型或存储架构的维护者；
- 在实现开始前提供真实失败场景和脱敏事件样本的早期用户。

## 3. 内容原则

### 3.1 真实状态优先

所有未实现功能统一使用 Planned、Proposed 或设计文档措辞。README 不提供虚假安装步骤，不展示占位截图，不把 PRD 验收标准描述为现有能力。

### 3.2 对贡献者友好

当前阶段的主要参与方式是评审需求、讨论 ADR、提供脱敏场景、验证 DSH 扩展面和实现 Roadmap 任务。贡献指南要允许非代码贡献，并为代码贡献说明最小流程。

### 3.3 安全边界醒目

README、贡献指南、PR 模板和相关 ADR 都要强调：不得使用 `git reset --hard`，不得改写用户分支历史，无法证明安全时 Restore 必须拒绝，Fork 必须隔离到受管 Worktree。

### 3.4 避免过度包装

不增加 Star 数、下载量、构建状态等无真实数据的徽章。可以使用明确的状态和 License 徽章，但不得暗示发布版本或测试通过状态。

## 4. README 设计

README 使用英文为主、中文摘要为辅，以服务更广泛的 GitHub 访客，并链接完整中文 PRD。

内容顺序：

1. 项目名、一句话价值主张和 `Pre-implementation` 状态提示；
2. Why：Agent 每轮操作难理解、难定位、难安全撤回和重试；
3. Planned MVP：Timeline、Diff、规则提示、Restore、Fork、本地存储；
4. What exists today：明确列出 PRD、架构、实施计划和 ADR；
5. Safety principles：列出禁止危险重置、漂移即拒绝、本地优先等原则；
6. Architecture：提供小型文本架构图并链接完整架构文档；
7. Project status：说明当前里程碑和开始实现前的阻塞项；
8. Contributing：链接 Roadmap、贡献指南和 Issue 模板；
9. Documentation：统一导航所有核心文档；
10. 中文简介和 License。

README 暂不包含 Installation、Usage、Screenshots、Demo GIF 或性能结果；这些栏目在产生可验证实现后加入。

## 5. Roadmap 设计

`ROADMAP.md` 使用以下状态：

- **Done**：已经合并且有证据；
- **In progress**：已有实现分支或公开任务；
- **Planned**：已进入路线图但尚未开始；
- **Exploring**：仍需验证，不承诺交付。

路线图分期：

- `v0.0 — Design foundation`：PRD、架构、实施计划、开源治理与 ADR；
- `v0.1 — Local MVP`：事件适配、Trace、Diff、Checkpoint、Restore、Fork、规则和设置；
- `v0.2 — Analysis and portability`：脱敏导出、Session Compare、Token Analysis、Windows 验证；
- `v0.3 — Collaboration`：团队调试和可选云 Trace，仅列为 Exploring。

路线图必须声明版本内容可能根据 DSH 扩展接口验证结果调整，不提供未经验证的日期承诺。

## 6. 贡献指南设计

`CONTRIBUTING.md` 覆盖：

- 当前适合的贡献类型；
- 提交 Issue 前的搜索和脱敏要求；
- Bug、Feature、Design/ADR 的使用边界；
- 分支、Commit 和 Pull Request 的基本约定；
- 安全敏感改动的额外要求；
- 开发环境尚未确定时的诚实说明；
- 行为准则和安全漏洞报告的后续工作。

在代码骨架建立前，不伪造包管理器、启动或测试命令。代码贡献者需先在 Issue 中确认实现边界，避免围绕未验证 DSH API 大规模开发。

## 7. GitHub 模板设计

### 7.1 Issue 模板

新增三个 YAML Form：

- `bug_report.yml`：环境、预期/实际行为、复现步骤、日志脱敏确认；
- `feature_request.yml`：问题、建议方案、替代方案、MVP 相关性和安全影响；
- `design_proposal.yml`：决策背景、候选方案、取舍、兼容性、安全和隐私影响。

新增 `config.yml`，启用空白 Issue，并引导安全漏洞不要公开提交。由于当前尚无专用安全邮箱，配置不提供虚构的私密报告地址；README/贡献指南说明在正式发布前补齐 SECURITY.md。

### 7.2 Pull Request 模板

新增 `.github/PULL_REQUEST_TEMPLATE.md`，要求说明范围、关联 Issue、测试证据、文档变化，以及 Git 安全、隐私、兼容性和 fail-open 检查。

## 8. ADR 设计

`docs/ADR/` 新增索引与五份 Accepted 状态的决策记录：

1. `0001-use-harness-session-events.md`：使用公开 Harness Session Event，经 Adapter 转换为内部模型；
2. `0002-sqlite-is-an-index.md`：SQLite 只保存索引和关系，大载荷进入内容寻址对象存储；
3. `0003-no-git-reset-hard.md`：Restore 不移动 HEAD、不改写分支历史；
4. `0004-separate-restore-and-fork.md`：原地抵消和隔离重试使用两个引擎与安全模型；
5. `0005-fork-with-git-worktree.md`：Fork 使用插件管理的 Git Worktree。

每份 ADR 使用 Context、Decision、Consequences、Alternatives、Status 五段结构。ADR 记录已经在 PRD/架构中确定的决策，不引入新的产品范围。

## 9. License 与自动化

保留现有 MIT LICENSE，不改变版权人或年份。

本阶段不创建 CI Workflow。仓库尚无代码、依赖清单和真实测试命令，空壳 CI 不能提供有效质量信号。出现首个可执行骨架时，再增加最小的 Markdown 检查、构建和测试工作流。

## 10. 一致性与验证

实施完成后执行：

- 检查所有相对链接指向真实文件；
- 扫描未完成标记、占位图片、虚假安装和未实现能力陈述；
- 检查 Roadmap 状态与当前文件、提交事实一致；
- 检查 Issue/PR 模板 YAML 与 Markdown 语法；
- 检查 README、PRD、架构、实施计划和 ADR 的安全边界没有矛盾；
- 扫描仓库，确认没有 Token、真实会话载荷或其他敏感信息；
- 确认只修改开源包装文件，不改动产品设计范围。

## 11. 非目标

本次不实现 Turnscope 代码、不声明可安装版本、不发布 Release、不创建演示素材、不添加云服务、不定义尚未验证的 DSH API 细节，也不创建没有接收渠道的 SECURITY.md。
