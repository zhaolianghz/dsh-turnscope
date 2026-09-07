window.__ModuleLoader__.load({
	id: "@zhaolianghz/dsh-turnscope",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
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
		function TurnscopeView({ useSession, t }) {
			const openState = useSession((snapshot) => snapshot.openState);
			const turns = useSession(deriveTurnModels);
			if (openState === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				role: "status",
				children: t("state.loading")
			});
			if (turns.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: t("state.empty") });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
				"aria-label": t("view.title"),
				className: "turnscope-root",
				children: turns.map((turn) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
					"aria-label": `Turn ${turn.turn}`,
					className: "turnscope-card",
					"data-status": turn.status,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
							className: "turnscope-header",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: ["Turn ", turn.turn] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "turnscope-status",
								children: t(STATUS_KEYS[turn.status])
							})]
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
				}, turn.turn))
			});
		}
		//#endregion
		//#region src/client/locales.ts
		const NS = "turnscope";
		const zh = {
			"view.title": "轮次",
			"state.loading": "正在加载时间线",
			"state.empty": "此会话还没有可显示的轮次",
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
		const inject = [
			"slots",
			"sessions",
			"locale"
		];
		function apply(ctx) {
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
			}, TurnscopeView));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
