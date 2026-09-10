import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { Buffer } from "node:buffer";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
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
/** States a turn can still move out of. Everything else is absorbing. */
const TERMINAL$1 = /* @__PURE__ */ new Set([
	"completed",
	"failed",
	"interrupted"
]);
/**
* Apply a status update to a turn, enforcing the transition rules of
* `docs/ARCHITECTURE.md §3.3`.
*
* ```text
* pending → running → completed
*                   ↘ failed
*                   ↘ interrupted
* ```
*
* Total and side-effect free: a terminal turn absorbs every later transition
* and yields `current` unchanged, so a late `completed` can never resurrect an
* interrupted turn — the caller keeps the turn and appends the late event as an
* activity instead.
*/
function transitionTurn(current, next) {
	return TERMINAL$1.has(current) ? current : next;
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
const MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
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
	const buffer = Buffer.from(input, "utf8");
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
	const bytes = Buffer.from(truncated.text, "utf8");
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
		schemaVersion: 1,
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
const TERMINAL = /* @__PURE__ */ new Set([
	"completed",
	"failed",
	"interrupted"
]);
const isTerminal = (status) => TERMINAL.has(status);
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
		schemaVersion: 1,
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
		schemaVersion: 1,
		id: moment.id,
		sessionId: moment.sessionId,
		ordinal: moment.ordinal,
		status: moment.status,
		startedAt: moment.startedAt,
		endedAt: moment.endedAt,
		activityCount: moment.activityCount,
		errorCount: moment.errorCount
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
* The object kinds this slice may store.
*
* Frozen, and the only source of valid values: a typo'd kind would file an
* object where nothing later looks for it, so {@link ObjectStore.put} rejects
* anything outside this set. A later Restore/Fork plan adds `diff` and
* `snapshot` by extending this one object.
*/
const OBJECT_KINDS = Object.freeze({ 
/** Redacted, truncated tool and command output. Written by Task 6. */
ACTIVITY_PAYLOAD: "activity-payload" });
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
	const put = async (kind, bytes) => {
		if (!KNOWN_KINDS.has(kind)) throw new Error(`unknown object kind ${JSON.stringify(kind)}; expected one of ${[...KNOWN_KINDS].join(", ")}`);
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
	if (userVersion > 1) {
		closeQuietly(db);
		throw new Error(`${dbPath} was written by a newer version of Turnscope (schema ${userVersion}; this build understands 1)`);
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
		if (current >= 1) return;
		db.exec("BEGIN IMMEDIATE");
		try {
			for (let version = current; version < 1; version += 1) {
				const migration = MIGRATIONS[version];
				if (migration === void 0) throw new Error(`no migration from schema version ${version} to ${version + 1}`);
				db.exec(migration);
			}
			db.exec(`PRAGMA user_version = 1`);
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
	schemaVersion: 1,
	id: text(row, "id"),
	sessionId: text(row, "session_id"),
	ordinal: integer(row, "ordinal"),
	status: text(row, "status"),
	startedAt: integer(row, "started_at"),
	endedAt: optionalInteger(row, "ended_at"),
	activityCount: integer(row, "activity_count"),
	errorCount: integer(row, "error_count"),
	...absent("preCheckpointId", optionalText(row, "pre_checkpoint_id")),
	...absent("postCheckpointId", optionalText(row, "post_checkpoint_id"))
});
const toActivity = (row) => ({
	schemaVersion: 1,
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
	schemaVersion: 1,
	id: text(row, "id"),
	workspaceId: text(row, "workspace_id"),
	turnId: text(row, "turn_id"),
	phase: text(row, "phase"),
	...absent("headOid", optionalText(row, "head_oid")),
	...absent("branch", optionalText(row, "branch")),
	cleanStart: flag(row, "clean_start"),
	...absent("indexDigest", optionalText(row, "index_digest")),
	...absent("worktreeDigest", optionalText(row, "worktree_digest")),
	...absent("fileDigests", optionalDigestMap(row, "file_digests")),
	restorable: flag(row, "restorable"),
	createdAt: integer(row, "created_at"),
	...absent("failureReason", optionalText(row, "failure_reason"))
});
const toObjectRecord = (row) => ({
	schemaVersion: 1,
	ref: text(row, "ref"),
	kind: text(row, "kind"),
	byteSize: integer(row, "byte_size"),
	sha256: text(row, "sha256"),
	createdAt: integer(row, "created_at")
});
const TURN_COLUMNS = "id, session_id, ordinal, status, started_at, ended_at, activity_count, error_count, pre_checkpoint_id, post_checkpoint_id";
const ACTIVITY_COLUMNS = "id, turn_id, session_id, parent_id, kind, phase, seq, label, occurred_at, payload_ref, truncated";
const CHECKPOINT_COLUMNS = "id, workspace_id, turn_id, phase, head_oid, branch, clean_start, index_digest, worktree_digest, file_digests, restorable, created_at, failure_reason";
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id,
         ordinal = excluded.ordinal,
         status = excluded.status,
         started_at = excluded.started_at,
         ended_at = excluded.ended_at,
         activity_count = excluded.activity_count,
         error_count = excluded.error_count,
         pre_checkpoint_id = excluded.pre_checkpoint_id,
         post_checkpoint_id = excluded.post_checkpoint_id`).run(record.id, record.sessionId, record.ordinal, record.status, record.startedAt, nullable(record.endedAt), record.activityCount, record.errorCount, nullable(record.preCheckpointId), nullable(record.postCheckpointId));
	};
	const closeTurn = async (turnId, status, endedAt) => {
		statement(`UPDATE turns SET status = ?, ended_at = ?
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'interrupted')`).run(status, endedAt, turnId);
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         turn_id = excluded.turn_id,
         phase = excluded.phase,
         head_oid = excluded.head_oid,
         branch = excluded.branch,
         clean_start = excluded.clean_start,
         index_digest = excluded.index_digest,
         worktree_digest = excluded.worktree_digest,
         file_digests = excluded.file_digests,
         restorable = excluded.restorable,
         created_at = excluded.created_at,
         failure_reason = excluded.failure_reason`).run(record.id, record.workspaceId, record.turnId, record.phase, nullable(record.headOid), nullable(record.branch), toSqlFlag(record.cleanStart), nullable(record.indexDigest), nullable(record.worktreeDigest), record.fileDigests === void 0 ? null : JSON.stringify(record.fileDigests), toSqlFlag(record.restorable), record.createdAt, nullable(record.failureReason));
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
		return all(`SELECT DISTINCT payload_ref AS ref FROM activities
       WHERE payload_ref IS NOT NULL
       ORDER BY ref ASC`).map((row) => text(row, "ref"));
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
		listTurns,
		getTurn,
		appendActivity,
		getActivities,
		putCheckpoint,
		getCheckpoint,
		listCheckpoints,
		putObjectRecord,
		statObject,
		referencedRefs,
		storageUsage,
		close
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
* A stable, opaque workspace id for one session.
*
* The session's `cwd` is all this slice knows about where the work happened;
* Task 7's workspace observation replaces this with a real repository identity
* once the Git root is resolvable. Hashing rather than storing the path keeps
* even the placeholder free of a user directory, matching
* `WorkspaceRecord.repoRootHash`.
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
	const { config, sink, store, diagnostics } = options;
	const assembler = createTurnAssembler();
	let queue = Promise.resolve();
	/**
	* Write a payload's bytes before the activity that references them.
	*
	* Redaction has already run — `normalizeEvent` hands over bytes that have
	* been redacted and truncated — so the object store never sees raw text. On
	* failure the payload is dropped from the event rather than recorded: an
	* activity must never name an object that is not there.
	*/
	const writePayload = async (event) => {
		const bytes = event.payloadBytes;
		const meta = event.payload;
		if (bytes === void 0 || meta === void 0) return event;
		const stored = await store.put(OBJECT_KINDS.ACTIVITY_PAYLOAD, bytes);
		await sink.putObjectRecord({
			schemaVersion: 1,
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
		const normalized = normalizeEvent(session.id, workspaceIdFor(session.cwd), event, config);
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
			const recorder = createRecorder({
				config,
				sink: repository,
				store: createObjectStore(root),
				diagnostics
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
