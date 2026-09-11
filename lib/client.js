window.__ModuleLoader__.load({
	id: "@zhaolianghz/dsh-turnscope",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/age.ts
		/** Under this, "now" — a verdict computed in the last few seconds has no age to report. */
		const JUST_NOW_MS = 1e4;
		function ageOf(evaluatedAt, now) {
			const elapsed = Math.max(0, now - evaluatedAt);
			if (elapsed < JUST_NOW_MS) return {
				unit: "now",
				count: 0
			};
			const seconds = Math.floor(elapsed / 1e3);
			if (seconds < 60) return {
				unit: "seconds",
				count: seconds
			};
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60) return {
				unit: "minutes",
				count: minutes
			};
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return {
				unit: "hours",
				count: hours
			};
			return {
				unit: "days",
				count: Math.floor(hours / 24)
			};
		}
		//#endregion
		//#region src/client/keys.ts
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
		const ACTION_KEYS = {
			INSPECT: "action.INSPECT",
			PREVIEW_REWIND: "action.PREVIEW_REWIND",
			REWIND: "action.REWIND",
			FORK: "action.FORK",
			NONE: "action.NONE"
		};
		const ATTRIBUTION_KEYS = {
			AGENT: "attribution.AGENT",
			BASELINE: "attribution.BASELINE",
			DRIFT: "attribution.DRIFT",
			UNCERTAIN: "attribution.UNCERTAIN"
		};
		const EVIDENCE_KEYS = {
			complete: "evidence.complete",
			partial: "evidence.partial",
			missing: "evidence.missing"
		};
		/**
		* The host's status words, for the states the timeline cannot express.
		*
		* The card's own status line is the conversation's — it is the thing the user is
		* looking at, and it is the same numbering and the same turns. But the host knows
		* end states the conversation does not derive: a turn that never started, one
		* cancelled before it ran, one the host marked interrupted. Those are shown as a
		* second chip rather than allowed to overwrite the first, because they are two
		* claims and only one of them is about the timeline. A host status the timeline
		* *can* express is left out — repeating it as "host recorded: running" next to
		* "Running" would be noise pretending to be evidence.
		*/
		const HOST_ONLY_STATUS_KEYS = {
			pending: "status.pending",
			interrupted: "status.interrupted",
			cancelled: "status.cancelled"
		};
		const FRESHNESS_KEYS = {
			loading: "freshness.loading",
			error: "freshness.error",
			stale: "freshness.stale",
			live: "freshness.live",
			stable: "freshness.stable"
		};
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
			if (candidate.apiVersion !== 2) {
				const host = String(candidate.apiVersion);
				return unusable(`the host answers contract version ${host}, this bundle speaks 2`);
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
		//#region src/client/remote-answers.ts
		/**
		* Ask the host for a bounded set of things, and keep the answers.
		*
		* The panel has two of these — a turn's detail, and one path's diff — and they
		* have the same four interesting properties, which is why they are one piece of
		* code rather than two. Both are asked for *on demand* rather than with the list
		* (`docs/ARCHITECTURE.md §44.2`); both are asked once per key per round of
		* asking; both keep the answer so that closing and reopening does not re-ask; and
		* both must treat an answer that arrives after a refresh as belonging to the
		* previous round, not to this one.
		*
		* The caller supplies the *wanted* keys and the way to ask for one; the hook
		* decides when a wanted key needs a round trip. That split is what makes opening something a
		* state rather than an event: a re-render cannot restart a request, and a request
		* in flight is visible as `loading` to anyone who asks for that key.
		*/
		const NOTHING = /* @__PURE__ */ new Map();
		/**
		* The keys, as one string an effect can depend on.
		*
		* A key is a host-generated id or a repo-relative path, and a path cannot contain
		* a NUL — git's own formats are NUL-delimited for exactly that reason — so joining
		* on one cannot make two different sets look like the same one.
		*/
		const join = (keys) => keys.join("\0");
		/**
		* Answer the wanted keys, once each, in this generation.
		*
		* `generation` is carried *in* the cache rather than cleared by an effect, so
		* answers from an older generation are neither shown nor reused: a refreshed list
		* and a stale detail can never sit in the same card. Where the list itself uses
		* `freshness.ts` to reach the same conclusion, this is that conclusion for the
		* things that are only fetched when someone asks for them.
		*/
		function useRemoteAnswers(ask, keys, generation) {
			const [cache, setCache] = (0, react.useState)(() => ({
				generation,
				entries: /* @__PURE__ */ new Map()
			}));
			const entries = cache.generation === generation ? cache.entries : NOTHING;
			const live = (0, react.useRef)(generation);
			(0, react.useEffect)(() => {
				live.current = generation;
				return () => {
					live.current = -1;
				};
			}, [generation]);
			const latest = (0, react.useRef)(keys);
			latest.current = keys;
			const wanted = join(keys);
			(0, react.useEffect)(() => {
				if (wanted === "") return;
				const pending = latest.current.filter((key) => !entries.has(key));
				if (pending.length === 0) return;
				setCache((current) => {
					const next = new Map(current.generation === generation ? current.entries : NOTHING);
					for (const key of pending) next.set(key, { kind: "loading" });
					return {
						generation,
						entries: next
					};
				});
				for (const key of pending) ask(key).then((reply) => {
					if (live.current !== generation) return;
					setCache((current) => {
						const next = new Map(current.generation === generation ? current.entries : NOTHING);
						next.set(key, read$1(reply));
						return {
							generation,
							entries: next
						};
					});
				});
			}, [
				wanted,
				entries,
				ask,
				generation
			]);
			return entries;
		}
		const read$1 = (reply) => {
			switch (reply.kind) {
				case "value": return {
					kind: "value",
					value: reply.value
				};
				case "absent": return { kind: "absent" };
				case "unusable": return {
					kind: "failed",
					reason: reply.detail
				};
			}
		};
		//#endregion
		//#region src/client/file-diffs.ts
		/**
		* One path's diff, fetched when a reader clicks it.
		*
		* A diff is the largest thing this panel can ask for and the least often wanted —
		* a reader looks at the files that explain the verdict, not at all of them — so
		* it is asked for per path, on the click, and never bundled into the turn detail
		* (`docs/ARCHITECTURE.md §44.2`, `§28.3`).
		*
		* One selection at a time, deliberately. Two open diffs would be two scrolling
		* panes in a side panel, and the comparison a reader actually makes is between a
		* diff and the verdict above it, not between two files.
		*/
		/** A path inside a turn, as one key: a path cannot contain a NUL. */
		const diffKey = (turnId, path) => `${turnId}\u0000${path}`;
		function useFileDiffs(host, generation) {
			const [selected, setSelected] = (0, react.useState)(void 0);
			return {
				states: useRemoteAnswers((0, react.useCallback)(async (key) => {
					const [turnId = "", path = ""] = key.split("\0");
					const reply = await host.getDiff({
						apiVersion: 2,
						turnId,
						path
					});
					switch (reply.kind) {
						case "value": return {
							kind: "value",
							value: reply.value.diff
						};
						case "absent": return { kind: "absent" };
						case "unusable": return {
							kind: "unusable",
							detail: reply.detail
						};
					}
				}, [host]), selected === void 0 ? [] : [selected], generation),
				selected,
				select: (0, react.useCallback)((turnId, path) => {
					const key = diffKey(turnId, path);
					setSelected((current) => current === key ? void 0 : key);
				}, [])
			};
		}
		//#endregion
		//#region src/client/DiffView.tsx
		const SOURCE_KEYS = {
			"recovery-blob": "diff.source.recovery-blob",
			"git-object": "diff.source.git-object",
			absent: "diff.source.absent",
			unknown: "diff.source.unknown"
		};
		const REASON_KEYS = {
			"no-checkpoint": "diff.reason.no-checkpoint",
			"not-recorded": "diff.reason.not-recorded",
			"missing-blob": "diff.reason.missing-blob",
			"git-unavailable": "diff.reason.git-unavailable"
		};
		/** The character that carries a line's meaning, so colour never has to. */
		const MARK = {
			context: " ",
			add: "+",
			remove: "-"
		};
		function DiffView({ state, t }) {
			switch (state.kind) {
				case "loading": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					role: "status",
					className: "turnscope-diff-note",
					children: t("diff.loading")
				});
				case "absent": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "turnscope-diff-note",
					children: t("diff.missing")
				});
				case "failed": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					role: "note",
					className: "turnscope-diff-note",
					children: t("diff.failed", { reason: state.reason })
				});
				case "value": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Loaded$1, {
					diff: state.value,
					t
				});
			}
		}
		function Loaded$1({ diff, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "turnscope-diff",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "turnscope-diff-head",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "turnscope-path",
							children: diff.path
						}),
						diff.previousPath === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "turnscope-rename",
							children: t("change.from", { path: diff.previousPath })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "turnscope-attribution",
							"data-attribution": diff.attribution,
							children: t(ATTRIBUTION_KEYS[diff.attribution])
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Side, {
							label: t("diff.sideLabel.before"),
							side: diff.before,
							t
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Side, {
							label: t("diff.sideLabel.after"),
							side: diff.after,
							t
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Body, {
					availability: diff.availability,
					t
				})]
			});
		}
		/**
		* What one side was, and — when it could not be read — that it could not be.
		*
		* `unknown` is the case worth the words: the side exists and its bytes are gone,
		* which a reader must not read as "the file was not there". That is the whole
		* reason `source` distinguishes `unknown` from `absent`.
		*/
		function Side({ label, side, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "turnscope-diff-side",
				"data-source": side.source,
				children: [t("diff.side", {
					label,
					source: t(SOURCE_KEYS[side.source]),
					lines: side.lineCount,
					bytes: side.byteSize
				}), side.endsWithNewline ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "turnscope-diff-nonewline",
					children: t("diff.noNewline")
				})]
			});
		}
		function Body({ availability, t }) {
			switch (availability.kind) {
				case "text": return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "turnscope-hunks",
					children: [availability.hunks.map((hunk) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Hunk, {
						hunk,
						t
					}, hunkKey(hunk))), availability.truncated ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "note",
						className: "turnscope-diff-note",
						children: t("diff.truncated")
					}) : null]
				});
				case "binary": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "turnscope-diff-note",
					children: t("diff.binary")
				});
				case "unavailable": return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					role: "note",
					className: "turnscope-diff-note",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("diff.unavailable") }),
						" ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "turnscope-diff-reason",
							children: t(REASON_KEYS[availability.reason])
						}),
						" ",
						availability.detail
					]
				});
			}
		}
		const hunkKey = (hunk) => `${hunk.beforeStart}:${hunk.afterStart}`;
		function Hunk({ hunk, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "turnscope-hunk",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "turnscope-hunk-head",
					children: t("diff.hunk", {
						beforeStart: hunk.beforeStart,
						beforeCount: hunk.beforeCount,
						afterStart: hunk.afterStart,
						afterCount: hunk.afterCount
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
					className: "turnscope-hunk-body",
					children: hunk.lines.map((line, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "turnscope-diff-line",
						"data-kind": line.kind,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "turnscope-diff-mark",
								children: MARK[line.kind]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "turnscope-diff-number",
								children: line.beforeLine ?? ""
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "turnscope-diff-number",
								children: line.afterLine ?? ""
							}),
							line.text,
							"\n"
						]
					}, index))
				})]
			});
		}
		//#endregion
		//#region src/client/TurnDetail.tsx
		const KIND_KEYS = {
			created: "change.created",
			modified: "change.modified",
			deleted: "change.deleted",
			renamed: "change.renamed",
			binary_changed: "change.binary"
		};
		const VALIDATION_KEYS = {
			test: "validation.test",
			typecheck: "validation.typecheck",
			lint: "validation.lint",
			build: "validation.build",
			compile: "validation.compile"
		};
		const RESULT_KEYS = {
			passed: "result.passed",
			failed: "result.failed",
			unknown: "result.unknown"
		};
		const AGE_KEYS = {
			now: "age.now",
			seconds: "age.seconds",
			minutes: "age.minutes",
			hours: "age.hours",
			days: "age.days"
		};
		function TurnDetailView({ state, now, diffs, t }) {
			switch (state.kind) {
				case "loading": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					role: "status",
					className: "turnscope-detail-note",
					children: t("detail.loading")
				});
				case "absent": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "turnscope-detail-note",
					children: t("detail.missing")
				});
				case "failed": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					role: "note",
					className: "turnscope-detail-note",
					children: t("detail.failed", { reason: state.reason })
				});
				case "value": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Loaded, {
					detail: state.value,
					now,
					diffs,
					t
				});
			}
		}
		function Loaded({ detail, now, diffs, t }) {
			const { summary } = detail;
			const open = diffs === void 0 ? void 0 : detail.changes.find((item) => diffKey(item.turnId, item.path) === diffs.selected);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "turnscope-detail",
				children: [
					detail.safety === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "turnscope-detail-note",
						children: t("detail.unjudged")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Verdict, {
						verdict: detail.safety,
						evidence: summary.evidenceCompleteness,
						now,
						t
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "turnscope-section",
						"aria-label": t("detail.changes"),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h4", { children: [
								t("detail.changes"),
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "turnscope-count",
									children: detail.changes.length
								})
							] }),
							detail.changes.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "turnscope-detail-note",
								children: t("detail.noChanges")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: "turnscope-changes",
								children: detail.changes.map((change) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Change, {
									change,
									diffs,
									t
								}, change.id))
							}),
							open === void 0 || diffs === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DiffView, {
								t,
								state: diffs.states.get(diffKey(open.turnId, open.path)) ?? { kind: "loading" }
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "turnscope-section",
						"aria-label": t("detail.tests"),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h4", { children: [
							t("detail.tests"),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "turnscope-count",
								children: detail.tests.length
							})
						] }), detail.tests.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "turnscope-detail-note",
							children: t("detail.noTests")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "turnscope-tests",
							children: detail.tests.map((test) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Test, {
								test,
								t
							}, test.id))
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "turnscope-section",
						"aria-label": t("detail.commands"),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h4", { children: [
							t("detail.commands"),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "turnscope-count",
								children: detail.commands.length
							})
						] }), detail.commands.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "turnscope-detail-note",
							children: t("detail.noCommands")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "turnscope-commands",
							children: detail.commands.map((command) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Command, {
								command,
								t
							}, command.id))
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "turnscope-detail-note turnscope-recovery-note",
						children: t("detail.noWrites")
					})
				]
			});
		}
		/**
		* The verdict, its reasons, and what the host says could be done.
		*
		* The reason text is the host's, in the language the rule was written in, and it
		* is not translated here: a reason is a specific claim derived from a specific
		* rule, and rewording it in the client would be a second place where safety
		* sentences are authored — with nothing keeping the two in step. What the client
		* *does* add is the structure (`§14.2`: the level is a statement, not a hedge) and
		* the codes, so a reader can cite what they are looking at.
		*/
		function Verdict({ verdict, evidence, now, t }) {
			const age = ageOf(verdict.evaluatedAt, now);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "turnscope-section",
				"aria-label": t("detail.safety"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h4", {
						className: "turnscope-verdict",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "turnscope-safety",
								"data-level": verdict.level,
								children: t(LEVEL_KEYS[verdict.level])
							}),
							evidence === "complete" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "turnscope-evidence",
								"data-evidence": evidence,
								children: t(EVIDENCE_KEYS[evidence])
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "turnscope-action",
								children: [
									t("action.recommended"),
									" ",
									t(ACTION_KEYS[verdict.recommendedAction])
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "turnscope-evaluated",
								children: t("safety.evaluatedAt", { age: t(AGE_KEYS[age.unit], { count: age.count }) })
							})
						]
					}),
					verdict.reasons.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "turnscope-detail-note",
						children: t("detail.noReasons")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "turnscope-reasons",
						children: verdict.reasons.map((reason) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Reason, {
							reason,
							t
						}, reason.code + (reason.path ?? "")))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "turnscope-allowed",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "turnscope-action-label",
								children: t("detail.allowed")
							}),
							" ",
							verdict.allowedActions.length === 0 ? t("detail.allowedNone") : verdict.allowedActions.map((action) => t(ACTION_KEYS[action])).join(" · ")
						]
					})
				]
			});
		}
		function Reason({ reason, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "turnscope-reason",
				"data-severity": reason.severity,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "turnscope-reason-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "turnscope-reason-code",
							children: reason.code
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
							className: "turnscope-reason-title",
							children: reason.title
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "turnscope-reason-detail",
						children: reason.detail
					}),
					reason.path === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
						className: "turnscope-reason-path",
						children: reason.path
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "turnscope-reason-evidence",
						children: t("detail.evidenceCount", { count: reason.evidenceRefs.length })
					})
				]
			});
		}
		function Change({ change, diffs, t }) {
			const key = diffKey(change.turnId, change.path);
			const open = diffs?.selected === key;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "turnscope-change",
				"data-kind": change.kind,
				"data-attribution": change.attribution,
				children: [
					diffs === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "turnscope-path",
						children: change.path
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "turnscope-path turnscope-path-button",
						"aria-expanded": open,
						onClick: () => diffs.select(change.turnId, change.path),
						children: change.path
					}),
					change.previousPath === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "turnscope-rename",
						children: t("change.from", { path: change.previousPath })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "turnscope-kind",
						children: t(KIND_KEYS[change.kind])
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "turnscope-attribution",
						"data-attribution": change.attribution,
						children: t(ATTRIBUTION_KEYS[change.attribution])
					}),
					change.baseline ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "turnscope-baseline",
						children: t("attribution.baseline")
					}) : null,
					change.confidence === "low" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "turnscope-confidence",
						children: t("attribution.lowConfidence")
					}) : null,
					diffs === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "turnscope-diff-toggle",
						children: t(open ? "diff.hide" : "diff.show")
					})
				]
			});
		}
		function Test({ test, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "turnscope-test",
				"data-result": test.status,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "turnscope-validation-kind",
						children: t(VALIDATION_KEYS[test.kind])
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "turnscope-result",
						children: t(RESULT_KEYS[test.status])
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "turnscope-test-summary",
						children: test.summary
					})
				]
			});
		}
		function Command({ command, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "turnscope-command",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
						className: "turnscope-command-text",
						children: command.command
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "turnscope-exit",
						"data-exit": command.exitCode === 0 ? "ok" : "bad",
						children: command.exitCode === void 0 ? t("detail.exitUnknown") : t("detail.exit", { code: command.exitCode })
					}),
					command.durationMs === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "turnscope-duration",
						children: [command.durationMs, " ms"]
					})
				]
			});
		}
		//#endregion
		//#region src/client/freshness.ts
		/**
		* Classify the answer against the timeline.
		*
		* `stale` is checked before `live` on purpose. A turn that is running *and* newer
		* than the answer is exactly the case where a reader is most likely to believe a
		* verdict that has not been computed yet, so "we are behind" is the more useful
		* of the two things to say.
		*
		* The empty timeline is not a special case: with no local turns nothing can be
		* behind, so the answer is `live` or `stable` depending on the host's own rows.
		* That reads correctly — a session with no turns in it is in step with itself.
		*/
		function freshnessOf(local, recorded) {
			if (recorded === void 0) return "loading";
			if (recorded.problem !== void 0) return "error";
			if (local.some((turn) => !recorded.turns.has(turn.turn))) return "stale";
			return (local.length === 0 ? [...recorded.turns.values()].some((turn) => turn.status === "running") : local.some((turn) => turn.status === "running")) ? "live" : "stable";
		}
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
		*
		* The whole host row is carried rather than just its verdict, because the row is
		* where "how many files did this turn change" and "how complete is its evidence"
		* live, and those belong on the same card as the badge: a verdict shown without
		* the evidence it rests on can be read as more certain than it is.
		*/
		/**
		* Ask the host once per session, and again when asked.
		*
		* The answer is stored with the session it belongs to rather than cleared when
		* the session changes. Two things fall out of that: a swap to another session
		* shows nothing until its own answer lands — the old rows are for a different
		* conversation and their turn numbers mean nothing here — while a **refresh**
		* keeps the badges that are already on screen instead of blinking them out and
		* back for a turn that did not change.
		*
		* `undefined` while the first answer is in flight, so the view renders what it
		* already knows rather than an empty frame that would then fill in — a shift from
		* "no safety information" to "safety information" is worse than a moment of
		* neither.
		*
		* `generation` is the caller's refresh counter: bumping it asks again, and it is
		* owned by the container rather than by this hook because a refresh also has to
		* retire the cached turn details. One counter, so the list and the details are
		* always answers to the same round of asking.
		*/
		function useRecordedTurns(host, sessionId, generation) {
			const [answer, setAnswer] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				let live = true;
				host.listTurns({
					apiVersion: 2,
					sessionId,
					limit: TURN_PAGE_LIMIT.default
				}).then((reply) => {
					if (live) setAnswer({
						sessionId,
						recorded: read(reply)
					});
				});
				return () => {
					live = false;
				};
			}, [
				host,
				sessionId,
				generation
			]);
			return { state: answer !== void 0 && answer.sessionId === sessionId ? answer.recorded : void 0 };
		}
		const read = (answer) => {
			switch (answer.kind) {
				case "value": return { turns: byOrdinal(answer.value.turns) };
				case "absent": return { turns: /* @__PURE__ */ new Map() };
				case "unusable": return {
					turns: /* @__PURE__ */ new Map(),
					problem: answer.detail
				};
			}
		};
		/**
		* Index the rows by turn number.
		*
		* A turn with no row is left out rather than given a default verdict. "Nobody
		* judged this turn" and "this turn was judged safe" are different claims, and
		* only one of them is worth putting next to a one-click recovery button — which
		* is what the next version of this panel grows.
		*/
		const byOrdinal = (turns) => new Map(turns.map((turn) => [turn.ordinal, turn]));
		//#endregion
		//#region src/client/turn-details.ts
		/**
		* The detail of one turn, fetched when a reader asks for it.
		*
		* Separate from the session list because the two are asked at different times and
		* for different reasons (`docs/ARCHITECTURE.md §44.2`): the list is the screen,
		* and the detail is what a reader opens *after* deciding a turn is interesting.
		* Folding the detail into the list would ship every turn's activities, commands,
		* tests and changes to a panel that renders none of them.
		*
		* Opening a card only records *intent*; `useRemoteAnswers` turns intent into a
		* request. That is what keeps a request from being restarted by a re-render, and
		* what makes "opened but not yet answered" a state rather than a flag on a click.
		*/
		function useTurnDetails(host, generation) {
			const [expanded, setExpanded] = (0, react.useState)(/* @__PURE__ */ new Set());
			return {
				states: useRemoteAnswers((0, react.useCallback)((turnId) => host.getTurnDetail({
					apiVersion: 2,
					turnId
				}), [host]), [...expanded], generation),
				expanded,
				toggle: (0, react.useCallback)((turnId) => {
					setExpanded((current) => {
						const next = new Set(current);
						if (next.delete(turnId)) return next;
						next.add(turnId);
						return next;
					});
				}, [])
			};
		}
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
		function TurnscopeView({ useSession, t, recorded, onRefresh, detail }) {
			const openState = useSession((snapshot) => snapshot.openState);
			const turns = useSession(deriveTurnModels);
			if (openState === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				role: "status",
				children: t("state.loading")
			});
			if (turns.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: t("state.empty") });
			const freshness = freshnessOf(turns, recorded);
			const problem = recorded?.problem;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				"aria-label": t("view.title"),
				className: "turnscope-root",
				"data-freshness": freshness,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "turnscope-toolbar",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "turnscope-freshness",
							"data-freshness": freshness,
							children: t(FRESHNESS_KEYS[freshness])
						}), onRefresh === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "turnscope-refresh",
							onClick: onRefresh,
							disabled: freshness === "loading",
							children: t("action.refresh")
						})]
					}),
					problem === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "note",
						className: "turnscope-note",
						children: t("safety.unavailable", { reason: problem })
					}),
					turns.map((turn) => {
						const summary = recorded?.turns.get(turn.turn);
						const hostOnly = summary === void 0 ? void 0 : HOST_ONLY_STATUS_KEYS[summary.status];
						const open = summary !== void 0 && detail?.feed.expanded.has(summary.turnId) === true;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
							"aria-label": `Turn ${turn.turn}`,
							className: "turnscope-card",
							"data-status": turn.status,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
									className: "turnscope-header",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: ["Turn ", turn.turn] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "turnscope-status",
											children: t(STATUS_KEYS[turn.status])
										}),
										hostOnly === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "turnscope-host-status",
											children: t("status.hostSays", { status: t(hostOnly) })
										}),
										summary === void 0 ? null : summary.safety === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "turnscope-safety",
											"data-level": "none",
											children: t("safety.unjudged")
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "turnscope-safety",
											"data-level": summary.safety.level,
											children: t(LEVEL_KEYS[summary.safety.level])
										}), summary.evidenceCompleteness === "complete" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "turnscope-evidence",
											"data-evidence": summary.evidenceCompleteness,
											children: t(EVIDENCE_KEYS[summary.evidenceCompleteness])
										})] })
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
									className: "turnscope-summary",
									children: [
										summary === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("summary.changes") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: summary.changeCount })] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("summary.tools") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: turn.toolCount })] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("summary.errors") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: turn.errorCount })] }),
										turn.durationMs === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("summary.duration") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [turn.durationMs, " ms"] })] })
									]
								}),
								summary?.safety === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: "turnscope-action",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "turnscope-action-label",
											children: t("action.recommended")
										}),
										" ",
										t(ACTION_KEYS[summary.safety.recommendedAction])
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
									className: "turnscope-activities",
									children: turn.activities.map((activity) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: activity.label }, activity.id))
								}),
								summary === void 0 || detail === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "turnscope-expand",
									"aria-expanded": open,
									onClick: () => detail.feed.toggle(summary.turnId),
									children: t(open ? "detail.hide" : "detail.show")
								}),
								open && summary !== void 0 && detail !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TurnDetailView, {
									t,
									now: detail.now,
									diffs: detail.diffs,
									state: detail.feed.states.get(summary.turnId) ?? { kind: "loading" }
								}) : null
							]
						}, turn.turn);
					})
				]
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
				const sessionId = props.useSession((snapshot) => snapshot.sessionId);
				const [generation, setGeneration] = (0, react.useState)(0);
				const recorded = useRecordedTurns(host, sessionId, generation);
				const details = useTurnDetails(host, generation);
				const diffs = useFileDiffs(host, generation);
				const refresh = (0, react.useCallback)(() => setGeneration((current) => current + 1), []);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TurnscopeView, {
					...props,
					recorded: recorded.state,
					onRefresh: refresh,
					detail: {
						feed: details,
						diffs,
						now: Date.now()
					}
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
				evaluateSafety: (request) => call("evaluateSafety", request),
				getDiff: (request) => call("getDiff", request)
			};
		}
		const describe = (error) => `${REMOTE_NAMESPACE}: ${error instanceof Error ? error.message : String(error)}`;
		//#endregion
		//#region src/client/locales.ts
		const NS = "turnscope";
		/**
		* The panel's vocabulary.
		*
		* Two rules came from the product spec and are visible in the wording itself.
		* `docs/PRD.md §14.2` forbids hedging about safety — no "probably", no "should be
		* fine" — so a level is a statement and a recommended action is named rather than
		* hinted at ("Safe to rewind", "Fork recommended"). `§14.4` forbids colour as the
		* only carrier of meaning, so every state below is a word first and a colour
		* second, and the words are what a reader (or a screen reader) gets.
		*/
		const zh = {
			"view.title": "轮次",
			"state.loading": "正在加载时间线",
			"state.empty": "此会话还没有可显示的轮次",
			"action.refresh": "刷新",
			"safety.unavailable": "无法向主进程查询安全结论：{reason}",
			"safety.unjudged": "未评估",
			"safety.SAFE": "安全",
			"safety.CAUTION": "注意",
			"safety.FORK_ONLY": "仅可分叉",
			"safety.UNPROTECTED": "无保护",
			"action.recommended": "建议动作",
			"action.INSPECT": "先人工检查",
			"action.PREVIEW_REWIND": "回滚前先预览",
			"action.REWIND": "可安全回滚",
			"action.FORK": "建议分叉后继续",
			"action.NONE": "不提供恢复动作",
			"status.running": "运行中",
			"status.completed": "已完成",
			"status.failed": "失败",
			"status.maxTokens": "达到输出限制",
			"status.pending": "待开始",
			"status.interrupted": "已中断",
			"status.cancelled": "已取消",
			"status.hostSays": "主进程记录：{status}",
			"summary.changes": "变更文件",
			"summary.tools": "工具",
			"summary.errors": "异常",
			"summary.duration": "耗时",
			"evidence.complete": "证据完整",
			"evidence.partial": "证据不完整",
			"evidence.missing": "证据缺失",
			"freshness.loading": "正在查询主进程",
			"freshness.error": "未能查询主进程",
			"freshness.live": "实时",
			"freshness.stale": "落后于主进程",
			"freshness.stable": "与主进程一致",
			"detail.show": "展开详情",
			"detail.hide": "收起详情",
			"detail.loading": "正在读取该轮次的记录",
			"detail.missing": "主进程没有该轮次的记录",
			"detail.failed": "未能读取该轮次的记录：{reason}",
			"detail.unjudged": "主进程还没有评估该轮次的安全性",
			"detail.safety": "安全结论",
			"detail.noReasons": "该结论没有给出理由",
			"detail.allowed": "允许的动作",
			"detail.allowedNone": "无",
			"detail.evidenceCount": "依据 {count} 项",
			"detail.changes": "变更文件",
			"detail.noChanges": "该轮次没有记录到文件变更",
			"detail.tests": "验证",
			"detail.noTests": "该轮次没有记录到验证命令",
			"detail.commands": "命令",
			"detail.noCommands": "该轮次没有记录到命令",
			"detail.exit": "退出码 {code}",
			"detail.exitUnknown": "退出码未知",
			"detail.noWrites": "本版本不写入工作区，恢复动作由后续版本提供。",
			"safety.evaluatedAt": "评估于 {age}",
			"age.now": "刚刚",
			"age.seconds": "{count} 秒前",
			"age.minutes": "{count} 分钟前",
			"age.hours": "{count} 小时前",
			"age.days": "{count} 天前",
			"change.created": "新增",
			"change.modified": "修改",
			"change.deleted": "删除",
			"change.renamed": "重命名",
			"change.binary": "二进制变更",
			"change.from": "来自 {path}",
			"attribution.AGENT": "本轮改动",
			"attribution.BASELINE": "本轮之前就已修改",
			"attribution.DRIFT": "本轮之后又被改动",
			"attribution.UNCERTAIN": "无法确定来源",
			"attribution.baseline": "本轮开始时已脏",
			"attribution.lowConfidence": "依据不足",
			"validation.test": "测试",
			"validation.typecheck": "类型检查",
			"validation.lint": "静态检查",
			"validation.build": "构建",
			"validation.compile": "编译",
			"result.passed": "通过",
			"result.failed": "未通过",
			"result.unknown": "未知",
			"diff.show": "查看差异",
			"diff.hide": "收起差异",
			"diff.loading": "正在读取差异",
			"diff.missing": "该轮次没有记录到这条路径的差异",
			"diff.failed": "未能读取差异：{reason}",
			"diff.binary": "二进制文件：只比较体积与摘要，不做逐行对比",
			"diff.unavailable": "无法生成差异",
			"diff.truncated": "差异过长，只显示前一部分",
			"diff.side": "{label}：{source}，{lines} 行 / {bytes} 字节",
			"diff.sideLabel.before": "之前",
			"diff.sideLabel.after": "之后",
			"diff.source.recovery-blob": "本轮保存的内容",
			"diff.source.git-object": "仓储中的提交内容",
			"diff.source.absent": "文件不存在",
			"diff.source.unknown": "内容未能读取",
			"diff.noNewline": "末尾无换行",
			"diff.hunk": "@@ -{beforeStart},{beforeCount} +{afterStart},{afterCount} @@",
			"diff.reason.no-checkpoint": "缺少检查点",
			"diff.reason.not-recorded": "未保存内容",
			"diff.reason.missing-blob": "内容已不可用",
			"diff.reason.git-unavailable": "无法访问仓储"
		};
		const en = {
			"view.title": "Turns",
			"state.loading": "Loading timeline",
			"state.empty": "No turns to display in this session",
			"action.refresh": "Refresh",
			"safety.unavailable": "Could not ask the host for safety verdicts: {reason}",
			"safety.unjudged": "Not judged",
			"safety.SAFE": "Safe",
			"safety.CAUTION": "Caution",
			"safety.FORK_ONLY": "Fork only",
			"safety.UNPROTECTED": "Unprotected",
			"action.recommended": "Recommended",
			"action.INSPECT": "Inspect before acting",
			"action.PREVIEW_REWIND": "Preview rewind first",
			"action.REWIND": "Safe to rewind",
			"action.FORK": "Fork recommended",
			"action.NONE": "No recovery action",
			"status.running": "Running",
			"status.completed": "Completed",
			"status.failed": "Failed",
			"status.maxTokens": "Output limit reached",
			"status.pending": "Not started",
			"status.interrupted": "Interrupted",
			"status.cancelled": "Cancelled",
			"status.hostSays": "Host recorded: {status}",
			"summary.changes": "Changed files",
			"summary.tools": "Tools",
			"summary.errors": "Errors",
			"summary.duration": "Duration",
			"evidence.complete": "Evidence complete",
			"evidence.partial": "Evidence incomplete",
			"evidence.missing": "Evidence missing",
			"freshness.loading": "Asking the host",
			"freshness.error": "Could not ask the host",
			"freshness.live": "Live",
			"freshness.stale": "Behind the host",
			"freshness.stable": "In step with the host",
			"detail.show": "Show detail",
			"detail.hide": "Hide detail",
			"detail.loading": "Reading this turn’s record",
			"detail.missing": "The host has no record of this turn",
			"detail.failed": "Could not read this turn’s record: {reason}",
			"detail.unjudged": "The host has not judged this turn yet",
			"detail.safety": "Safety",
			"detail.noReasons": "The verdict came with no reasons",
			"detail.allowed": "Allowed",
			"detail.allowedNone": "None",
			"detail.evidenceCount": "{count} fact(s) cited",
			"detail.changes": "Changed files",
			"detail.noChanges": "No file changes were recorded for this turn",
			"detail.tests": "Validation",
			"detail.noTests": "No validation commands were recorded for this turn",
			"detail.commands": "Commands",
			"detail.noCommands": "No commands were recorded for this turn",
			"detail.exit": "Exit {code}",
			"detail.exitUnknown": "Exit code unknown",
			"detail.noWrites": "This version does not write to your workspace; recovery actions arrive in a later version.",
			"safety.evaluatedAt": "Evaluated {age}",
			"age.now": "just now",
			"age.seconds": "{count}s ago",
			"age.minutes": "{count}m ago",
			"age.hours": "{count}h ago",
			"age.days": "{count}d ago",
			"change.created": "Created",
			"change.modified": "Modified",
			"change.deleted": "Deleted",
			"change.renamed": "Renamed",
			"change.binary": "Binary changed",
			"change.from": "from {path}",
			"attribution.AGENT": "Changed by this turn",
			"attribution.BASELINE": "Already modified before this turn",
			"attribution.DRIFT": "Changed again after this turn",
			"attribution.UNCERTAIN": "Source unknown",
			"attribution.baseline": "Dirty when the turn started",
			"attribution.lowConfidence": "Weak evidence",
			"validation.test": "Test",
			"validation.typecheck": "Typecheck",
			"validation.lint": "Lint",
			"validation.build": "Build",
			"validation.compile": "Compile",
			"result.passed": "Passed",
			"result.failed": "Failed",
			"result.unknown": "Unknown",
			"diff.show": "Show diff",
			"diff.hide": "Hide diff",
			"diff.loading": "Reading the diff",
			"diff.missing": "This turn recorded no diff for that path",
			"diff.failed": "Could not read the diff: {reason}",
			"diff.binary": "Binary file: sizes and digests can be compared, lines cannot",
			"diff.unavailable": "No comparison could be made",
			"diff.truncated": "The diff is long; only its first part is shown",
			"diff.side": "{label}: {source}, {lines} line(s) / {bytes} byte(s)",
			"diff.sideLabel.before": "Before",
			"diff.sideLabel.after": "After",
			"diff.source.recovery-blob": "content saved with the turn",
			"diff.source.git-object": "content committed in the repository",
			"diff.source.absent": "the file did not exist",
			"diff.source.unknown": "the content could not be read",
			"diff.noNewline": "no final newline",
			"diff.hunk": "@@ -{beforeStart},{beforeCount} +{afterStart},{afterCount} @@",
			"diff.reason.no-checkpoint": "no checkpoint",
			"diff.reason.not-recorded": "content was not saved",
			"diff.reason.missing-blob": "content is no longer available",
			"diff.reason.git-unavailable": "the repository could not be read"
		};
		//#endregion
		//#region src/client/styles.ts
		const STYLE_ID = "@zhaolianghz/dsh-turnscope";
		/**
		* The panel's styling.
		*
		* Deliberately no per-level colours. `docs/PRD.md §14.4` forbids colour as the
		* only carrier of meaning, and the surest way to obey that is to carry no
		* meaning in colour at all: every state here is a word, and the stylesheet only
		* groups things — a chip is a chip whether it says "Safe" or "Unprotected".
		* (The one exception is inherited from the host's own page: `currentColor` and
		* its border/opacity variables, so the panel matches the theme it is drawn in
		* instead of asserting one.)
		*/
		const CSS = `
.turnscope-root{display:grid;gap:12px;padding:16px;overflow:auto}
.turnscope-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}
.turnscope-freshness{font-size:.85em;opacity:.8}
.turnscope-refresh{font:inherit;color:inherit;background:none;cursor:pointer;
  padding:2px 10px;border-radius:6px;border:1px solid currentColor}
.turnscope-refresh:disabled{opacity:.5;cursor:default}
.turnscope-card{border:1px solid var(--border-color,currentColor);border-radius:8px;padding:12px}
.turnscope-header{display:flex;align-items:center;flex-wrap:wrap;gap:12px}
.turnscope-status{font-weight:600}
.turnscope-host-status{font-size:.85em;opacity:.8}
.turnscope-summary{display:flex;flex-wrap:wrap;gap:16px;margin:10px 0}.turnscope-summary div{display:flex;gap:6px}
.turnscope-activities{display:grid;gap:6px;margin:0;padding-inline-start:22px}
.turnscope-note{opacity:.8;margin:0}
.turnscope-action{display:flex;gap:6px;margin:0}
.turnscope-action-label{opacity:.7}
.turnscope-safety,.turnscope-evidence{font-size:.85em;padding:1px 6px;border-radius:999px;border:1px solid currentColor;opacity:.9}
.turnscope-evidence{border-style:dashed}
.turnscope-expand{font:inherit;color:inherit;background:none;cursor:pointer;justify-self:start;
  padding:2px 10px;border-radius:6px;border:1px solid currentColor}
.turnscope-detail{display:grid;gap:14px;margin-top:10px;padding-top:10px;
  border-top:1px solid var(--border-color,currentColor)}
.turnscope-section{display:grid;gap:6px}
.turnscope-section h4{display:flex;align-items:center;gap:8px;margin:0;font-size:.95em}
.turnscope-count{font-weight:400;opacity:.7}
.turnscope-detail-note{margin:0;opacity:.8;font-size:.9em}
.turnscope-recovery-note{font-style:italic}
.turnscope-changes,.turnscope-tests,.turnscope-commands,.turnscope-reasons{display:grid;gap:6px;margin:0;
  padding-inline-start:18px}
.turnscope-change{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.turnscope-path,.turnscope-command-text,.turnscope-reason-path,.turnscope-rename,
.turnscope-validation-kind,.turnscope-result,.turnscope-confidence,.turnscope-baseline{
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
.turnscope-kind,.turnscope-attribution,.turnscope-confidence,.turnscope-baseline,
.turnscope-validation-kind,.turnscope-result,.turnscope-evaluated{opacity:.85}
.turnscope-kind,.turnscope-attribution,.turnscope-confidence,.turnscope-baseline{
  font-size:.85em;padding:0 6px;border-radius:4px;border:1px solid currentColor}
.turnscope-kind,.turnscope-confidence{font-family:inherit}
.turnscope-reason{display:grid;gap:2px}
.turnscope-reason-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.turnscope-reason-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;opacity:.8}
.turnscope-reason-detail{margin:0;opacity:.9}
.turnscope-reason-evidence{font-size:.85em;opacity:.7}
.turnscope-verdict{flex-wrap:wrap}
.turnscope-evaluated{font-size:.85em;margin-inline-start:auto}
.turnscope-allowed{margin:0;display:flex;gap:6px}
.turnscope-command,.turnscope-test{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.turnscope-test-summary{opacity:.9}
.turnscope-path-button{font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  color:inherit;background:none;cursor:pointer;padding:0;border:0;border-bottom:1px dotted currentColor}
.turnscope-diff-toggle{font-size:.8em;opacity:.7}
.turnscope-diff{display:grid;gap:8px;margin-top:8px;padding:8px;border-radius:6px;
  border:1px solid var(--border-color,currentColor)}
.turnscope-diff-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.turnscope-diff-side{font-size:.85em;opacity:.8}
.turnscope-diff-nonewline{margin-inline-start:6px}
.turnscope-hunks{display:grid;gap:8px}
.turnscope-hunk{display:grid;gap:2px}
.turnscope-hunk-head,.turnscope-hunk-body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em}
.turnscope-hunk-head{opacity:.75}
.turnscope-hunk-body{margin:0;white-space:pre;overflow-x:auto}
.turnscope-diff-line{display:block}
/* The mark and the number are the meaning; nothing below relies on colour. */
.turnscope-diff-mark{display:inline-block;width:1ch}
.turnscope-diff-number{display:inline-block;width:5ch;text-align:end;padding-inline-end:1ch;opacity:.55}
.turnscope-diff-note{margin:0;font-size:.9em;opacity:.85}
.turnscope-diff-reason{font-weight:600}
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
			const t = ctx.locale.bind(NS);
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
				label: () => t("view.title")
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
