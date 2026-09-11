import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { Buffer as Buffer$1 } from "node:buffer";
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
//#region src/config.ts
/** Documented defaults, used for absent input and for every invalid field. */
const DEFAULT_CONFIG = Object.freeze({
	enabled: true,
	dataDir: void 0,
	retentionDays: 30,
	retentionBytes: 104857600,
	maxOutputBytes: 32768,
	ignorePaths: Object.freeze([])
});
/**
* Read one field without ever propagating a throw. Host plugins are loaded with
* arbitrary user configuration, which may be an exotic object with an accessor
* that throws. `resolveConfig` is called outside the `apply` fail-open boundary,
* so totality has to be enforced here.
*/
const read = (source, key) => {
	try {
		return source[key];
	} catch {
		return;
	}
};
/** `Array.isArray` itself throws on a revoked proxy, so it is guarded too. */
const isArray = (value) => {
	try {
		return Array.isArray(value);
	} catch {
		return false;
	}
};
const isRecord$1 = (value) => typeof value === "object" && value !== null && !isArray(value);
const isStringArray = (value) => isArray(value) && value.every((item) => typeof item === "string");
const readBoolean = (source, key, fallback) => {
	const value = read(source, key);
	return typeof value === "boolean" ? value : fallback;
};
const readPositiveInteger = (source, key, fallback) => {
	const value = read(source, key);
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
const readAbsolutePath = (source, key, fallback) => {
	const value = read(source, key);
	return typeof value === "string" && isAbsolute(value) ? value : fallback;
};
const readStringArray = (source, key, fallback) => {
	const value = read(source, key);
	return isStringArray(value) ? Object.freeze([...value]) : fallback;
};
/**
* Turn arbitrary loader-supplied configuration into a valid {@link TurnscopeConfig}.
*
* Total by construction: unknown input and invalid fields fall back to their
* default individually, so one bad field never discards the valid ones.
*/
function resolveConfig(input) {
	const source = isRecord$1(input) ? input : {};
	return Object.freeze({
		enabled: readBoolean(source, "enabled", DEFAULT_CONFIG.enabled),
		dataDir: readAbsolutePath(source, "dataDir", DEFAULT_CONFIG.dataDir),
		retentionDays: readPositiveInteger(source, "retentionDays", DEFAULT_CONFIG.retentionDays),
		retentionBytes: readPositiveInteger(source, "retentionBytes", DEFAULT_CONFIG.retentionBytes),
		maxOutputBytes: readPositiveInteger(source, "maxOutputBytes", DEFAULT_CONFIG.maxOutputBytes),
		ignorePaths: readStringArray(source, "ignorePaths", DEFAULT_CONFIG.ignorePaths)
	});
}
/** Placeholder count for unknown kinds seen after the bounded map is full. */
const IGNORED_KIND_OVERFLOW = "<overflow>";
/**
* Bounded, never-throwing diagnostics sink for the host half.
*
* Recording a diagnostic is best-effort telemetry: it must never grow without
* limit and must never be able to fail the operation that produced it. Entry
* messages are expected to be redacted by the caller.
*/
var Diagnostics = class {
	#ring = new Array(50);
	#ignored = /* @__PURE__ */ new Map();
	#cursor = 0;
	#size = 0;
	#ignoredOverflow = 0;
	/** Append one entry, evicting the oldest once the ring is full. */
	record(entry) {
		this.#ring[this.#cursor] = entry;
		this.#cursor = (this.#cursor + 1) % 50;
		if (this.#size < 50) this.#size += 1;
	}
	/** Entries in chronological order, oldest first. */
	snapshot() {
		const entries = [];
		const start = (this.#cursor - this.#size + 50) % 50;
		for (let offset = 0; offset < this.#size; offset += 1) {
			const entry = this.#ring[(start + offset) % 50];
			if (entry !== void 0) entries.push(entry);
		}
		return Object.freeze(entries);
	}
	/**
	* Count one skipped event of an unrecognised kind. Distinct kinds are capped
	* at {@link IGNORED_KIND_CAPACITY}; anything past that is folded into
	* {@link IGNORED_KIND_OVERFLOW} rather than silently dropped.
	*/
	recordIgnoredKind(kind) {
		const seen = this.#ignored.get(kind);
		if (seen !== void 0) {
			this.#ignored.set(kind, seen + 1);
			return;
		}
		if (this.#ignored.size >= 50) {
			this.#ignoredOverflow += 1;
			return;
		}
		this.#ignored.set(kind, 1);
	}
	/** Per-kind counts of ignored events plus the `'<overflow>'` tally. */
	snapshotIgnoredKinds() {
		const counts = new Map(this.#ignored);
		if (this.#ignoredOverflow > 0) counts.set(IGNORED_KIND_OVERFLOW, this.#ignoredOverflow);
		return counts;
	}
};
//#endregion
//#region src/host/domain/turn-state.ts
/**
* The states a turn cannot move out of.
*
* Exported because the same set has to hold in two places that cannot import
* each other's vocabulary: this predicate, and the `WHERE status NOT IN (…)`
* clause of the one SQL statement that closes a turn. Spelling the five names
* out in both files is how the two silently drift apart; the repository builds
* its clause from this array instead.
*/
const TERMINAL_TURN_STATUSES = Object.freeze([
	"completed",
	"failed",
	"interrupted",
	"cancelled",
	"output_limited"
]);
/** States a turn can still move out of. Everything else is absorbing. */
const TERMINAL = new Set(TERMINAL_TURN_STATUSES);
/** Whether a status is final, i.e. no later event may change it. */
function isTerminal(status) {
	return TERMINAL.has(status);
}
/**
* Apply a status update to a turn, enforcing the transition rules of
* `docs/PRD.md §7.1`.
*
* ```text
* pending → running → completed
*                   ↘ failed
*                   ↘ interrupted
*                   ↘ cancelled
*                   ↘ output_limited
* ```
*
* Total and side-effect free: a terminal turn absorbs every later transition
* and yields `current` unchanged, so a late `completed` can never resurrect an
* interrupted turn — the caller keeps the turn and appends the late event as an
* activity instead.
*
* Deliberately permissive about the *route*: any non-terminal `current` accepts
* any `next`. The graph above is built by the turn assembler, which emits
* `running` on a turn start and a terminal status only on a turn end. Do not
* expect this function to reject an illegal hop; its only job is absorption.
*/
function transitionTurn(current, next) {
	return TERMINAL.has(current) ? current : next;
}
//#endregion
//#region src/host/adapters/dsh/subscribe.ts
/**
* Subscribe to the session event firehose.
*
* Two constraints are load-bearing, and both are the opposite of what the
* surrounding code style would suggest:
*
* - **Register on the context `apply` receives, never a scope-tagged child.**
*   A listener attached to a scope-tagged context is quietly filtered and
*   observes *nothing at all* — no error, no diagnostic, just an empty trace.
*   `inject: ['sessions']` is not required for the listener itself, only for
*   reading `ctx.sessions`, so this subscription works before the store mounts
*   and never needs the recorder to be composed per agent or per session.
* - **Contain every failure inside the listener.** The dispatch is
*   fire-and-forget and the harness reports one listener's failure without
*   detaching it, but this plugin owns the promise that recording is optional;
*   wrapping the body here means the guarantee holds on the harness's terms
*   rather than on the harness's current implementation.
*
* @param ctx - the plugin context; the listener is disposed with its fiber.
* @param onEvent - called for every published event; may throw freely.
* @returns a disposer that unsubscribes.
*/
function subscribeSessionEvents(ctx, onEvent) {
	const listener = (session, event) => {
		try {
			onEvent(session, event);
		} catch {}
	};
	return ctx.on("session/event", listener);
}
//#endregion
//#region src/host/domain/ids.ts
/**
* Deterministic identifier derivation.
*
* Every id is a pure function of values the harness already guarantees to be
* stable, so replaying an event produces the same string and the storage layer's
* upserts deduplicate for free. DSH's `seq` is unique and monotonic per session,
* which is what makes the activity id sound as a key.
*/
/** `${sessionId}:turn:${turn}` — one turn within a session. */
function turnIdFor(sessionId, turn) {
	return `${sessionId}:turn:${turn}`;
}
/** `${sessionId}:act:${seq}` — one activity within a session. */
function activityIdFor(sessionId, seq) {
	return `${sessionId}:act:${seq}`;
}
//#endregion
//#region src/host/redaction/patterns.ts
/** `[REDACTED:<kind>]`, what every match is replaced with. */
const markerFor = (kind) => `[REDACTED:${kind}]`;
const TABLE = [
	{
		kind: "private-key",
		pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g
	},
	{
		kind: "authorization-header",
		pattern: /\bauthorization\s*:\s*(?:bearer|basic|token)\s+[A-Za-z0-9\-._~+/=]{8,}/gi
	},
	{
		kind: "openai-key",
		pattern: /\bsk-[A-Za-z0-9_-]{20,}/g
	},
	{
		kind: "aws-access-key-id",
		pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}/g
	},
	{
		kind: "github-token",
		pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g
	},
	{
		kind: "slack-token",
		pattern: /\bxox[bp]-[A-Za-z0-9-]{10,}/g
	},
	{
		kind: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
	},
	{
		kind: "assignment",
		pattern: new RegExp(`(?:api[_-]?key|apikey|secret|password|passwd|pwd|token)[A-Za-z0-9_]*["']?\\s*[:=]\\s*["']?(?!\\[REDACTED:)[^\\n"',;]{8,}["']?`, "gi")
	}
];
/**
* Frozen, ordered recognition rules.
*
* The array and its entries are frozen but the regexes are not: a global regex
* is mutated in place by `String.prototype.replace` and `RegExp.prototype.test`
* (both write `lastIndex`), and writing to a frozen `RegExp` throws in strict
* mode. Sharing the compiled regexes is still safe because `redact` resets
* `lastIndex` before every use and never reads it afterwards.
*/
const SECRET_PATTERNS = Object.freeze(TABLE.map((entry) => Object.freeze(entry)));
//#endregion
//#region src/host/redaction/redact.ts
/**
* Replace every recognized secret in `input` with a marker.
*
* Pure, synchronous and total: no I/O, no clock, no randomness, and no input it
* throws on — it runs inside the persistence write path, where a partial
* failure would be worse than the redaction itself.
*
* Patterns are applied in `SECRET_PATTERNS` order over the text produced so far,
* each with `lastIndex` reset, so the result depends only on the input and not
* on how many times, or in what order, `redact` has been called before.
*
* Idempotent: `redact(redact(x).text).text === redact(x).text`, because no
* pattern can match a marker (see the assignment guard in `patterns.ts`).
*/
function redact(input) {
	let text = input;
	const fired = /* @__PURE__ */ new Set();
	for (const { kind, pattern } of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		const replaced = text.replace(pattern, () => markerFor(kind));
		if (replaced !== text) {
			fired.add(kind);
			text = replaced;
		}
	}
	return Object.freeze({
		text,
		masked: Object.freeze([...fired].sort())
	});
}
//#endregion
//#region src/host/redaction/truncate.ts
/** Appended to the text whenever bytes were dropped. */
const TRUNCATION_MARKER = "…[truncated]";
const MARKER_BYTES = Buffer$1.byteLength(TRUNCATION_MARKER, "utf8");
/** Highest UTF-8 continuation byte, i.e. a byte of the shape `0b10xxxxxx`. */
const CONTINUATION_MASK = 192;
const CONTINUATION_BITS = 128;
/**
* Length of the longest prefix of `buffer` that is at most `limit` bytes and
* does not end inside a codepoint: walk back at most three bytes — the most a
* single UTF-8 codepoint can span beyond its lead byte.
*/
const prefixLength = (buffer, limit) => {
	let cut = Math.min(limit, buffer.byteLength);
	for (let walked = 0; walked < 3 && cut > 0; walked += 1) {
		const byte = buffer[cut];
		if (byte === void 0 || (byte & CONTINUATION_MASK) !== CONTINUATION_BITS) break;
		cut -= 1;
	}
	return cut;
};
/**
* Cut `input` down to at most `maxBytes` bytes of UTF-8.
*
* Pure, synchronous and total, like the redactor: it runs in the same write
* path, so it must not throw and must not emit broken encoding. Byte slicing
* can land inside a multi-byte codepoint, so the cut walks back to the nearest
* boundary and the dropped tail is reported by the appended marker rather than
* surviving as a replacement character. The limit counts bytes, not characters,
* and it covers the whole result including the marker.
*/
function truncateBytes(input, maxBytes) {
	const buffer = Buffer$1.from(input, "utf8");
	const originalBytes = buffer.byteLength;
	const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : originalBytes;
	if (originalBytes <= limit) return Object.freeze({
		text: input,
		truncated: false,
		originalBytes
	});
	const budget = limit - MARKER_BYTES;
	const body = buffer.toString("utf8", 0, prefixLength(buffer, Math.max(0, budget)));
	return Object.freeze({
		text: budget > 0 ? body + TRUNCATION_MARKER : body,
		truncated: true,
		originalBytes
	});
}
/** The sentinel turn id an unattributed event carries until the assembler places it. */
const unattributedTurnId = (sessionId) => turnIdFor(sessionId, -1);
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const asRecord = (value) => isRecord(value) ? value : void 0;
/** A non-negative safe integer, or `undefined` for anything else. */
const asIndex = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
const asText = (value) => typeof value === "string" && value.length > 0 ? value : void 0;
/** The `turn` an event payload names, if it names a usable one. */
const turnOf = (data) => data === void 0 ? void 0 : asIndex(data["turn"]);
/**
* Types the harness always attributes to a turn. Without one they cannot be
* placed and the event is ignored rather than guessed at.
*/
const TURN_BEARING = /* @__PURE__ */ new Set([
	"turn/start",
	"turn/end",
	"step/start",
	"step/end",
	"assistant/message",
	"tool/call",
	"tool/result"
]);
/** The unconditional `type → [kind, phase]` table of `docs/ARCHITECTURE.md §3.1`. */
const SHAPES = Object.freeze({
	"step/start": ["model", "started"],
	"step/end": ["model", "completed"],
	"user/message": ["system", "updated"],
	"assistant/message": ["model", "completed"],
	"tool/call": ["tool", "started"],
	"approval/asked": ["approval", "started"],
	"approval/decided": ["approval", "completed"]
});
/**
* `turn/end{reason}` to the status it produced.
*
* Every kind in the union maps to a terminal status; a kind this build does not
* know — the union is merge-extensible — closes the turn as `interrupted`,
* which claims only that the turn ended without a recorded completion. Leaving
* the turn open instead would be a permanent, silent leak of an unfinished row.
*/
const STATUS_BY_REASON = Object.freeze({
	completed: "completed",
	error: "failed",
	blocked: "failed",
	"max-tokens": "failed",
	interrupted: "interrupted",
	aborted: "interrupted"
});
const statusForReason = (data) => {
	const reason = asRecord(data?.["reason"]);
	const kind = asText(reason?.["kind"]);
	return kind === void 0 ? "interrupted" : STATUS_BY_REASON[kind] ?? "interrupted";
};
/** Whether a `tool/result` reports failure. Anything but `true` is success. */
const isErrorResult = (data) => {
	const content = asRecord(data?.["message"])?.["content"];
	if (!Array.isArray(content)) return false;
	for (const part of content) if (asRecord(part)?.["isError"] === true) return true;
	return false;
};
/**
* The text blocks of a message-shaped container, joined in order.
*
* Only `text` blocks contribute: a reasoning block is model-internal, and an
* image block is a reference the object store cannot render.
*/
const contentText = (container) => {
	const content = container["content"];
	if (!Array.isArray(content)) return void 0;
	const parts = [];
	for (const part of content) {
		const block = asRecord(part);
		if (block === void 0 || block["type"] !== "text") continue;
		const text = block["text"];
		if (typeof text === "string") parts.push(text);
	}
	return parts.length === 0 ? void 0 : parts.join("\n");
};
/** The nested `content[].content[].text` chain a `tool/result` message carries. */
const resultText = (value) => {
	const content = asRecord(value)?.["content"];
	if (!Array.isArray(content)) return void 0;
	const parts = [];
	for (const part of content) {
		const block = asRecord(part);
		if (block === void 0) continue;
		const nested = block["content"];
		if (Array.isArray(nested)) {
			const text = contentText({ content: nested });
			if (text !== void 0) parts.push(text);
			continue;
		}
		const text = block["text"];
		if (typeof text === "string") parts.push(text);
	}
	return parts.length === 0 ? void 0 : parts.join("\n");
};
/**
* The text one upstream event contributes as its stored payload, if any.
*
* `tool/call.arguments` is taken verbatim: it is the raw unparsed JSON string
* the model produced, and parsing it here would only turn a malformed argument
* blob into a lost payload — the label reads names, never arguments.
*/
function payloadText(event) {
	const data = asRecord(event.data);
	if (data === void 0) return void 0;
	switch (event.type) {
		case "tool/call": return asText(data["arguments"]);
		case "tool/result": return resultText(data["message"]);
		case "user/message": return contentText(data);
		case "assistant/message": {
			const message = asRecord(data["message"]);
			return message === void 0 ? void 0 : contentText(message);
		}
		default: return;
	}
}
/**
* Redact, truncate and content-address one payload.
*
* Redaction runs first and truncation second, and the order is load-bearing:
* cutting bytes before the secret patterns run can split a credential so the
* pattern no longer matches, which would store half a key in clear. The cost of
* the safe order is only that `originalBytes` describes the redacted candidate
* rather than the raw text, which is the only size a caller could act on.
*/
function preparePayload(text, config) {
	if (text === void 0) return void 0;
	const truncated = truncateBytes(redact(text).text, config.maxOutputBytes);
	const bytes = Buffer$1.from(truncated.text, "utf8");
	return {
		bytes,
		meta: Object.freeze({
			truncated: truncated.truncated,
			originalBytes: truncated.originalBytes,
			byteSize: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex")
		})
	};
}
/**
* Map one upstream event onto the domain seam, or `undefined` when it is not
* recognisable.
*
* Total by construction: every field is narrowed before use, `data` may be
* missing, `null` or any other shape, and nothing here can throw. An event the
* adapter cannot place is an ignored event plus a diagnostic the caller
* records — never an error into the harness, and never a blocked session.
*/
function normalizeEvent(sessionId, workspaceId, event, config) {
	if (typeof event.type !== "string") return void 0;
	if (asIndex(event.seq) === void 0) return void 0;
	if (typeof event.time !== "number" || !Number.isFinite(event.time)) return void 0;
	const data = asRecord(event.data);
	const shape = shapeOf(event.type, data);
	if (shape === void 0) return void 0;
	const turn = turnOf(data);
	if (turn === void 0 && TURN_BEARING.has(event.type)) return void 0;
	const prepared = preparePayload(payloadText(event), config);
	const activity = {
		schemaVersion: 2,
		workspaceId,
		sessionId,
		turnId: turn === void 0 ? unattributedTurnId(sessionId) : turnIdFor(sessionId, turn),
		activityId: activityIdFor(sessionId, event.seq),
		kind: shape.kind,
		phase: shape.phase,
		occurredAt: new Date(event.time).toISOString(),
		...prepared === void 0 ? {} : { payloadRef: `sha256:${prepared.meta.sha256}` },
		seq: event.seq,
		turn,
		label: "",
		...prepared === void 0 ? {} : {
			payloadBytes: prepared.bytes,
			payload: prepared.meta
		}
	};
	return {
		...activity,
		label: describeLabel(activity, event)
	};
}
/** `kind` and `phase` for one event type, or `undefined` when it is not ours. */
function shapeOf(type, data) {
	const fixed = SHAPES[type];
	if (fixed !== void 0) return {
		kind: fixed[0],
		phase: fixed[1]
	};
	if (type.startsWith("compaction/")) return {
		kind: "system",
		phase: "updated"
	};
	if (type === "turn/start") return {
		kind: "turn",
		phase: "started"
	};
	if (type === "turn/end") return {
		kind: "turn",
		phase: statusForReason(data)
	};
	if (type === "tool/result") {
		if (asRecord(data?.["message"]) === void 0) return void 0;
		return {
			kind: "tool",
			phase: isErrorResult(data) ? "failed" : "completed"
		};
	}
}
/** The identifier an event's label is about: a tool name, a call id, a step index. */
function subjectOf(event) {
	if (event === void 0) return void 0;
	const data = asRecord(event.data);
	if (data === void 0) return void 0;
	switch (event.type) {
		case "tool/call": return asText(data["name"]) ?? asText(data["callId"]);
		case "tool/result": {
			const source = asRecord(asRecord(data["message"])?.["source"]);
			return asText(source?.["callId"]);
		}
		case "step/start":
		case "step/end": {
			const step = asIndex(data["step"]);
			return step === void 0 ? void 0 : `Step ${step}`;
		}
		default: return;
	}
}
/**
* Short user-facing text for one activity.
*
* Reads only names and identifiers — a tool name, a call id, a step index, the
* event's own kind and phase — so a label cannot leak a secret even if the
* redactor were bypassed entirely. The optional raw event supplies those
* identifiers; without it the label degrades to the kind and phase alone.
*/
function describeLabel(normalized, event) {
	const subject = subjectOf(event);
	switch (normalized.kind) {
		case "turn": switch (normalized.phase) {
			case "started": return "Turn started";
			case "completed": return "Turn completed";
			case "interrupted": return "Turn interrupted";
			default: return "Turn failed";
		}
		case "model":
			if (normalized.phase === "started") return subject ?? "Step started";
			return subject?.startsWith("Step") === true ? `${subject} completed` : "Assistant message";
		case "tool": return subject === void 0 ? "Tool call" : `Tool: ${subject}`;
		case "approval": return normalized.phase === "started" ? "Approval requested" : "Approval decided";
		case "system": return event?.type === "user/message" ? "User message" : "Context";
		default: return normalized.phase === "failed" ? "Failed" : "Activity";
	}
}
const EMPTY = Object.freeze({
	turns: Object.freeze([]),
	activities: Object.freeze([]),
	ignored: true,
	dropped: 0
});
/**
* Build a turn assembler: the state machine that turns a stream of normalized
* events into turn and activity records.
*
* Holds only in-memory state and performs no I/O — nothing here awaits, reads
* or writes — which is what makes the whole state machine testable without a
* database, and what keeps a slow disk off the harness's synchronous emit path.
*
* It is also the layer that *owns* the transition graph rather than merely
* absorbing post-terminal updates: `transitionTurn` is deliberately permissive
* (`pending → failed` is allowed there), so this is where the diagram of
* `docs/ARCHITECTURE.md §3.3` is actually decided. It emits `running` only for
* a `turn/start` and a terminal status only for a `turn/end`, and never
* downgrades a turn it has already finished — the same guard `TraceRepository`
* cannot apply in SQL without discarding the count fields this layer updates.
*/
function createTurnAssembler() {
	/** Every turn this process has seen, keyed by turn id. */
	const turns = /* @__PURE__ */ new Map();
	/** The turn currently open per session, so unattributed events can be placed. */
	const openTurns = /* @__PURE__ */ new Map();
	/** FIFO of events waiting for a turn that has not opened; oldest first. */
	let deferred = [];
	const activityOf = (event, turnId) => ({
		schemaVersion: 2,
		id: event.activityId,
		turnId,
		sessionId: event.sessionId,
		kind: event.kind,
		phase: event.phase,
		seq: event.seq,
		label: event.label,
		occurredAt: Date.parse(event.occurredAt),
		...event.payloadRef === void 0 ? {} : { payloadRef: event.payloadRef },
		...event.payload?.truncated === true ? { truncated: true } : {}
	});
	const recordOf = (moment) => ({
		schemaVersion: 2,
		id: moment.id,
		sessionId: moment.sessionId,
		workspaceId: moment.workspaceId,
		ordinal: moment.ordinal,
		status: moment.status,
		startedAt: moment.startedAt,
		endedAt: moment.endedAt,
		activityCount: moment.activityCount,
		errorCount: moment.errorCount,
		evidenceCompleteness: "missing"
	});
	/** The status an event would apply to its turn, or `undefined` for neither. */
	const requestedStatus = (event) => {
		if (event.kind !== "turn") return void 0;
		switch (event.phase) {
			case "started": return "running";
			case "completed":
			case "failed":
			case "interrupted": return event.phase;
			default: return;
		}
	};
	/** Place an event by its turn id, resolving the unattributed sentinel. */
	const targetTurnId = (event) => {
		if (event.turnId !== unattributedTurnId(event.sessionId)) return event.turnId;
		const open = openTurns.get(event.sessionId);
		return open === void 0 ? void 0 : turnIdFor(event.sessionId, open);
	};
	const buffer = (turnId, event) => {
		deferred.push({
			turnId,
			event
		});
		let dropped = 0;
		while (deferred.length > 256) {
			deferred.shift();
			dropped += 1;
		}
		return {
			turns: Object.freeze([]),
			activities: Object.freeze([]),
			ignored: false,
			dropped
		};
	};
	/** Remove and return the deferred events of one turn, oldest first. */
	const drain = (turnId) => {
		const kept = [];
		const taken = [];
		for (const entry of deferred) if (entry.turnId === turnId) taken.push(entry.event);
		else kept.push(entry);
		deferred = kept;
		return taken;
	};
	const ingest = (event) => {
		if (event === void 0) return EMPTY;
		const turnId = targetTurnId(event);
		if (turnId === void 0) return EMPTY;
		const requested = requestedStatus(event);
		let moment = turns.get(turnId);
		if (moment === void 0 && requested === void 0) return buffer(turnId, event);
		if (moment === void 0) {
			moment = {
				id: turnId,
				sessionId: event.sessionId,
				workspaceId: event.workspaceId,
				ordinal: event.turn ?? -1,
				status: "pending",
				startedAt: Date.parse(event.occurredAt),
				endedAt: void 0,
				activityCount: 0,
				errorCount: 0
			};
			turns.set(turnId, moment);
		}
		if (requested !== void 0) {
			const wasTerminal = isTerminal(moment.status);
			const applied = transitionTurn(moment.status, requested);
			moment.status = applied;
			if (!wasTerminal && isTerminal(applied)) {
				moment.endedAt = Date.parse(event.occurredAt);
				if (openTurns.get(event.sessionId) === moment.ordinal) openTurns.delete(event.sessionId);
			} else if (requested === "running" && !isTerminal(applied)) openTurns.set(event.sessionId, moment.ordinal);
		}
		const activities = drain(turnId).map((entry) => activityOf(entry, turnId));
		activities.push(activityOf(event, turnId));
		for (const activity of activities) {
			moment.activityCount += 1;
			if (activity.phase === "failed") moment.errorCount += 1;
		}
		return {
			turns: Object.freeze([recordOf(moment)]),
			activities: Object.freeze(activities),
			ignored: false,
			dropped: 0
		};
	};
	return {
		ingest,
		pendingCount: () => deferred.length
	};
}
/** Marks a partially written file, so retention and debugging can spot one. */
const TEMP_SUFFIX = ".tmp";
/**
* Suffix that makes the temp path unpredictable as well as unique. Predictable
* temp names are what makes symlink planting at that path possible; `wx` in
* {@link writeFileAtomic} already refuses an existing path, and an unguessable
* name keeps an attacker from pre-creating a regular file there either.
*/
const randomSuffix = () => randomBytes(8).toString("hex");
/**
* Write `bytes` to `targetPath` so the path is never observed half-written.
*
* The temp file lives in the *same* directory as the target, so the final
* `rename` cannot cross a filesystem boundary — a cross-device rename fails
* outright, and a copy fallback would not be atomic. The handle is `fsync`ed
* before the rename so the bytes are durable before the name points at them,
* and the containing directory is `fsync`ed afterwards (best effort: not every
* platform permits opening a directory) so the rename itself survives a crash.
*
* On any failure the temp file is removed and the original error rethrown; the
* target is left exactly as it was.
*/
async function writeFileAtomic(targetPath, bytes) {
	const directory = dirname(targetPath);
	await mkdir(directory, {
		recursive: true,
		mode: 448
	});
	const tempPath = join(directory, `${basename(targetPath)}.${randomSuffix()}${TEMP_SUFFIX}`);
	let handle;
	try {
		handle = await open(tempPath, "wx", 384);
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		handle = void 0;
		await rename(tempPath, targetPath);
	} catch (error) {
		await handle?.close().catch(() => void 0);
		await rm(tempPath, { force: true }).catch(() => void 0);
		throw error;
	}
	await syncDirectory(directory);
}
/** Best-effort directory `fsync`; unsupported platforms simply skip it. */
async function syncDirectory(directory) {
	let handle;
	try {
		handle = await open(directory, "r");
		await handle.sync();
	} catch {} finally {
		await handle?.close().catch(() => void 0);
	}
}
//#endregion
//#region src/host/storage/paths.ts
/** Subdirectory of a resolved root that holds the content-addressed objects. */
const OBJECTS_DIRNAME = "objects";
/** The plugin's directory name under whichever base applies. */
const PLUGIN_DIRNAME = "turnscope";
/**
* Base directory for a user-wide DSH install, mirroring DSH's own convention.
*/
const HOME_DIRNAME = ".dsh";
/**
* Decide where Turnscope keeps its private data.
*
* Precedence is explicit `config.dataDir`, then `<DSH_HOME>/turnscope`, then
* `<homeDir>/.dsh/turnscope`. `process.cwd()` is deliberately never consulted:
* a cwd fallback would give every project the user opens its own store, so the
* index would silently fragment and retention would never see the whole set.
* The result is always absolute, so callers can open it without further
* resolution.
*
* Every arm is guarded to keep that promise. `dataDir` and `DSH_HOME` are
* accepted only when absolute, and `homeDir` is required to be absolute —
* `resolve` would quietly start from the cwd for a relative or empty first
* segment, which is the one path by which the cwd could reach the result. A bad
* `homeDir` is therefore a caller bug, and failing loudly beats scattering the
* store; the call site wraps this in its fail-open boundary, so the outcome is
* a disabled recorder rather than data written to the wrong place.
*/
function resolveDataRoot(config, env, homeDir) {
	const dataDir = config.dataDir;
	if (typeof dataDir === "string" && isAbsolute(dataDir)) return dataDir;
	const dshHome = env.DSH_HOME;
	if (typeof dshHome === "string" && dshHome.length > 0 && isAbsolute(dshHome)) return join(dshHome, PLUGIN_DIRNAME);
	if (!isAbsolute(homeDir)) throw new Error(`homeDir must be absolute, got ${JSON.stringify(homeDir)}`);
	return resolve(homeDir, HOME_DIRNAME, PLUGIN_DIRNAME);
}
/** The object store directory beneath a resolved data root. */
function resolveObjectsDir(dataRoot) {
	return join(dataRoot, OBJECTS_DIRNAME);
}
//#endregion
//#region src/host/storage/object-store.ts
/**
* The object kinds this store may hold.
*
* Frozen, and the only source of valid values: a typo'd kind would file an
* object where nothing later looks for it, so {@link ObjectStore.put} rejects
* anything outside this set.
*
* The two kinds exist because they are **different data**, not different sizes
* or lifetimes — `docs/ARCHITECTURE.md §12.3` and its decision 6 draw the line:
*
* - `ACTIVITY_PAYLOAD` is diagnostic: command and tool output shown to a user.
*   Secrets are masked before it is stored, and masking is lossy on purpose.
* - `RECOVERY_BLOB` is a file's exact bytes as the workspace held them. It is
*   **not** redacted, because a redacted snapshot cannot restore anything — the
*   substitution would be written back over the user's file. Its protection is
*   different in kind: it never leaves the machine, it is written `0o600` inside
*   the plugin-private root, and retention bounds it.
*
* That reversal is the whole reason {@link ObjectStore.put} takes an explicit
* {@link RedactionPolicy} rather than inferring one. A caller has to say which
* of the two it is storing, and the store refuses a pair that disagrees.
*/
const OBJECT_KINDS = Object.freeze({
	/** Redacted, truncated tool and command output. */
	ACTIVITY_PAYLOAD: "activity-payload",
	/** A file's exact bytes, captured so a recovery can put them back. */
	RECOVERY_BLOB: "recovery-blob"
});
/**
* The one policy each kind can carry.
*
* Enforced rather than assumed so that a mis-wired call site fails loudly: a
* diagnostic payload offered as raw bytes is either a caller about to write an
* unredacted secret into the diagnostic store, or one that has confused the two
* classes. Both should stop here rather than at a leak.
*/
const POLICY_FOR_KIND = Object.freeze({
	[OBJECT_KINDS.ACTIVITY_PAYLOAD]: "applied",
	[OBJECT_KINDS.RECOVERY_BLOB]: "raw-bytes"
});
const KNOWN_KINDS = new Set(Object.values(OBJECT_KINDS));
const REF_PREFIX = "sha256:";
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PREFIX_PATTERN = /^[0-9a-f]{2}$/;
const toRef = (hex) => `${REF_PREFIX}${hex}`;
/**
* Parse a ref back to its digest, or `undefined` when it is not a well-formed
* address. Callers decide whether that is a miss ({@link ObjectStore.has}) or
* an error ({@link ObjectStore.get}).
*/
const digestFromRef = (ref) => {
	if (!ref.startsWith(REF_PREFIX)) return void 0;
	const hex = ref.slice(7);
	return DIGEST_PATTERN.test(hex) ? hex : void 0;
};
/**
* One level of fan-out keeps any single directory small; two hex characters
* give 256 buckets, which also makes a listing cheap to resume.
*/
const objectPath = (objectsDir, hex) => join(objectsDir, hex.slice(0, 2), hex.slice(2));
/** `stat` that reports absence as `undefined` and lets real errors through. */
const safeStat = async (path) => {
	try {
		return { byteSize: (await stat(path)).size };
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw error;
	}
};
const refOf = (hex, byteSize) => Object.freeze({
	ref: toRef(hex),
	sha256: hex,
	byteSize
});
/**
* Open the content-addressed object store rooted at `<root>/objects`.
*
* Objects are addressed by the SHA-256 of their bytes, so the name *is* the
* integrity check: {@link ObjectStore.get} recomputes the digest rather than
* trusting the filename, which turns silent on-disk corruption (a truncated or
* scribbled file) into a rejection instead of wrong bytes flowing into a report.
*/
function createObjectStore(root) {
	const objectsDir = resolveObjectsDir(root);
	const put = async (kind, bytes, options) => {
		if (!KNOWN_KINDS.has(kind)) throw new Error(`unknown object kind ${JSON.stringify(kind)}; expected one of ${[...KNOWN_KINDS].join(", ")}`);
		const required = POLICY_FOR_KIND[kind];
		if (options.redaction !== required) throw new Error(`object kind ${JSON.stringify(kind)} must be stored with redaction ${JSON.stringify(required)}, received ${JSON.stringify(options.redaction)}`);
		const hex = createHash("sha256").update(bytes).digest("hex");
		const byteSize = bytes.byteLength;
		const path = objectPath(objectsDir, hex);
		if (await safeStat(path) === void 0) await writeFileAtomic(path, bytes);
		return refOf(hex, byteSize);
	};
	const get = async (ref) => {
		const hex = digestFromRef(ref);
		if (hex === void 0) throw new Error(`unknown object ref: ${ref}`);
		let bytes;
		try {
			bytes = await readFile(objectPath(objectsDir, hex));
		} catch (error) {
			if (error.code === "ENOENT") throw new Error(`unknown object ref: ${ref}`);
			throw error;
		}
		const actual = createHash("sha256").update(bytes).digest("hex");
		if (actual !== hex) throw new Error(`object store corruption: stored bytes for ${ref} hash to ${toRef(actual)}`);
		return bytes;
	};
	const has = async (ref) => {
		const hex = digestFromRef(ref);
		if (hex === void 0) return false;
		return await safeStat(objectPath(objectsDir, hex)) !== void 0;
	};
	const stat = async (ref) => {
		const hex = digestFromRef(ref);
		if (hex === void 0) return void 0;
		const info = await safeStat(objectPath(objectsDir, hex));
		return info === void 0 ? void 0 : refOf(hex, info.byteSize);
	};
	const listRefs = async () => {
		const prefixes = await readdirSafe(objectsDir);
		const refs = [];
		for (const prefix of prefixes) {
			if (!PREFIX_PATTERN.test(prefix)) continue;
			for (const name of await readdirSafe(join(objectsDir, prefix))) {
				const hex = `${prefix}${name}`;
				if (DIGEST_PATTERN.test(hex)) refs.push(toRef(hex));
			}
		}
		return refs.sort();
	};
	return {
		put,
		get,
		has,
		stat,
		listRefs
	};
}
/**
* `readdir` that yields nothing for a path that does not exist or is not a
* directory. Anything else — a permission problem, say — propagates: reporting
* an empty store when the store is merely unreadable would hide real breakage
* from whoever runs retention.
*/
async function readdirSafe(directory) {
	try {
		return await readdir(directory);
	} catch (error) {
		const code = error.code;
		if (code === "ENOENT" || code === "ENOTDIR") return [];
		throw error;
	}
}
//#endregion
//#region src/host/storage/schema.ts
/**
* The on-disk schema of the plugin-private SQLite index.
*
* Everything the plugin can read back is declared here, once. Two values make
* the file self-identifying so an unrelated SQLite database can never be
* mistaken for ours: {@link TRACESCOPE_APPLICATION_ID} in the header, and
* {@link SCHEMA_VERSION} in `user_version`.
*/
/**
* Header `application_id` of a Turnscope index.
*
* A random-looking constant, not a sequence number: its whole job is to be
* unlikely to collide with any other application's, so a foreign file is
* recognised as foreign rather than adopted.
*/
const TRACESCOPE_APPLICATION_ID = 1414035280;
/**
* Ordered migrations: `MIGRATIONS[n]` upgrades a database from `user_version`
* `n` to `n + 1`, so applying every entry from the file's current version takes
* it to {@link SCHEMA_VERSION}.
*
* Each entry is idempotent with respect to a version, never re-run, and applied
* inside one `BEGIN IMMEDIATE` transaction, so a failure part-way through leaves
* `user_version` — and therefore the schema — exactly where it started.
*/
const MIGRATIONS = Object.freeze([`
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  repo_root TEXT NOT NULL,
  repo_root_hash TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  upstream_session_id TEXT NOT NULL,
  parent_session_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE turns (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  activity_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  pre_checkpoint_id TEXT,
  post_checkpoint_id TEXT
) STRICT;

CREATE TABLE activities (
  id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL,
  phase TEXT NOT NULL,
  seq INTEGER NOT NULL,
  label TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  payload_ref TEXT,
  truncated INTEGER NOT NULL
) STRICT;

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  head_oid TEXT,
  branch TEXT,
  clean_start INTEGER NOT NULL,
  index_digest TEXT,
  worktree_digest TEXT,
  file_digests TEXT,
  restorable INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  failure_reason TEXT
) STRICT;

-- Written by no task in this slice. Both tables exist now because the schema is
-- versioned: adding a table later would force a migration for a change that
-- costs nothing today. Their columns come from docs/ARCHITECTURE.md §4.1, and
-- only the columns a row is meaningless without are NOT NULL — the plan that
-- first writes these tables owns their contract, and a column it needs to leave
-- empty must not require a migration merely to relax a constraint.
CREATE TABLE findings (
  id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  evidence_json TEXT
) STRICT;

CREATE TABLE forks (
  id TEXT PRIMARY KEY NOT NULL,
  checkpoint_id TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  worktree_path TEXT,
  status TEXT NOT NULL
) STRICT;

CREATE TABLE objects (
  ref TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX activities_turn_id ON activities (turn_id);
CREATE INDEX turns_session_id_ordinal ON turns (session_id, ordinal);
CREATE INDEX checkpoints_turn_id ON checkpoints (turn_id);
CREATE INDEX objects_sha256 ON objects (sha256);
`, `
ALTER TABLE turns ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
ALTER TABLE turns ADD COLUMN evidence_completeness TEXT NOT NULL DEFAULT 'missing';

ALTER TABLE checkpoints ADD COLUMN merge_in_progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkpoints ADD COLUMN rebase_in_progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkpoints ADD COLUMN cherry_pick_in_progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkpoints ADD COLUMN completeness TEXT NOT NULL DEFAULT 'failed';

CREATE TABLE checkpoint_paths (
  id TEXT PRIMARY KEY NOT NULL,
  checkpoint_id TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  staged INTEGER NOT NULL,
  binary INTEGER NOT NULL,
  previous_path TEXT,
  content_hash TEXT,
  mode TEXT,
  blob_ref TEXT
) STRICT;

CREATE TABLE file_changes (
  id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  attribution TEXT NOT NULL,
  confidence TEXT NOT NULL,
  baseline INTEGER NOT NULL,
  before_hash TEXT,
  after_hash TEXT,
  current_hash TEXT,
  previous_path TEXT,
  evidence_json TEXT NOT NULL
) STRICT;

CREATE TABLE commands (
  id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL,
  activity_id TEXT,
  command TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  output_ref TEXT
) STRICT;

CREATE TABLE tests (
  id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL,
  command_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL
) STRICT;

CREATE TABLE safety_verdicts (
  id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL,
  level TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  allowed_actions_json TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  engine_version INTEGER NOT NULL,
  evaluated_at INTEGER NOT NULL,
  current_state_hash TEXT
) STRICT;

CREATE INDEX checkpoint_paths_checkpoint_id ON checkpoint_paths (checkpoint_id);
CREATE INDEX file_changes_turn_id ON file_changes (turn_id);
CREATE INDEX commands_turn_id ON commands (turn_id);
CREATE INDEX tests_turn_id ON tests (turn_id);
CREATE INDEX safety_verdicts_turn_id ON safety_verdicts (turn_id);
`]);
//#endregion
//#region src/host/storage/sqlite-index.ts
/**
* Create the database file owner-only, tolerating one that already exists.
*
* `mkdir` first, because a missing parent would otherwise fail the create. The
* `'wx'` flag is what makes this safe rather than merely convenient: it refuses
* an existing path *including a dangling symlink*, so no one can aim the create
* at a file of their choosing by planting a link at `dbPath`. `EEXIST` is the
* one expected failure — it means the database is already there — and every
* other error (a read-only parent, a path that is a directory) propagates
* rather than being swallowed into a confusing failure later.
*/
async function createExclusively(path) {
	await mkdir(dirname(path), {
		recursive: true,
		mode: 448
	});
	let handle;
	try {
		handle = await open(path, "wx", 384);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	} finally {
		await handle?.close();
	}
}
/**
* Read a numeric PRAGMA. This is the first statement run against a freshly
* opened file, so it is also how a file that is not a database at all is
* detected: SQLite opens lazily and only reports `file is not a database` once
* something is actually read.
*/
function pragmaInteger(db, name) {
	const row = db.prepare(`PRAGMA ${name}`).get();
	const value = row === void 0 ? void 0 : Object.values(row)[0];
	if (typeof value !== "number" && typeof value !== "bigint") throw new Error(`PRAGMA ${name} returned ${String(value)} rather than a number`);
	return Number(value);
}
/** Whether the file holds tables of its own, i.e. does more than host us. */
function hasUserTables(db) {
	const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get();
	const value = row === void 0 ? void 0 : row["n"];
	return typeof value === "number" ? value > 0 : typeof value === "bigint" && value > 0n;
}
/** Close without letting a teardown failure mask the error being reported. */
function closeQuietly(db) {
	try {
		db.close();
	} catch {}
}
const describe$1 = (error) => error instanceof Error ? error.message : String(error);
/**
* Open — creating if needed — the plugin-private index at `dbPath`.
*
* The sequence mirrors the verified `dsh-session-query-sqlite` pattern, and the
* order inside it is load-bearing: the file is identified *before* any setting
* that writes to it. `PRAGMA journal_mode = WAL` rewrites the header, so a
* database belonging to someone else must be recognised and abandoned first —
* opening a foreign file read-only would still not be safe, because the checks
* below have to read its tables to decide.
*
* Three refusals keep a foreign or unreadable file from being adopted:
*
* - a non-zero `application_id` that is not ours is another application's;
* - a `0` id over a file that already has tables is an anonymous SQLite
*   database someone else created, which we neither own nor understand;
* - a `user_version` above {@link SCHEMA_VERSION} was written by a newer
*   Turnscope, whose columns we cannot know — reading it would mean guessing.
*
* A file that is not SQLite at all fails at the first PRAGMA read, which is
* translated into an error naming the path rather than the driver's opaque
* `ERR_SQLITE_ERROR`.
*/
async function openIndex(dbPath) {
	await createExclusively(dbPath);
	const { DatabaseSync: Sqlite } = await import("node:sqlite");
	let db;
	try {
		db = new Sqlite(dbPath);
	} catch (error) {
		throw new Error(`${dbPath} is not a usable SQLite database: ${describe$1(error)}`);
	}
	let applicationId;
	let userVersion;
	try {
		applicationId = pragmaInteger(db, "application_id");
		userVersion = pragmaInteger(db, "user_version");
	} catch (error) {
		closeQuietly(db);
		throw new Error(`${dbPath} is not a SQLite database: ${describe$1(error)}`);
	}
	if (applicationId !== 0 && applicationId !== 1414035280) {
		closeQuietly(db);
		throw new Error(`${dbPath} belongs to another application (application_id ${applicationId}, expected ${TRACESCOPE_APPLICATION_ID}); Turnscope will not read or write it`);
	}
	if (applicationId === 0 && hasUserTables(db)) {
		closeQuietly(db);
		throw new Error(`${dbPath} already contains tables and carries no Turnscope application id; refusing to adopt a database that belongs to another application`);
	}
	if (userVersion > 2) {
		closeQuietly(db);
		throw new Error(`${dbPath} was written by a newer version of Turnscope (schema ${userVersion}; this build understands 2)`);
	}
	db.exec(`PRAGMA application_id = ${TRACESCOPE_APPLICATION_ID}`);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA synchronous = NORMAL");
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		db.close();
	};
	const migrate = () => {
		const current = pragmaInteger(db, "user_version");
		if (current >= 2) return;
		db.exec("BEGIN IMMEDIATE");
		try {
			for (let version = current; version < 2; version += 1) {
				const migration = MIGRATIONS[version];
				if (migration === void 0) throw new Error(`no migration from schema version ${version} to ${version + 1}`);
				db.exec(migration);
			}
			db.exec(`PRAGMA user_version = 2`);
			db.exec("COMMIT");
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	};
	migrate();
	return {
		db,
		migrate,
		close
	};
}
//#endregion
//#region src/host/storage/repository.ts
/**
* Read one column, refusing anything the schema does not promise.
*
* The schema is `STRICT` and every statement below lists its columns, so a
* mismatch means on-disk corruption or a schema this build does not understand.
* Failing loudly with the column name beats coercing a wrong value into a record
* that then flows into a report.
*/
function text(row, column) {
	const value = row[column];
	if (typeof value !== "string") throw new Error(`column ${column}: expected TEXT, read ${String(value)}`);
	return value;
}
function integer(row, column) {
	const value = row[column];
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`column ${column}: expected INTEGER, read ${String(value)}`);
	return value;
}
/** A `0`/`1` column as the boolean the record declares. */
function flag(row, column) {
	return integer(row, column) !== 0;
}
function optionalText(row, column) {
	const value = row[column];
	if (value === null) return void 0;
	if (typeof value !== "string") throw new Error(`column ${column}: expected TEXT or NULL, read ${String(value)}`);
	return value;
}
function optionalInteger(row, column) {
	const value = row[column];
	if (value === null) return void 0;
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`column ${column}: expected INTEGER or NULL, read ${String(value)}`);
	return value;
}
/** `file_digests` holds a JSON object of path to digest, or nothing. */
function optionalDigestMap(row, column) {
	const raw = optionalText(row, column);
	if (raw === void 0) return void 0;
	const parsed = JSON.parse(raw);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`column ${column}: expected a JSON object, read ${raw}`);
	for (const [key, value] of Object.entries(parsed)) if (typeof value !== "string") throw new Error(`column ${column}: entry ${key} is not a string`);
	return parsed;
}
/** A `NOT NULL` column holding a JSON array of strings. */
function stringArray(row, column) {
	return parsedArray(row, column, "string");
}
/**
* A `NOT NULL` column holding a JSON array of objects.
*
* Elements are checked to be objects but not to match the record type they will
* be handed to: the shapes are owned by the domain, and duplicating them here
* would give a stored verdict two definitions to drift between.
*/
function objectArray(row, column) {
	return parsedArray(row, column, "object");
}
function parsedArray(row, column, element) {
	const raw = text(row, column);
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed)) throw new Error(`column ${column}: expected a JSON array, read ${raw}`);
	for (const item of parsed) if (!(element === "string" ? typeof item === "string" : item !== null && typeof item === "object" && !Array.isArray(item))) throw new Error(`column ${column}: expected every element to be a ${element}, read ${raw}`);
	return parsed;
}
/**
* A record's optional field has no representation in SQL — the column is simply
* NULL — so the field is mapped back as *absent* rather than present-and-
* undefined. Under `exactOptionalPropertyTypes` the two are different types, and
* a record that reads back with `field: undefined` would fail an equality check
* against the record that was written.
*/
const absent = (key, value) => value === void 0 ? {} : { [key]: value };
/** The inverse: an absent optional is written as SQL NULL. */
const nullable = (value) => value === void 0 ? null : value;
const toSqlFlag = (value) => value ? 1 : 0;
const toTurn = (row) => ({
	schemaVersion: 2,
	id: text(row, "id"),
	sessionId: text(row, "session_id"),
	workspaceId: text(row, "workspace_id"),
	ordinal: integer(row, "ordinal"),
	status: text(row, "status"),
	startedAt: integer(row, "started_at"),
	endedAt: optionalInteger(row, "ended_at"),
	activityCount: integer(row, "activity_count"),
	errorCount: integer(row, "error_count"),
	evidenceCompleteness: text(row, "evidence_completeness"),
	...absent("preCheckpointId", optionalText(row, "pre_checkpoint_id")),
	...absent("postCheckpointId", optionalText(row, "post_checkpoint_id"))
});
const toActivity = (row) => ({
	schemaVersion: 2,
	id: text(row, "id"),
	turnId: text(row, "turn_id"),
	sessionId: text(row, "session_id"),
	...absent("parentId", optionalText(row, "parent_id")),
	kind: text(row, "kind"),
	phase: text(row, "phase"),
	seq: integer(row, "seq"),
	label: text(row, "label"),
	occurredAt: integer(row, "occurred_at"),
	...absent("payloadRef", optionalText(row, "payload_ref")),
	...flag(row, "truncated") ? { truncated: true } : {}
});
const toCheckpoint = (row) => ({
	schemaVersion: 2,
	id: text(row, "id"),
	workspaceId: text(row, "workspace_id"),
	turnId: text(row, "turn_id"),
	phase: text(row, "phase"),
	...absent("headOid", optionalText(row, "head_oid")),
	...absent("branch", optionalText(row, "branch")),
	cleanStart: flag(row, "clean_start"),
	mergeInProgress: flag(row, "merge_in_progress"),
	rebaseInProgress: flag(row, "rebase_in_progress"),
	cherryPickInProgress: flag(row, "cherry_pick_in_progress"),
	...absent("indexDigest", optionalText(row, "index_digest")),
	...absent("worktreeDigest", optionalText(row, "worktree_digest")),
	...absent("fileDigests", optionalDigestMap(row, "file_digests")),
	completeness: text(row, "completeness"),
	restorable: flag(row, "restorable"),
	createdAt: integer(row, "created_at"),
	...absent("failureReason", optionalText(row, "failure_reason"))
});
const toCheckpointPath = (row) => ({
	schemaVersion: 2,
	id: text(row, "id"),
	checkpointId: text(row, "checkpoint_id"),
	path: text(row, "path"),
	status: text(row, "status"),
	staged: flag(row, "staged"),
	binary: flag(row, "binary"),
	...absent("previousPath", optionalText(row, "previous_path")),
	...absent("contentHash", optionalText(row, "content_hash")),
	...absent("mode", optionalText(row, "mode")),
	...absent("blobRef", optionalText(row, "blob_ref"))
});
const toFileChange = (row) => ({
	schemaVersion: 2,
	id: text(row, "id"),
	turnId: text(row, "turn_id"),
	path: text(row, "path"),
	kind: text(row, "kind"),
	attribution: text(row, "attribution"),
	confidence: text(row, "confidence"),
	baseline: flag(row, "baseline"),
	...absent("beforeHash", optionalText(row, "before_hash")),
	...absent("afterHash", optionalText(row, "after_hash")),
	...absent("currentHash", optionalText(row, "current_hash")),
	...absent("previousPath", optionalText(row, "previous_path")),
	evidenceRefs: stringArray(row, "evidence_json")
});
const toCommand = (row) => ({
	schemaVersion: 2,
	id: text(row, "id"),
	turnId: text(row, "turn_id"),
	...absent("activityId", optionalText(row, "activity_id")),
	command: text(row, "command"),
	...absent("exitCode", optionalInteger(row, "exit_code")),
	...absent("durationMs", optionalInteger(row, "duration_ms")),
	...absent("outputRef", optionalText(row, "output_ref"))
});
const toTest = (row) => ({
	schemaVersion: 2,
	id: text(row, "id"),
	turnId: text(row, "turn_id"),
	...absent("commandId", optionalText(row, "command_id")),
	kind: text(row, "kind"),
	status: text(row, "status"),
	summary: text(row, "summary")
});
const toVerdict = (row) => ({
	schemaVersion: 2,
	id: text(row, "id"),
	turnId: text(row, "turn_id"),
	level: text(row, "level"),
	reasons: objectArray(row, "reasons_json"),
	allowedActions: stringArray(row, "allowed_actions_json").map((action) => action),
	recommendedAction: text(row, "recommended_action"),
	evaluatedAt: integer(row, "evaluated_at"),
	engineVersion: integer(row, "engine_version"),
	...absent("currentStateHash", optionalText(row, "current_state_hash"))
});
const toObjectRecord = (row) => ({
	schemaVersion: 2,
	ref: text(row, "ref"),
	kind: text(row, "kind"),
	byteSize: integer(row, "byte_size"),
	sha256: text(row, "sha256"),
	createdAt: integer(row, "created_at")
});
const TURN_COLUMNS = "id, session_id, workspace_id, ordinal, status, started_at, ended_at, activity_count, error_count, evidence_completeness, pre_checkpoint_id, post_checkpoint_id";
const ACTIVITY_COLUMNS = "id, turn_id, session_id, parent_id, kind, phase, seq, label, occurred_at, payload_ref, truncated";
const CHECKPOINT_COLUMNS = "id, workspace_id, turn_id, phase, head_oid, branch, clean_start, merge_in_progress, rebase_in_progress, cherry_pick_in_progress, index_digest, worktree_digest, file_digests, completeness, restorable, created_at, failure_reason";
const CHECKPOINT_PATH_COLUMNS = "id, checkpoint_id, path, status, staged, binary, previous_path, content_hash, mode, blob_ref";
const FILE_CHANGE_COLUMNS = "id, turn_id, path, kind, attribution, confidence, baseline, before_hash, after_hash, current_hash, previous_path, evidence_json";
const COMMAND_COLUMNS = "id, turn_id, activity_id, command, exit_code, duration_ms, output_ref";
const TEST_COLUMNS = "id, turn_id, command_id, kind, status, summary";
const VERDICT_COLUMNS = "id, turn_id, level, reasons_json, allowed_actions_json, recommended_action, engine_version, evaluated_at, current_state_hash";
/**
* The terminal set as a SQL `IN` list, built from the single definition in
* `../domain/turn-state.ts`.
*
* The literals come from a closed union this package owns, so there is nothing
* to inject; spelling them out separately here is what previously let the SQL
* and the predicate disagree about which states are absorbing.
*/
const TERMINAL_STATUS_SQL = TERMINAL_TURN_STATUSES.map((status) => `'${status}'`).join(", ");
/**
* Open a {@link TraceRepository} over an already-migrated index.
*
* The driver is synchronous and so is every statement below; the methods are
* `async` only because the port is. Nothing here awaits between statements, so a
* caller's `BEGIN IMMEDIATE` cannot have another writer interleaved into it.
*/
function createRepository(handle) {
	const { db } = handle;
	const prepared = /* @__PURE__ */ new Map();
	const statement = (sql) => {
		const cached = prepared.get(sql);
		if (cached !== void 0) return cached;
		const created = db.prepare(sql);
		prepared.set(sql, created);
		return created;
	};
	const all = (sql, ...params) => statement(sql).all(...params);
	const one = (sql, ...params) => statement(sql).get(...params);
	const upsertWorkspace = async (record) => {
		statement(`INSERT INTO workspaces (id, repo_root, repo_root_hash, settings_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         repo_root = excluded.repo_root,
         repo_root_hash = excluded.repo_root_hash,
         settings_json = excluded.settings_json,
         created_at = excluded.created_at`).run(record.id, record.repoRoot, record.repoRootHash, record.settingsJson, record.createdAt);
	};
	const upsertSession = async (record) => {
		statement(`INSERT INTO sessions (id, workspace_id, upstream_session_id, parent_session_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         upstream_session_id = excluded.upstream_session_id,
         parent_session_id = excluded.parent_session_id,
         created_at = excluded.created_at`).run(record.id, record.workspaceId, record.upstreamSessionId, nullable(record.parentSessionId), record.createdAt);
	};
	const upsertTurn = async (record) => {
		statement(`INSERT INTO turns (${TURN_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id,
         workspace_id = excluded.workspace_id,
         ordinal = excluded.ordinal,
         status = excluded.status,
         started_at = excluded.started_at,
         ended_at = excluded.ended_at,
         activity_count = excluded.activity_count,
         error_count = excluded.error_count,
         pre_checkpoint_id = excluded.pre_checkpoint_id,
         post_checkpoint_id = excluded.post_checkpoint_id`).run(record.id, record.sessionId, record.workspaceId, record.ordinal, record.status, record.startedAt, nullable(record.endedAt), record.activityCount, record.errorCount, record.evidenceCompleteness, nullable(record.preCheckpointId), nullable(record.postCheckpointId));
	};
	/**
	* `evidence_completeness` is deliberately absent from the `DO UPDATE` list
	* above. The recorder upserts a turn on every event of that turn, and those
	* records all carry the placeholder `'missing'`; including the column would
	* let a routine activity overwrite the value {@link setEvidenceCompleteness}
	* computed after observing the workspace. It is written on insert and then
	* owned by that one method.
	*/
	const setEvidenceCompleteness = async (turnId, value) => {
		statement("UPDATE turns SET evidence_completeness = ? WHERE id = ?").run(value, turnId);
	};
	const closeTurn = async (turnId, status, endedAt) => {
		statement(`UPDATE turns SET status = ?, ended_at = ?
       WHERE id = ? AND status NOT IN (${TERMINAL_STATUS_SQL})`).run(status, endedAt, turnId);
	};
	const listTurns = async (sessionId, limit) => {
		return all(`SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? ORDER BY ordinal DESC LIMIT ?`, sessionId, limit).map(toTurn);
	};
	const getTurn = async (turnId) => {
		const row = one(`SELECT ${TURN_COLUMNS} FROM turns WHERE id = ?`, turnId);
		return row === void 0 ? void 0 : toTurn(row);
	};
	const appendActivity = async (record) => {
		statement(`INSERT INTO activities (${ACTIVITY_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`).run(record.id, record.turnId, record.sessionId, nullable(record.parentId), record.kind, record.phase, record.seq, record.label, record.occurredAt, nullable(record.payloadRef), toSqlFlag(record.truncated === true));
	};
	const getActivities = async (turnId) => {
		return all(`SELECT ${ACTIVITY_COLUMNS} FROM activities WHERE turn_id = ? ORDER BY seq ASC`, turnId).map(toActivity);
	};
	const putCheckpoint = async (record) => {
		statement(`INSERT INTO checkpoints (${CHECKPOINT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         turn_id = excluded.turn_id,
         phase = excluded.phase,
         head_oid = excluded.head_oid,
         branch = excluded.branch,
         clean_start = excluded.clean_start,
         merge_in_progress = excluded.merge_in_progress,
         rebase_in_progress = excluded.rebase_in_progress,
         cherry_pick_in_progress = excluded.cherry_pick_in_progress,
         index_digest = excluded.index_digest,
         worktree_digest = excluded.worktree_digest,
         file_digests = excluded.file_digests,
         completeness = excluded.completeness,
         restorable = excluded.restorable,
         created_at = excluded.created_at,
         failure_reason = excluded.failure_reason`).run(record.id, record.workspaceId, record.turnId, record.phase, nullable(record.headOid), nullable(record.branch), toSqlFlag(record.cleanStart), toSqlFlag(record.mergeInProgress), toSqlFlag(record.rebaseInProgress), toSqlFlag(record.cherryPickInProgress), nullable(record.indexDigest), nullable(record.worktreeDigest), record.fileDigests === void 0 ? null : JSON.stringify(record.fileDigests), record.completeness, toSqlFlag(record.restorable), record.createdAt, nullable(record.failureReason));
	};
	const putCheckpointPath = async (record) => {
		statement(`INSERT INTO checkpoint_paths (${CHECKPOINT_PATH_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         checkpoint_id = excluded.checkpoint_id,
         path = excluded.path,
         status = excluded.status,
         staged = excluded.staged,
         binary = excluded.binary,
         previous_path = excluded.previous_path,
         content_hash = excluded.content_hash,
         mode = excluded.mode,
         blob_ref = excluded.blob_ref`).run(record.id, record.checkpointId, record.path, record.status, toSqlFlag(record.staged), toSqlFlag(record.binary), nullable(record.previousPath), nullable(record.contentHash), nullable(record.mode), nullable(record.blobRef));
	};
	const listCheckpointPaths = async (checkpointId) => {
		return all(`SELECT ${CHECKPOINT_PATH_COLUMNS} FROM checkpoint_paths WHERE checkpoint_id = ?
       ORDER BY path ASC`, checkpointId).map(toCheckpointPath);
	};
	const putFileChange = async (record) => {
		statement(`INSERT INTO file_changes (${FILE_CHANGE_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         turn_id = excluded.turn_id,
         path = excluded.path,
         kind = excluded.kind,
         attribution = excluded.attribution,
         confidence = excluded.confidence,
         baseline = excluded.baseline,
         before_hash = excluded.before_hash,
         after_hash = excluded.after_hash,
         current_hash = excluded.current_hash,
         previous_path = excluded.previous_path,
         evidence_json = excluded.evidence_json`).run(record.id, record.turnId, record.path, record.kind, record.attribution, record.confidence, toSqlFlag(record.baseline), nullable(record.beforeHash), nullable(record.afterHash), nullable(record.currentHash), nullable(record.previousPath), JSON.stringify(record.evidenceRefs));
	};
	const listFileChanges = async (turnId) => {
		return all(`SELECT ${FILE_CHANGE_COLUMNS} FROM file_changes WHERE turn_id = ? ORDER BY path ASC`, turnId).map(toFileChange);
	};
	const putCommand = async (record) => {
		statement(`INSERT INTO commands (${COMMAND_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         turn_id = excluded.turn_id,
         activity_id = excluded.activity_id,
         command = excluded.command,
         exit_code = excluded.exit_code,
         duration_ms = excluded.duration_ms,
         output_ref = excluded.output_ref`).run(record.id, record.turnId, nullable(record.activityId), record.command, nullable(record.exitCode), nullable(record.durationMs), nullable(record.outputRef));
	};
	const listCommands = async (turnId) => {
		return all(`SELECT ${COMMAND_COLUMNS} FROM commands WHERE turn_id = ? ORDER BY id ASC`, turnId).map(toCommand);
	};
	const putTest = async (record) => {
		statement(`INSERT INTO tests (${TEST_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         turn_id = excluded.turn_id,
         command_id = excluded.command_id,
         kind = excluded.kind,
         status = excluded.status,
         summary = excluded.summary`).run(record.id, record.turnId, nullable(record.commandId), record.kind, record.status, record.summary);
	};
	const listTests = async (turnId) => {
		return all(`SELECT ${TEST_COLUMNS} FROM tests WHERE turn_id = ? ORDER BY id ASC`, turnId).map(toTest);
	};
	const putSafetyVerdict = async (record) => {
		statement(`INSERT INTO safety_verdicts (${VERDICT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         turn_id = excluded.turn_id,
         level = excluded.level,
         reasons_json = excluded.reasons_json,
         allowed_actions_json = excluded.allowed_actions_json,
         recommended_action = excluded.recommended_action,
         engine_version = excluded.engine_version,
         evaluated_at = excluded.evaluated_at,
         current_state_hash = excluded.current_state_hash`).run(record.id, record.turnId, record.level, JSON.stringify(record.reasons), JSON.stringify(record.allowedActions), record.recommendedAction, record.engineVersion, record.evaluatedAt, nullable(record.currentStateHash));
	};
	const getLatestVerdict = async (turnId) => {
		const row = one(`SELECT ${VERDICT_COLUMNS} FROM safety_verdicts WHERE turn_id = ?
       ORDER BY evaluated_at DESC, id DESC LIMIT 1`, turnId);
		return row === void 0 ? void 0 : toVerdict(row);
	};
	const getCheckpoint = async (id) => {
		const row = one(`SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE id = ?`, id);
		return row === void 0 ? void 0 : toCheckpoint(row);
	};
	const listCheckpoints = async (turnId) => {
		return all(`SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE turn_id = ?
       ORDER BY created_at ASC, id ASC`, turnId).map(toCheckpoint);
	};
	const putObjectRecord = async (record) => {
		statement(`INSERT INTO objects (ref, kind, byte_size, sha256, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET
         kind = excluded.kind,
         byte_size = excluded.byte_size,
         sha256 = excluded.sha256,
         created_at = excluded.created_at`).run(record.ref, record.kind, record.byteSize, record.sha256, record.createdAt);
	};
	const statObject = async (ref) => {
		const row = one("SELECT ref, kind, byte_size, sha256, created_at FROM objects WHERE ref = ?", ref);
		return row === void 0 ? void 0 : toObjectRecord(row);
	};
	const referencedRefs = async () => {
		return all(`SELECT DISTINCT ref FROM (
         SELECT payload_ref AS ref FROM activities WHERE payload_ref IS NOT NULL
         UNION
         SELECT blob_ref AS ref FROM checkpoint_paths WHERE blob_ref IS NOT NULL
         UNION
         SELECT output_ref AS ref FROM commands WHERE output_ref IS NOT NULL
       ) ORDER BY ref ASC`).map((row) => text(row, "ref"));
	};
	const deleteObject = async (ref) => {
		statement("DELETE FROM objects WHERE ref = ?").run(ref);
	};
	const storageUsage = async () => {
		const row = one("SELECT COALESCE(SUM(byte_size), 0) AS object_bytes, COUNT(*) AS object_count FROM objects");
		if (row === void 0) return {
			objectBytes: 0,
			objectCount: 0
		};
		return {
			objectBytes: integer(row, "object_bytes"),
			objectCount: integer(row, "object_count")
		};
	};
	const close = async () => {
		handle.close();
	};
	return {
		upsertWorkspace,
		upsertSession,
		upsertTurn,
		closeTurn,
		setEvidenceCompleteness,
		listTurns,
		getTurn,
		appendActivity,
		getActivities,
		putCheckpoint,
		getCheckpoint,
		listCheckpoints,
		putCheckpointPath,
		listCheckpointPaths,
		putFileChange,
		listFileChanges,
		putCommand,
		listCommands,
		putTest,
		listTests,
		putSafetyVerdict,
		getLatestVerdict,
		putObjectRecord,
		statObject,
		deleteObject,
		referencedRefs,
		storageUsage,
		close
	};
}
const toBytes = (value) => typeof value === "string" ? Buffer.from(value, "utf8") : value;
/**
* The production runner, over `execFile` with `shell: false`.
*
* `shell: false` is not a default to be relied on: it is stated here so the one
* place a process is created is also the one place the argument-versus-command
* distinction is visible.
*/
function createExecFileRunner() {
	const run = (argv, options) => new Promise((resolve, reject) => {
		const file = argv[0];
		if (file === void 0 || file.length === 0) {
			reject(/* @__PURE__ */ new Error("command runner requires a non-empty argv"));
			return;
		}
		execFile(file, argv.slice(1), {
			cwd: options.cwd,
			shell: false,
			encoding: "buffer",
			maxBuffer: options.maxOutputBytes ?? 8388608,
			timeout: options.timeoutMs ?? 3e4,
			windowsHide: true
		}, (error, stdout, stderr) => {
			const out = toBytes(stdout);
			const err = toBytes(stderr);
			if (error === null) {
				resolve({
					exitCode: 0,
					stdout: out,
					stderr: err
				});
				return;
			}
			const code = error.code;
			if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
				resolve({
					exitCode: void 0,
					stdout: out,
					stderr: err,
					incomplete: "output-limit"
				});
				return;
			}
			if (error.killed === true) {
				resolve({
					exitCode: void 0,
					stdout: out,
					stderr: err,
					incomplete: "timeout"
				});
				return;
			}
			if (typeof code === "number") {
				resolve({
					exitCode: code,
					stdout: out,
					stderr: err
				});
				return;
			}
			reject(/* @__PURE__ */ new Error(`cannot run ${JSON.stringify(file)}: ${error.message}`));
		});
	});
	return { run };
}
//#endregion
//#region src/host/git/git-port.ts
/**
* The read-only subcommands this port may run.
*
* `hash-object` is here but `hash-object -w` is not: hashing a file is how a
* fingerprint is taken, and `-w` would write a loose object into the user's
* repository, which is a side effect this slice promises never to have.
* `config --get` reads a value and cannot write one without `--set`.
*/
const ALLOWED_SUBCOMMANDS = /* @__PURE__ */ new Set([
	"rev-parse",
	"status",
	"hash-object",
	"cat-file",
	"symbolic-ref",
	"config"
]);
/** Git prints a zero object id to mean "no such object"; it is not a real id. */
const ZERO_OID = /^0{40,64}$/;
const oidOrUndefined = (value) => value === void 0 || value.length === 0 || ZERO_OID.test(value) ? void 0 : value;
/** Join the tail of a space-split porcelain-v2 line back into a path. */
const pathFrom = (parts, start) => {
	const path = parts.slice(start).join(" ");
	return path.length === 0 ? void 0 : path;
};
const statusFromXY = (xy, renamed) => {
	if (renamed) return "renamed";
	const x = xy.charAt(0);
	const y = xy.charAt(1);
	if (x === "R" || y === "R") return "renamed";
	const codes = `${x}${y}`;
	if (codes.includes("D")) return "deleted";
	if (codes.includes("A")) return "added";
	return "modified";
};
const fieldsOf = (parts) => {
	const xy = parts[1];
	if (xy === void 0) return void 0;
	const mW = parts[5];
	return {
		xy,
		mode: mW === void 0 || mW === "000000" ? void 0 : mW,
		headOid: oidOrUndefined(parts[6]),
		indexOid: oidOrUndefined(parts[7])
	};
};
const optionalOids = (fields) => ({
	...fields.mode === void 0 ? {} : { mode: fields.mode },
	...fields.headOid === void 0 ? {} : { headOid: fields.headOid },
	...fields.indexOid === void 0 ? {} : { indexOid: fields.indexOid }
});
/**
* Parse NUL-separated porcelain-v2 output.
*
* `-z` is required rather than convenient: the default format quotes a path
* containing a space or a non-ASCII byte and escapes it C-style, and decoding
* that back is a recurring source of bugs. With `-z` the path is literal and the
* only separator is the byte that cannot appear in one.
*
* A rename is the reason this is a loop with an index rather than a `map`: type
* `2` records carry the original path as the *next* NUL-separated field.
*/
function parseStatusPorcelainV2(input) {
	const tokens = Buffer.from(input).toString("utf8").split("\0");
	const entries = [];
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === void 0 || token.length === 0) continue;
		const tag = token.charAt(0);
		if (tag === "1") {
			const parts = token.split(" ");
			const fields = fieldsOf(parts);
			const path = pathFrom(parts, 8);
			if (fields === void 0 || path === void 0) continue;
			entries.push({
				path,
				status: statusFromXY(fields.xy, false),
				staged: fields.xy.charAt(0) !== ".",
				unmerged: false,
				...optionalOids(fields)
			});
			continue;
		}
		if (tag === "2") {
			const parts = token.split(" ");
			const fields = fieldsOf(parts);
			const path = pathFrom(parts, 9);
			const previousPath = tokens[i + 1];
			i += 1;
			if (fields === void 0 || path === void 0) continue;
			entries.push({
				path,
				...previousPath === void 0 || previousPath.length === 0 ? {} : { previousPath },
				status: "renamed",
				staged: fields.xy.charAt(0) !== ".",
				unmerged: false,
				...optionalOids(fields)
			});
			continue;
		}
		if (tag === "u") {
			const parts = token.split(" ");
			const fields = fieldsOf(parts);
			const path = pathFrom(parts, 10);
			if (fields === void 0 || path === void 0) continue;
			entries.push({
				path,
				status: "modified",
				staged: fields.xy.charAt(0) !== ".",
				unmerged: true,
				...optionalOids(fields)
			});
			continue;
		}
		if (tag === "?") {
			const path = token.slice(2);
			if (path.length === 0) continue;
			entries.push({
				path,
				status: "untracked",
				staged: false,
				unmerged: false
			});
		}
	}
	return entries;
}
/**
* Build a {@link GitPort} over an injected runner.
*
* The runner is a parameter so tests can drive the port through a recording
* double, and so there is exactly one place — {@link createExecFileRunner} in
* the production wiring — where a real process is spawned.
*/
function createGitPort(runner) {
	const runGit = async (cwd, args) => {
		const subcommand = args[0];
		if (subcommand === void 0 || !ALLOWED_SUBCOMMANDS.has(subcommand)) throw new Error(`git subcommand not on the read-only allowlist: ${String(subcommand)}`);
		const result = await runner.run(["git", ...args], { cwd });
		if (result.incomplete !== void 0 || result.exitCode !== 0) return void 0;
		return result.stdout;
	};
	const text = async (cwd, args) => {
		const bytes = await runGit(cwd, args);
		if (bytes === void 0) return void 0;
		return Buffer.from(bytes).toString("utf8").trim();
	};
	const isRepository = async (cwd) => await text(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
	const toplevel = async (cwd) => {
		const path = await text(cwd, ["rev-parse", "--show-toplevel"]);
		return path === void 0 || path.length === 0 ? void 0 : path;
	};
	const commonDir = async (cwd) => {
		const path = await text(cwd, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir"
		]);
		return path === void 0 || path.length === 0 ? void 0 : path;
	};
	const canonicalRemote = async (cwd) => {
		const url = await text(cwd, [
			"config",
			"--get",
			"remote.origin.url"
		]);
		return url === void 0 || url.length === 0 ? void 0 : url;
	};
	const head = async (cwd) => {
		const oid = await text(cwd, ["rev-parse", "HEAD"]);
		if (oid === void 0 || oid.length === 0) return void 0;
		const branch = await text(cwd, [
			"symbolic-ref",
			"--short",
			"-q",
			"HEAD"
		]);
		return {
			oid,
			...branch === void 0 || branch.length === 0 ? {} : { branch }
		};
	};
	const status = async (cwd) => {
		const bytes = await runGit(cwd, [
			"status",
			"--porcelain=v2",
			"-z",
			"--untracked-files=all"
		]);
		return bytes === void 0 ? void 0 : parseStatusPorcelainV2(bytes);
	};
	const hashObject = async (cwd, path) => {
		const oid = await text(cwd, [
			"hash-object",
			"--",
			path
		]);
		return oid === void 0 || oid.length === 0 ? void 0 : oid;
	};
	const blob = async (cwd, oid) => runGit(cwd, [
		"cat-file",
		"blob",
		oid
	]);
	const gitPath = async (cwd, name) => {
		const path = await text(cwd, [
			"rev-parse",
			"--git-path",
			name
		]);
		return path === void 0 || path.length === 0 ? void 0 : path;
	};
	return {
		isRepository,
		toplevel,
		commonDir,
		canonicalRemote,
		head,
		status,
		hashObject,
		blob,
		gitPath
	};
}
//#endregion
//#region src/host/git/identity.ts
/**
* `sha256:` + hex for a UTF-8 string. The prefix makes the value recognisable
* as a digest, so it cannot be mistaken for the path it was derived from.
*/
const digest = (value) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
/**
* Strip the parts of a remote URL that vary without meaning anything.
*
* A trailing slash and a trailing `.git` are the two spellings of the same
* repository that Git itself writes in different situations, so leaving them in
* would make `git@host:org/repo.git` and `git@host:org/repo` two workspaces.
* Nothing else is normalized: lower-casing the whole URL would break a
* case-sensitive server, and rewriting a relative remote would guess at a base
* this plugin does not have.
*/
function canonicalizeRemote(raw) {
	let value = raw.trim();
	if (value.endsWith("/")) value = value.slice(0, -1);
	if (value.endsWith(".git")) value = value.slice(0, -4);
	return value;
}
/** `realpath` the path when it exists, and fall back to `resolve` when it does not. */
async function canonicalPath(path) {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}
/**
* Derive a repository's identity, or `undefined` when there is no repository.
*
* The identity is `sha256((canonicalRemote ?? '') + '\0' + commonDir)`. The NUL
* separator is what keeps the two halves from running together: without it, a
* remote ending in the first character of a directory could collide with a
* different pair. `docs/ARCHITECTURE.md §11.2` writes the same formula, though
* its TypeScript sketch omits the parentheses the intent needs — `a ?? b + c`
* binds as `a ?? (b + c)`, which is not the formula it describes.
*
* With no remote the first half is empty and the common directory alone keys the
* repository, which is the best available answer for a local-only repository and
* is stable across every worktree of it.
*/
async function resolveRepositoryIdentity(git, cwd) {
	if (!await git.isRepository(cwd)) return void 0;
	const toplevel = await git.toplevel(cwd);
	const commonDir = await git.commonDir(cwd);
	if (toplevel === void 0 || commonDir === void 0) return void 0;
	const canonicalCommonDir = await canonicalPath(commonDir);
	const remote = await git.canonicalRemote(cwd);
	const canonicalRemote = remote === void 0 ? void 0 : canonicalizeRemote(remote);
	return {
		repoRoot: await canonicalPath(toplevel),
		commonDir: canonicalCommonDir,
		remote: canonicalRemote,
		rootIdentity: digest(`${canonicalRemote ?? ""}\0${canonicalCommonDir}`)
	};
}
//#endregion
//#region src/host/core.ts
/** Index file name under the plugin's private data root, per `docs/ARCHITECTURE.md §4.2`. */
const INDEX_FILENAME = "index.sqlite3";
/** The plugin-private index path for an already-resolved data root. */
function resolveIndexPath(dataRoot) {
	return join(dataRoot, INDEX_FILENAME);
}
const WORKSPACE_UNKNOWN = "workspace:unknown";
/**
* The fallback workspace id: an opaque hash of the session's `cwd`.
*
* Hashing rather than storing the path keeps even the placeholder free of a user
* directory, matching `WorkspaceRecord.repoRootHash`. It is used when the cwd is
* not a repository, where a real repository identity does not exist to be had.
*/
function workspaceIdFor(cwd) {
	if (typeof cwd !== "string" || cwd.length === 0) return WORKSPACE_UNKNOWN;
	return `workspace:${createHash("sha256").update(cwd).digest("hex")}`;
}
const describe = (error) => error instanceof Error ? error.message : String(error);
/**
* Build the recorder: the event-to-record pipeline, without any of its I/O
* wiring.
*
* Events are processed strictly one at a time through a promise chain, so the
* order the harness published them in is the order they are written and no two
* events can interleave a read-modify-write of the same turn. Every step is
* contained: a malformed event, a failing payload write or a rejecting sink is
* recorded as a diagnostic and dropped, never propagated — a recorder that can
* fail its caller is a recorder that can fail the agent, which is the one thing
* `docs/PRD.md` forbids.
*/
function createRecorder(options) {
	const { config, sink, store, diagnostics, resolveWorkspaceId } = options;
	const assembler = createTurnAssembler();
	let queue = Promise.resolve();
	/**
	* Workspace ids already resolved, keyed by cwd.
	*
	* The memo is what keeps repository resolution off the per-event path: a
	* session emits hundreds of events from one cwd, and resolving the identity
	* once per session is the difference between one `git` call and hundreds.
	* Failure is cached too — a cwd that is not a repository will not become one
	* mid-session, and a broken `git` should be reported once rather than per
	* event.
	*/
	const workspaceIds = /* @__PURE__ */ new Map();
	/**
	* Resolve a session's workspace id, never throwing.
	*
	* A resolver that rejects would take the whole event with it, and the event's
	* workspace is bookkeeping rather than evidence, so a failure degrades to the
	* cwd hash and a diagnostic instead of losing the turn.
	*/
	const resolveWorkspace = (cwd) => {
		const key = cwd ?? "";
		const cached = workspaceIds.get(key);
		if (cached !== void 0) return cached;
		const pending = (async () => {
			if (resolveWorkspaceId === void 0) return workspaceIdFor(cwd);
			try {
				return await resolveWorkspaceId(cwd);
			} catch (error) {
				diagnostics.record({
					at: Date.now(),
					code: "trace.workspace-unresolved",
					message: `${key || "(no cwd)"}: ${describe(error)}`
				});
				return workspaceIdFor(cwd);
			}
		})();
		workspaceIds.set(key, pending);
		return pending;
	};
	/**
	* Write a payload's bytes before the activity that references them.
	*
	* Redaction has already run — `normalizeEvent` hands over bytes that have
	* been redacted and truncated — so the store is told `redaction: 'applied'`
	* and would reject the call if the kind and the policy disagreed. On failure
	* the payload is dropped from the event rather than recorded: an activity must
	* never name an object that is not there.
	*/
	const writePayload = async (event) => {
		const bytes = event.payloadBytes;
		const meta = event.payload;
		if (bytes === void 0 || meta === void 0) return event;
		const stored = await store.put(OBJECT_KINDS.ACTIVITY_PAYLOAD, bytes, { redaction: "applied" });
		await sink.putObjectRecord({
			schemaVersion: 2,
			ref: stored.ref,
			kind: OBJECT_KINDS.ACTIVITY_PAYLOAD,
			byteSize: stored.byteSize,
			sha256: stored.sha256,
			createdAt: Date.now()
		});
		return event;
	};
	/** The event with every payload field stripped, for when the write failed. */
	const withoutPayload = (event) => {
		const { payloadRef: _ref, payloadBytes: _bytes, payload: _meta, ...rest } = event;
		return rest;
	};
	/**
	* Persist one turn row, protecting a terminal status.
	*
	* `upsertTurn` is a plain last-write-wins upsert by design, so writing a
	* stale non-terminal record for a turn the index already considers finished
	* would silently resurrect it. `transitionTurn` against the *stored* status
	* is the guard, and it protects only the terminal facts — the terminal status
	* and the end timestamp — so the counts this layer legitimately updates still
	* flow through. Reading first is what makes this correct across a restart,
	* where the assembler has no memory of a turn it did not close.
	*/
	const writeTurn = async (record) => {
		const stored = await sink.getTurn(record.id);
		if (stored === void 0) {
			await sink.upsertTurn(record);
			return;
		}
		const status = transitionTurn(stored.status, record.status);
		if (status === record.status) {
			await sink.upsertTurn(record);
			return;
		}
		await sink.upsertTurn({
			...record,
			status,
			endedAt: stored.endedAt
		});
	};
	const handle = async (session, event) => {
		const workspaceId = await resolveWorkspace(session.cwd);
		const normalized = normalizeEvent(session.id, workspaceId, event, config);
		if (normalized === void 0) {
			if (typeof event.type === "string") diagnostics.recordIgnoredKind(event.type);
			return;
		}
		let ingestable = normalized;
		try {
			ingestable = await writePayload(normalized);
		} catch (error) {
			diagnostics.record({
				at: Date.now(),
				code: "trace.payload-failed",
				message: `${normalized.activityId}: ${describe(error)}`
			});
			ingestable = withoutPayload(normalized);
		}
		const output = assembler.ingest(ingestable);
		if (output.ignored) {
			diagnostics.record({
				at: Date.now(),
				code: "trace.event-unattributed",
				message: `${normalized.activityId} (${normalized.kind}) has no open turn to belong to`
			});
			return;
		}
		if (output.dropped > 0) diagnostics.record({
			at: Date.now(),
			code: "trace.buffer-overflow",
			message: `shed ${output.dropped} event(s) waiting for a turn that never opened`
		});
		for (const turn of output.turns) await writeTurn(turn);
		for (const activity of output.activities) await sink.appendActivity(activity);
	};
	const record = (session, event) => {
		const task = queue.then(() => handle(session, event)).catch((error) => {
			diagnostics.record({
				at: Date.now(),
				code: "trace.event-failed",
				message: describe(error)
			});
		});
		queue = task;
		return task;
	};
	return {
		record,
		flush: async () => {
			await queue;
		}
	};
}
/**
* Wire the recorder into a live plugin context.
*
* This is the fail-open boundary of the whole plugin. Everything that can go
* wrong here — a data root that cannot be resolved, a foreign or corrupt index
* file, an unwritable directory, a store that will not mount — is caught and
* turned into a diagnostic plus an inert core, because the alternative is an
* exception escaping into harness startup. Losing recording is an acceptable
* outcome; blocking the agent is not, and that is a hard requirement of
* `docs/PRD.md`, not a preference.
*
* A partially built core releases what it already opened before it gives up,
* so a failure never leaks a database handle for the life of the process.
*/
async function startTraceCore(ctx, config, diagnostics) {
	try {
		const root = resolveDataRoot(config, { DSH_HOME: process.env["DSH_HOME"] }, homedir());
		const handle = await openIndex(resolveIndexPath(root));
		try {
			const repository = createRepository(handle);
			const store = createObjectStore(root);
			const git = createGitPort(createExecFileRunner());
			const recorder = createRecorder({
				config,
				sink: repository,
				store,
				diagnostics,
				resolveWorkspaceId: async (cwd) => {
					return (cwd === void 0 || cwd.length === 0 ? void 0 : await resolveRepositoryIdentity(git, cwd))?.rootIdentity ?? workspaceIdFor(cwd);
				}
			});
			const unsubscribe = subscribeSessionEvents(ctx, (session, event) => {
				recorder.record({
					id: session.id,
					cwd: session.header.cwd
				}, event);
			});
			return {
				flush: () => recorder.flush(),
				stop: async () => {
					try {
						unsubscribe();
						await recorder.flush();
						await repository.close();
					} catch (error) {
						diagnostics.record({
							at: Date.now(),
							code: "trace.stop-failed",
							message: describe(error)
						});
					}
				}
			};
		} catch (error) {
			try {
				handle.close();
			} catch {}
			throw error;
		}
	} catch (error) {
		diagnostics.record({
			at: Date.now(),
			code: "trace.disabled",
			message: describe(error)
		});
		return {
			flush: async () => {},
			stop: async () => {}
		};
	}
}
//#endregion
//#region src/index.ts
const name = "turnscope";
/**
* Host entry. Recording is best-effort: a failure here must never surface to
* the harness, so this function is a hard boundary and never throws.
*
* It is `async` so that the recorder is fully wired before the plugin's fiber
* reports itself loaded — a caller that awaits the fiber is then guaranteed
* that the subscription is in place, and no event published at mount time can
* race the listener into existence. `startTraceCore` already contains its own
* failures; the `try/catch` here is the guarantee that nothing else can escape,
* including a disposal that races this body.
*/
async function apply(ctx, config) {
	const resolved = resolveConfig(config);
	if (!resolved.enabled) return;
	const diagnostics = new Diagnostics();
	try {
		const core = await startTraceCore(ctx, resolved, diagnostics);
		ctx.effect(() => () => core.stop(), "turnscope trace core");
	} catch {}
}
//#endregion
export { apply, name };
