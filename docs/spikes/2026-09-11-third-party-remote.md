# Spike：第三方插件能否向 DSH Client 暴露 Remote

日期：2026-09-11
基线：DSH `0.1.1-rc.2`（`@deepseek-ai/dsh`，全局安装）
结论：**Host 侧可行且已实证；Client 侧剩一个注入问题，风险低但未实测**，由 Phase F 的 web boot 关闭。

## 为什么这是个真问题

v0.2 的 V0.1 UI（Safety Badge / reasons / diff）全部依赖 host 计算的数据抵达 client，而当前 client 是纯浏览器侧、直接投影 DSH 的 conversation snapshot，不读我们的 SQLite。所以必须有一条 host→client 通道。

三个让人担心的实测事实：

1. 第一方包（`dsh-message-feedback` 等）各自携带两个**生成物**：`lib/typert.host.js` 与 `lib/typert.remote-client.js`，由 `@deepseek-ai/dsh-typert-generator` 产出。
2. **该生成器未随包发布**——`node_modules/.pnpm` 里只有 `dsh-typert-protocol` 和 `dsh-typert-registry`，没有 generator。第三方无法复制第一方的构建流程。
3. `@deepseek-ai/dsh-api-remotes` 的 client 端是**闭集**，只 `import type` 七个第一方包的 remote 面（commands / file-reference / goal / host-plugin-inventory / message-feedback / session-reference / cordis-host-runner），并把它们装配成 `ctx.remote`。第三方 namespace 不在其中。

## 两条可能的路线

**路线 1：装饰器标记。** `class X extends TypertRemoteService` + 方法标 `@Remote('name')`。gateway 会在运行时反射活服务上的标记（源码里叫 "SRC markers"，见 `dsh-api-gateway/lib/index.js` 的 `collectSrcClaims` / `resolveSrcDescriptor`），因此不需要任何生成物。

**这条路对本仓库不可用**，原因与 DSH 无关：`@Remote` 是 TC39 阶段的装饰器语法，而本仓库的两条构建链（Vitest 4 / Vite 8 / rolldown 与 tsdown / rolldown）都**不转译该语法**。实测表现为构建期 `SyntaxError: Invalid or unexpected token`，不是运行时失败。注意 `tsc` 本身接受它——只有打包器不接受。若无谓地引入装饰器，生产产物也会踩同一个坑。

**路线 2：显式 contribution。** 手写 `InvocationDescriptor`，通过公开的 `TypertRegistry.register()` 注册——这正是生成的 `typert.host.js` 在模块作用域做的事。`TypertCodec` 有 `src-json` 模式，因此连生成的 zod schema 都不需要。

一个反直觉的要点：**`TypertRemoteService` 基类仍然必须继承**，但理由不是它的标记，而是它会在构造时把 `typertRemote` 绑定赋到实例上，而 gateway 的 `validateBinding` 会读取该绑定并校验 `binding.service === 实例`。只标装饰器不可用，基类并没有被排除。

## 实测内容与结果

`tests/host/adapters/third-party-remote.spec.ts` 用**真实的** registry（`@deepseek-ai/dsh-typert-registry`）与**真实的** gateway（`@deepseek-ai/dsh-api-gateway`）跑，只有一个替身：记录 gateway 注册了什么的 `connection` 服务（不是 mock 业务逻辑）。3 条断言全绿：

1. **claim**：一个继承 `TypertRemoteService`、**没有任何装饰器、没有任何生成物**的服务，其 `smoke/ping` 被 gateway 在 `/api` 通道上 claim；`smoke/absent` 与 `messageFeedback/list` 不被 claim（证明不是通配）。
2. **dispatch**：按生成 client 的确切线格式投递——`POST /api/<namespace>/<method>`，payload 恰好是 `{ args: { request: … } }`——返回 `{ ok: true, value: { pong: 'pong:hi' } }`。
3. **畸形 payload** 返回 `{ ok: false, error }` 而不是抛异常。

过程中有一次真实失败值得记下：少了基类的绑定后，dispatch 返回
`Service "smoke" has no visible typertRemote binding`。这正是发现"基类必须留、只有装饰器不可用"的原因。

**真实 DSH 进程的 boot smoke**（隔离 `DSH_HOME=/tmp/turnscope-smoke`，**未触碰 `~/.dsh/profiles/web`**）：

- `dsh plugin --profile smoke add <repo>` 会自动把包同时写进 `dsh.profile.bundles`。
- `dsh --profile smoke --dump-config` 在合成树末尾出现 `- id: turnscope / name: '@zhaolianghz/dsh-turnscope'`，即 bundle patch 生效。
- 实际 boot：无加载错误，进程存活直到超时被杀；stdout 出现 `ExperimentalWarning: SQLite`（我们自己的 import），并创建了 `turnscope/index.sqlite3`（目录 `0700`、文件 `0600`、`application_id=1414035280`、`user_version=1`、`journal_mode=wal`、8 张表齐全）。

顺带确认：DSH base bundle 已经挂载了 `typert`（registry）、`typert-loader`、`typert-gateway`（api-gateway），第三方不需要自带这套基础设施。

## 仍未证明的部分

**client 侧未实测。** 我按契约读到：

- client 的通用调用器是已发布的 `ClientConnectionRpc.call(channel, endpoint, payload, signal)`，服务键为 `connection`（`dsh-client-connection/lib/client.js` 里 `ctx.provide("connection", handle)`）。
- 第一方的 client 调用器走的就是这一个原语：`dsh-api-gateway/lib/client.js` 中 `await connection.rpc.call('/api', endpoint, { args }, signal)`。

因此第三方 client 不需要 `ctx.remote` 那层类型糖，直接用同一个原语即可。**但没有观察到浏览器里真的这么调通**，且本次 smoke profile 只有 `dsh-base`、没有 `dsh-web-app`，所以 client 半边完全没有被跑过。

剩余风险具体是一个问题：真实 web app 里，第三方 client 插件能否 `inject: ['connection']`。契约上可以（它是 `provide` 出来的服务，按 key 注入），但需实测。

## 对计划的影响

- **Phase F 走 remote 路线**，不走"本地导出"回退分支。回退分支暂时不需要启用。
- Phase F 的第一件事是**关闭上述残留风险**：往一个带 `dsh-web-app` 的隔离 profile 装包、boot web、从页面侧发起一次调用。若失败，再回退。
- `TypertRemoteService` + 手写 descriptor 的封装应放进 `src/host/adapters/dsh/`，与 TECH §36 要求的兼容适配层合流——手写 descriptor 本来就是那一层该有的形状。
- 本 spike 的 probe 测试保留为常驻契约测试：它钉住了我们对 DSH RPC 面的假设（§36 的适配层需要它）。
