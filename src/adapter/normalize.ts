import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { TurnscopeConfig } from '../config.ts'
import { activityIdFor, turnIdFor } from '../domain/ids.ts'
import { SCHEMA_VERSION } from '../domain/types.ts'
import type { EventKind, EventPhase, NormalizedEvent } from '../domain/types.ts'
import { redact } from '../redaction/redact.ts'
import { truncateBytes } from '../redaction/truncate.ts'

/**
 * The upstream SessionEvent envelope, as broadly as the adapter needs it.
 *
 * Deliberately structural rather than the harness's own union: a merge-extensible
 * `SessionEventMap` means a *newer* harness (or another plugin) can publish event
 * types this build has never seen, and the adapter's whole contract is that an
 * unrecognised type degrades to an ignored event rather than a compile or
 * runtime failure. `data` is `unknown` on purpose — every field is narrowed
 * here, never trusted.
 */
export interface RawSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/**
 * Turn ordinal standing in for "the harness did not attribute this event to a
 * turn". Only `turnIdFor` ever sees it, and no real turn can collide with it:
 * a turn-bearing event must carry a non-negative ordinal to be normalized at
 * all, so the sentinel can never name a turn that exists.
 */
export const UNATTRIBUTED_TURN = -1

/** The sentinel turn id an unattributed event carries until the assembler places it. */
export const unattributedTurnId = (sessionId: string): string =>
  turnIdFor(sessionId, UNATTRIBUTED_TURN)

/** What redaction, truncation and content addressing produced for one payload. */
export interface PreparedPayload {
  /** True when `truncateBytes` dropped bytes; the only honest truncation signal. */
  readonly truncated: boolean
  /** Size in bytes *before* truncation, measured after redaction. */
  readonly originalBytes: number
  /** Size in bytes of the text that would be stored. */
  readonly byteSize: number
  /** Bare hex digest, for the `objects` row. */
  readonly sha256: string
}

/**
 * One normalized event, plus the facts the versioned {@link NormalizedEvent}
 * seam deliberately does not carry.
 *
 * `seq`, `label` and the payload are all derivable only here, and none of them
 * belongs in the seam: `seq` is upstream bookkeeping, `label` is presentation,
 * and the payload is bytes no consumer of the seam should have to hold.
 */
export interface NormalizedActivity extends NormalizedEvent {
  /** Upstream sequence number; the activity table is ordered by it. */
  readonly seq: number
  /** Upstream turn ordinal, when the event named one. */
  readonly turn: number | undefined
  /** Identifier-only summary for the timeline; never contains payload text. */
  readonly label: string
  /** Redacted, truncated bytes ready to write; absent when the event carries no text. */
  readonly payloadBytes?: Uint8Array
  /** Metadata for {@link payloadBytes}; present exactly when those bytes are. */
  readonly payload?: PreparedPayload
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined

/** A non-negative safe integer, or `undefined` for anything else. */
const asIndex = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/** The `turn` an event payload names, if it names a usable one. */
const turnOf = (data: Record<string, unknown> | undefined): number | undefined =>
  data === undefined ? undefined : asIndex(data['turn'])

/**
 * Types the harness always attributes to a turn. Without one they cannot be
 * placed and the event is ignored rather than guessed at.
 */
const TURN_BEARING: ReadonlySet<string> = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'assistant/message',
  'tool/call',
  'tool/result',
])

/** The unconditional `type → [kind, phase]` table of `docs/ARCHITECTURE.md §3.1`. */
const SHAPES: Readonly<Record<string, readonly [EventKind, EventPhase]>> = Object.freeze({
  'step/start': ['model', 'started'],
  'step/end': ['model', 'completed'],
  'user/message': ['system', 'updated'],
  'assistant/message': ['model', 'completed'],
  'tool/call': ['tool', 'started'],
  'approval/asked': ['approval', 'started'],
  'approval/decided': ['approval', 'completed'],
})

