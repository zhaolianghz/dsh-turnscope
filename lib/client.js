window.__ModuleLoader__.load({
	id: "@zhaolianghz/dsh-turnscope",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		/**
		* The namespace our host methods are registered under, and therefore the prefix
		* of every endpoint name.
		*
		* Shared because both halves have to spell it and only one of them chooses it:
		* the host registers descriptors whose `service` and `namespace` are this value,
		* and the browser asks for `turnscope/listTurns` by string. A constant that
		* drifted between the two would look exactly like an endpoint that does not
		* exist.
		*/
		const REMOTE_NAMESPACE = "turnscope";
		/** The endpoint name one method is reached by, e.g. `turnscope/listTurns`. */
		const endpointFor = (method) => `${REMOTE_NAMESPACE}/${method}`;
		/**
		* Read a reply, or explain why it is not one.
		*
		* Never throws, because every caller of this is a UI renderer, and the useful
		* behaviour on a version mismatch is to show nothing with an explanation rather
		* than to take down the panel the user is reading.
		*
		* Only the envelope is validated, not the payload. Checking fields here would
		* mean writing a validator per reply shape and keeping it in step with the types
		* it is supposed to be checking — with the failure mode that the checks silently
		* stop covering a field someone added. What *is* checked is the one fact a type
		* cannot carry at runtime: which version of the shapes these are.
		*
		* `data === null` is read as `absent` and a missing `data` as `unusable`, and
		* the difference matters: the first is a thing the host decided to say, the
		* second is a reply that came apart somewhere.
		*/
		function readReply(reply) {
			if (typeof reply !== "object" || reply === null) return unusable("the host reply is not an object");
			const candidate = reply;
			if (candidate.apiVersion !== 1) {
				const host = String(candidate.apiVersion);
				return unusable(`the host answers contract version ${host}, this bundle speaks 1`);
			}
			if (candidate.data === null) return { kind: "absent" };
			if (candidate.data === void 0) return unusable("the host reply carries no data");
			return {
				kind: "value",
				value: candidate.data
			};
		}
		const unusable = (detail) => ({
			kind: "unusable",
			detail
		});
		/**
		* How many turns one page may hold.
		*
		* Shared rather than host-only because both ends have to agree on it: the host
		* clamps to the ceiling, and the client asks for the default. It lives here for
		* the same reason the version does — a client that asked for its own idea of a
		* page size would be making a request the host silently rewrites.
		*
		* Clamped rather than trusted. The limit arrives from a browser, so it is user
		* input, and a page of a hundred thousand rows would be a self-inflicted denial
		* of service that no validation layer above this would catch — the request is
		* perfectly well-formed.
		*/
		const TURN_PAGE_LIMIT = Object.freeze({
			default: 30,
			max: 200
		});
		//#endregion
		//#region src/client/recorded-turns.ts
		/**
		* The recorded turn list, as the view needs it.
		*
		* The distinction the view cares about is not "what did the host say" but "what
		* can I show". Every way of not getting a list — a transport failure, a host
		* speaking another contract version, a session the host never recorded — ends in
		* the same rendering decision, but not in the same *sentence*: the first two are
		* about this page's ability to talk to that host, and a user who is told "no
		* turn was recorded" when the truth is "this bundle is older than that host"
		* will go looking in the wrong place. So the reason is carried, not swallowed.
		*/
		/**
		* Ask the host once per session, and again if the session changes.
		*
		* `undefined` while the answer is in flight, so the view renders what it already
		* knows rather than an empty frame that would then fill in — a shift from "no
		* safety information" to "safety information" is worse than a moment of neither.
		*/
		function useRecordedTurns(host, sessionId) {
			const [recorded, setRecorded] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				let live = true;
				setRecorded(void 0);
				host.listTurns({
					apiVersion: 1,
					sessionId,
					limit: TURN_PAGE_LIMIT.default
				}).then((answer) => {
					if (live) setRecorded(read(answer));
				});
				return () => {
					live = false;
				};
			}, [host, sessionId]);
			return recorded;
		}
		const read = (answer) => {
			switch (answer.kind) {
				case "value": return { safety: safetyOf(answer.value.turns) };
				case "absent": return { safety: /* @__PURE__ */ new Map() };
				case "unusable": return {
					safety: /* @__PURE__ */ new Map(),
					problem: answer.detail
				};
			}
		};
		/**
		* Index the verdicts by turn number.
		*
		* A turn with no verdict is left out rather than defaulted to `SAFE`. "Nobody
		* judged this turn" and "this turn was judged safe" are different claims, and
		* only one of them is worth putting next to a one-click recovery button — which
		* is what the next version of this panel grows.
		*/
		const safetyOf = (turns) => new Map(turns.flatMap((turn) => turn.safety === void 0 ? [] : [[turn.ordinal, turn.safety]]));
		//#endregion
		//#region src/client/turn-model.ts
		function activityFromNode(node) {
			const base = {
				id: `${node.kind}:${node.seq}`,
				seq: node.seq,
				time: node.time
			};
			switch (node.kind) {
				case "user": return {
					...base,
					kind: "user",
					label: "User message"
				};
				case "assistant": return {
					...base,
					kind: "assistant",
					label: `Assistant step ${node.step}`
				};
				case "tool-result": return {
					...base,
					kind: "tool",
					label: `Tool: ${node.call?.name ?? node.callId}`
				};
				case "command": return {
					...base,
					kind: "command",
					label: `Command: /${node.name ?? "unknown"}`
				};
				case "turn-error": return {
					...base,
					kind: "error",
					label: "Turn failed"
				};
				case "turn-max-tokens": return {
					...base,
					kind: "max-tokens",
					label: "Token limit reached"
				};
				case "context": return {
					...base,
					kind: "system",
					label: "Context"
				};
				case "steering": return {
					...base,
					kind: "user",
					label: "Steering message"
				};
				case "model-retry": return {
					...base,
					kind: "system",
					label: "Model retry"
				};
				case "compaction": return {
					...base,
					kind: "system",
					label: "Compaction"
				};
				case "unknown": return {
					...base,
					kind: "unknown",
					label: `Unknown: ${node.type}`
				};
				default: {
					const future = node;
					return {
						id: `unknown:${future.seq}`,
						seq: future.seq,
						time: future.time,
						kind: "unknown",
						label: `Unknown: ${String(future.kind ?? "event")}`
					};
				}
			}
		}
		function deriveTurnModels(snapshot) {
			const endSeqs = [...snapshot.turnEnds.entries()].sort((left, right) => left[1] - right[1]);
			const openTurn = [...snapshot.turnTimings.keys()].sort((left, right) => right - left).find((turn) => !snapshot.turnEnds.has(turn));
			const turnForSeq = (seq) => endSeqs.find(([, endSeq]) => seq <= endSeq)?.[0] ?? openTurn;
			const groups = /* @__PURE__ */ new Map();
			for (const conversationNode of snapshot.nodes) {
				const turn = ("turn" in conversationNode && typeof conversationNode.turn === "number" ? conversationNode.turn : void 0) ?? turnForSeq(conversationNode.seq);
				if (turn === void 0 || !snapshot.turnTimings.has(turn)) continue;
				const group = groups.get(turn) ?? [];
				group.push(conversationNode);
				groups.set(turn, group);
			}
			return [...snapshot.turnTimings.entries()].map(([turn, timing]) => {
				const nodes = groups.get(turn) ?? [];
				const hasTurnError = nodes.some((item) => item.kind === "turn-error");
				const hasMaxTokens = nodes.some((item) => item.kind === "turn-max-tokens");
				const status = hasTurnError ? "failed" : hasMaxTokens ? "max-tokens" : timing.endTime === void 0 ? "running" : "completed";
				const errorCount = nodes.filter((item) => item.kind === "turn-error" || item.kind === "tool-result" && item.isError || item.kind === "command" && item.outcome?.kind === "error").length;
				return Object.freeze({
					turn,
					status,
					startedAt: timing.startTime,
					...timing.endTime === void 0 ? {} : {
						endedAt: timing.endTime,
						durationMs: Math.max(0, timing.endTime - timing.startTime)
					},
					toolCount: nodes.filter((item) => item.kind === "tool-result").length,
					errorCount,
					activities: Object.freeze(nodes.map(activityFromNode))
				});
			}).sort((left, right) => right.turn - left.turn);
		}
		//#endregion
		//#region src/client/TurnscopeView.tsx
		const STATUS_KEYS = {
			running: "status.running",
			completed: "status.completed",
			failed: "status.failed",
			"max-tokens": "status.maxTokens"
		};
		const LEVEL_KEYS = {
			SAFE: "safety.SAFE",
			CAUTION: "safety.CAUTION",
			FORK_ONLY: "safety.FORK_ONLY",
			UNPROTECTED: "safety.UNPROTECTED"
		};
		function TurnscopeView({ useSession, t, recorded }) {
			const openState = useSession((snapshot) => snapshot.openState);
			const turns = useSession(deriveTurnModels);
			if (openState === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				role: "status",
				children: t("state.loading")
			});
			if (turns.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: t("state.empty") });
			const problem = recorded?.problem;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				"aria-label": t("view.title"),
				className: "turnscope-root",
				children: [problem === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					role: "note",
					className: "turnscope-note",
					children: t("safety.unavailable", { reason: problem })
				}), turns.map((turn) => {
					const safety = recorded?.safety.get(turn.turn);
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
						"aria-label": `Turn ${turn.turn}`,
						className: "turnscope-card",
						"data-status": turn.status,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
								className: "turnscope-header",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: ["Turn ", turn.turn] }),
									safety === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "turnscope-safety",
										"data-level": safety.level,
										children: t(LEVEL_KEYS[safety.level])
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "turnscope-status",
										children: t(STATUS_KEYS[turn.status])
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
								className: "turnscope-summary",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("summary.tools") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: turn.toolCount })] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("summary.errors") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: turn.errorCount })] }),
									turn.durationMs === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("summary.duration") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [turn.durationMs, " ms"] })] })
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
								className: "turnscope-activities",
								children: turn.activities.map((activity) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: activity.label }, activity.id))
							})
						]
					}, turn.turn);
				})]
			});
		}
		/**
		* Bind the view to a live host.
		*
		* A factory rather than a component with a `host` prop, because the host is a
		* property of *this installation* and not of any render: it is created once when
		* the plugin applies, from the connection the platform handed us, and never
		* changes while the page is open. Threading it through props would put a value
		* that cannot vary into a position where it looks like it can.
		*/
		function createTurnscopeView(host) {
			return function TurnscopeViewConnected(props) {
				const recorded = useRecordedTurns(host, props.useSession((snapshot) => snapshot.sessionId));
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TurnscopeView, {
					...props,
					recorded
				});
			};
		}
		//#endregion
		//#region src/client/host-api.ts
		/**
		* The channel the DSH gateway owns.
		*
		* Not ours to choose and not a fact about this plugin: the host registered its
		* interceptor on the shared `/api` channel, which is the channel the browser
		* transport already speaks. Naming it here is the one place the two halves of
		* the transport have to agree with something outside this repository, which is
		* why it is a constant with a paragraph rather than a literal in a call.
		*/
		const API_CHANNEL = "/api";
		/**
		* Build the API over a live connection.
		*
		* Takes the RPC handle rather than the whole `connection` service: nothing else
		* on that service is used, and a narrower argument is a narrower thing for a
		* test to have to fake.
		*/
		function createHostApi(rpc) {
			const call = async (method, request) => {
				let reply;
				try {
					reply = await rpc.call(API_CHANNEL, endpointFor(method), { args: { request } });
				} catch (error) {
					return {
						kind: "unusable",
						detail: describe(error)
					};
				}
				if (typeof reply !== "object" || reply === null) return {
					kind: "unusable",
					detail: "the transport returned no result"
				};
				const result = reply;
				if (result.ok !== true) {
					const error = result.error;
					return {
						kind: "unusable",
						detail: `${String(error?.code ?? "call-failed")}: ${String(error?.message ?? "the host refused the call")}`
					};
				}
				return readReply(result.value);
			};
			return {
				listTurns: (request) => call("listTurns", request),
				getTurnDetail: (request) => call("getTurnDetail", request),
				evaluateSafety: (request) => call("evaluateSafety", request)
			};
		}
		const describe = (error) => `${REMOTE_NAMESPACE}: ${error instanceof Error ? error.message : String(error)}`;
		//#endregion
		//#region src/client/locales.ts
		const NS = "turnscope";
		const zh = {
			"view.title": "轮次",
			"state.loading": "正在加载时间线",
			"state.empty": "此会话还没有可显示的轮次",
			"safety.unavailable": "无法向主进程查询安全结论：{reason}",
			"safety.SAFE": "安全",
			"safety.CAUTION": "注意",
			"safety.FORK_ONLY": "仅可分叉",
			"safety.UNPROTECTED": "无保护",
			"status.running": "运行中",
			"status.completed": "已完成",
			"status.failed": "失败",
			"status.maxTokens": "达到输出限制",
			"summary.tools": "工具",
			"summary.errors": "异常",
			"summary.duration": "耗时"
		};
		const en = {
			"view.title": "Turns",
			"state.loading": "Loading timeline",
			"state.empty": "No turns to display in this session",
			"safety.unavailable": "Could not ask the host for safety verdicts: {reason}",
			"safety.SAFE": "Safe",
			"safety.CAUTION": "Caution",
			"safety.FORK_ONLY": "Fork only",
			"safety.UNPROTECTED": "Unprotected",
			"status.running": "Running",
			"status.completed": "Completed",
			"status.failed": "Failed",
			"status.maxTokens": "Output limit reached",
			"summary.tools": "Tools",
			"summary.errors": "Errors",
			"summary.duration": "Duration"
		};
		//#endregion
		//#region src/client/styles.ts
		const STYLE_ID = "@zhaolianghz/dsh-turnscope";
		const CSS = `
.turnscope-root{display:grid;gap:12px;padding:16px;overflow:auto}
.turnscope-card{border:1px solid var(--border-color,currentColor);border-radius:8px;padding:12px}
.turnscope-header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.turnscope-status{font-weight:600}
.turnscope-summary{display:flex;flex-wrap:wrap;gap:16px;margin:10px 0}.turnscope-summary div{display:flex;gap:6px}
.turnscope-activities{display:grid;gap:6px;margin:0;padding-inline-start:22px}
.turnscope-note{opacity:.8;margin:0}
.turnscope-safety{font-size:.85em;padding:1px 6px;border-radius:999px;border:1px solid currentColor;opacity:.9}
`;
		let mountedStyle = null;
		let styleRefs = 0;
		function installStyles() {
			if (typeof document === "undefined") return () => {};
			styleRefs += 1;
			mountedStyle ??= document.querySelector(`style[data-plugin="${STYLE_ID}"]`);
			if (mountedStyle === null) {
				mountedStyle = document.createElement("style");
				mountedStyle.dataset.plugin = STYLE_ID;
				mountedStyle.textContent = CSS;
				document.head.append(mountedStyle);
			}
			let disposed = false;
			return () => {
				if (disposed) return;
				disposed = true;
				styleRefs -= 1;
				if (styleRefs === 0) {
					mountedStyle?.remove();
					mountedStyle = null;
				}
			};
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* `connection` joins the list because the panel has to *ask* the host what it
		* recorded: the timeline is assembled in the browser, but whether a turn is safe
		* to undo is a statement about a repository on the host, and only the host can
		* make it. Without the connection the panel could still render the timeline, but
		* it would render verdicts it does not have.
		*/
		const inject = [
			"slots",
			"sessions",
			"locale",
			"connection"
		];
		function apply(ctx) {
			const host = createHostApi(connectionOf(ctx).rpc);
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "turnscope: dictionaries");
			ctx.effect(installStyles, "turnscope: styles");
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "turnscope",
				order: 20,
				locale: NS,
				label: "view.title"
			}, createTurnscopeView(host)));
		}
		/**
		* Read the connection service.
		*
		* The assertion is written here rather than as a `declare module` augmentation
		* because `connection` means something else in the host program
		* (`HostConnectionHandle`, the host's own RPC registry) and a merged interface
		* would hand host code a type for a service that is not there. What makes the
		* assertion true is the `inject` list above: cordis does not start a plugin
		* whose declared services are missing, so by the time this body runs the service
		* exists. If it ever does not, that is a framework-level change and it should
		* fail here, loudly, rather than render a panel that silently shows nothing.
		*/
		const connectionOf = (ctx) => {
			const { connection } = ctx;
			if (connection === void 0) throw new Error("turnscope: the connection service is missing despite `inject`");
			return connection;
		};
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
