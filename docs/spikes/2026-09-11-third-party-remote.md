# Spike：第三方插件能否向 DSH Client 暴露 Remote

日期：2026-09-11
基线：DSH `0.1.1-rc.2`（`@deepseek-ai/dsh`，全局安装）
结论：**Host 侧可行且已实证；Client 侧已补证可行**（见文末「补证」），Phase F 走 remote 路线。

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

## 仍未证明的部分（已于同日补证，见下节）

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

---

# 补证：client 侧实测（同日）

残留风险是一个问题：**真实 web app 里，第三方 client 插件能否 `inject: ['connection']`，并通过它打到 `/api`。** 已实测关闭，方法固化为 `docs/spikes/client-remote-smoke/`。

## 怎么做的

不能做成 vitest 用例（需要真实 DSH 进程 + 真实浏览器），所以做成脚本：`run.sh` 建一个隔离 `DSH_HOME`（`$WORK` 内，`node_modules` 用软链复用已有 profile 的共享安装，不重装 ~150 个包），装一个**手写的**探针 client 插件（不进仓库的构建链，`dsh.client` 指向手写 bundle），boot web，再让 headless Chrome 打开页面，用 CDP（Node 22 自带 `WebSocket`，零依赖）读回探针写在页面上的结论。

探针问的只有三件事，对应三层风险：

1. 我们的包是否出现在**服务出去**的 `window.__DSH_BOOT__` 里——配置树里有只说明 loader 被要求加载，`__DSH_BOOT__` 才是浏览器真正拿到的东西；解析失败、缺 `./client` 导出、`platform` 不是 `web`，都会在配置树里有而在图里没有。
2. `apply()` 是否真的跑起来——这是 `connection` 是否被注入的唯一证据。
3. `connection.rpc.call('/api', …)` 是否**往返到真实 host 服务**——用一个必然业务失败的请求（不存在的 sessionId），因为「成功了但业务说没有」恰好证明请求走到了 host 并被那边校验，而不是在本地被答复。

## 结果

```
entries: 44
{"id":"@zhaolianghz/dsh-connection-probe","url":"/plugins/…/client.js?rev=…","inject":["@deepseek-ai/dsh-client-runtime"],"immediately":true}
{"id":"@zhaolianghz/dsh-turnscope","url":"/plugins/…/client.js?rev=…","inject":["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-conversation"]}

PROBE: module loaded
PROBE: apply() ran, so `connection` was injected
PROBE: connection.rpc is object
PROBE: rpc resolved -> {"ok":true,"value":{"ok":false,"error":{"code":"session-not-found","sessionId":"probe-session-that-does-not-exist"}}}
PASS
```

三点直接结论：

1. **第三方 client 条目会被发现、会被服务**。`ClientModuleRegistry.processOne` 扫的是 `ctx.loader.entries()` 里所有条目的 `dsh.client` 声明，没有第一方白名单。
2. **`inject: ['connection']` 对第三方有效**。`connection` 是 `ctx.provide("connection", handle)` 出来的普通服务键，cordis 按服务键注入，不看包身份。
3. **不需要 `ctx.remote` 那层类型糖**。`dsh.client.inject`（模块图顺序，写包名）与 cordis `inject`（服务键）是两件事；第三方只用后者 + `connection.rpc.call` 原语即可，路线 2 的「手写 descriptor」在 client 侧没有任何生成物需求。

## 顺带否掉的一个做法

`--dump-dom` + `--virtual-time-budget` 不可用：页面持有 websocket，虚拟时间永远不干，dump 永不发生（实测超时）。CDP 是唯一可用路径，这点也写进了 `drive.mjs` 的注释，免得下次再试一遍。

## 对计划的影响（更新）

- **Phase F 走 remote 路线，残留风险已关闭**，第二阶段分支不需要启用。
- 这条证据无法进 CI，但可以重放：`bash docs/spikes/client-remote-smoke/run.sh`。HTTP 服务、探针、断言都在脚本里，改动 RPC 面假设时应重跑。
- `run.sh` 只在 `$WORK` 内写文件；不新建也不修改 `~/.dsh/profiles/web`（早期探索确实临时建过 `~/.dsh/profiles/ts-smoke`，已删除，脚本改为在 `$WORK` 内完成）。