type TerminalStatus = 'completed' | 'failed' | 'interrupted'

/**
 * `turn/end{reason}` to the status it produced.
 *
 * Every kind in the union maps to a terminal status; a kind this build does not
 * know — the union is merge-extensible — closes the turn as `interrupted`,
 * which claims only that the turn ended without a recorded completion. Leaving
 * the turn open instead would be a permanent, silent leak of an unfinished row.
 */
const STATUS_BY_REASON: Readonly<Record<string, TerminalStatus>> = Object.freeze({
  completed: 'completed',
  error: 'failed',
  blocked: 'failed',
  'max-tokens': 'failed',
  interrupted: 'interrupted',
  aborted: 'interrupted',
})

const statusForReason = (data: Record<string, unknown> | undefined): TerminalStatus => {
  const reason = asRecord(data?.['reason'])
  const kind = asText(reason?.['kind'])
  return kind === undefined ? 'interrupted' : (STATUS_BY_REASON[kind] ?? 'interrupted')
}

/** Whether a `tool/result` reports failure. Anything but `true` is success. */
const isErrorResult = (data: Record<string, unknown> | undefined): boolean => {
  const content = asRecord(data?.['message'])?.['content']
  if (!Array.isArray(content)) return false
  for (const part of content) {
    if (asRecord(part)?.['isError'] === true) return true
  }
  return false
}

/**
 * The text blocks of a message-shaped container, joined in order.
 *
 * Only `text` blocks contribute: a reasoning block is model-internal, and an
 * image block is a reference the object store cannot render.
 */
const contentText = (container: Record<string, unknown>): string | undefined => {
  const content = container['content']
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    const block = asRecord(part)
    if (block === undefined || block['type'] !== 'text') continue
    const text = block['text']
    if (typeof text === 'string') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** The nested `content[].content[].text` chain a `tool/result` message carries. */
const resultText = (value: unknown): string | undefined => {
  const content = asRecord(value)?.['content']
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    const block = asRecord(part)
    if (block === undefined) continue
    const nested = block['content']
    if (Array.isArray(nested)) {
      const text = contentText({ content: nested })
      if (text !== undefined) parts.push(text)
      continue
    }
    const text = block['text']
    if (typeof text === 'string') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * The text one upstream event contributes as its stored payload, if any.
 *
 * `tool/call.arguments` is taken verbatim: it is the raw unparsed JSON string
 * the model produced, and parsing it here would only turn a malformed argument
 * blob into a lost payload — the label reads names, never arguments.
 */
function payloadText(event: RawSessionEvent): string | undefined {
  const data = asRecord(event.data)
  if (data === undefined) return undefined
  switch (event.type) {
    case 'tool/call':
      return asText(data['arguments'])
    case 'tool/result':
      return resultText(data['message'])
    case 'user/message':
      return contentText(data)
    case 'assistant/message': {
      const message = asRecord(data['message'])
      return message === undefined ? undefined : contentText(message)
    }
    default:
      return undefined
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
function preparePayload(
  text: string | undefined,
  config: TurnscopeConfig,
): { readonly bytes: Uint8Array; readonly meta: PreparedPayload } | undefined {
  if (text === undefined) return undefined
  const truncated = truncateBytes(redact(text).text, config.maxOutputBytes)
  const bytes = Buffer.from(truncated.text, 'utf8')
  return {
    bytes,
    meta: Object.freeze({
      truncated: truncated.truncated,
      originalBytes: truncated.originalBytes,
      byteSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }),
  }
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
export function normalizeEvent(
  sessionId: string,
  workspaceId: string,
  event: RawSessionEvent,
  config: TurnscopeConfig,
): NormalizedActivity | undefined {
  if (typeof event.type !== 'string') return undefined
  if (asIndex(event.seq) === undefined) return undefined
  if (typeof event.time !== 'number' || !Number.isFinite(event.time)) return undefined

  const data = asRecord(event.data)
  const shape = shapeOf(event.type, data)
  if (shape === undefined) return undefined

  const turn = turnOf(data)
  if (turn === undefined && TURN_BEARING.has(event.type)) return undefined

  const prepared = preparePayload(payloadText(event), config)
  const activity: NormalizedActivity = {
    schemaVersion: SCHEMA_VERSION,
    workspaceId,
    sessionId,
    turnId: turn === undefined ? unattributedTurnId(sessionId) : turnIdFor(sessionId, turn),
    activityId: activityIdFor(sessionId, event.seq),
    kind: shape.kind,
    phase: shape.phase,
    occurredAt: new Date(event.time).toISOString(),
    // The ref is the content address of the bytes below. `ObjectRef.ref` is
    // documented as exactly `sha256:<64 lowercase hex>`, and that is what
    // `ObjectStore.put` returns for the same bytes, so the activity and the
    // stored object agree by construction without the store being reachable here.
    ...(prepared === undefined ? {} : { payloadRef: `sha256:${prepared.meta.sha256}` }),
    seq: event.seq,
    turn,
    label: '',
    ...(prepared === undefined ? {} : { payloadBytes: prepared.bytes, payload: prepared.meta }),
  }
  return { ...activity, label: describeLabel(activity, event) }
}

/** `kind` and `phase` for one event type, or `undefined` when it is not ours. */
function shapeOf(
  type: string,
  data: Record<string, unknown> | undefined,
): { readonly kind: EventKind; readonly phase: EventPhase } | undefined {
  const fixed = SHAPES[type]
  if (fixed !== undefined) return { kind: fixed[0], phase: fixed[1] }
  // `compaction/*` is a family, not a fixed name: its opening and closing
  // markers come and go, and every member is a system maintenance record.
  if (type.startsWith('compaction/')) return { kind: 'system', phase: 'updated' }
  if (type === 'turn/start') return { kind: 'turn', phase: 'started' }
  if (type === 'turn/end') return { kind: 'turn', phase: statusForReason(data) }
  if (type === 'tool/result') {
    // A result without its message is upstream data this build cannot judge:
    // it may be complete or truncated, and guessing either way would record a
    // phase the harness never asserted.
    if (asRecord(data?.['message']) === undefined) return undefined
    return { kind: 'tool', phase: isErrorResult(data) ? 'failed' : 'completed' }
  }
  return undefined
}

/** The identifier an event's label is about: a tool name, a call id, a step index. */
function subjectOf(event: RawSessionEvent | undefined): string | undefined {
  if (event === undefined) return undefined
  const data = asRecord(event.data)
  if (data === undefined) return undefined
  switch (event.type) {
    case 'tool/call':
      return asText(data['name']) ?? asText(data['callId'])
    case 'tool/result': {
      const source = asRecord(asRecord(data['message'])?.['source'])
      return asText(source?.['callId'])
    }
    case 'step/start':
    case 'step/end': {
      const step = asIndex(data['step'])
      return step === undefined ? undefined : `Step ${step}`
    }
    default:
      return undefined
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
export function describeLabel(normalized: NormalizedEvent, event?: RawSessionEvent): string {
  const subject = subjectOf(event)
  switch (normalized.kind) {
    case 'turn':
      switch (normalized.phase) {
        case 'started':
          return 'Turn started'
        case 'completed':
          return 'Turn completed'
        case 'interrupted':
          return 'Turn interrupted'
        default:
          return 'Turn failed'
      }
    case 'model':
      if (normalized.phase === 'started') return subject ?? 'Step started'
      return subject?.startsWith('Step') === true ? `${subject} completed` : 'Assistant message'
    case 'tool':
      return subject === undefined ? 'Tool call' : `Tool: ${subject}`
    case 'approval':
      return normalized.phase === 'started' ? 'Approval requested' : 'Approval decided'
    case 'system':
      return event?.type === 'user/message' ? 'User message' : 'Context'
    default:
      return normalized.phase === 'failed' ? 'Failed' : 'Activity'
  }
}
