import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { TurnscopeConfig } from '../src/config.ts'
import { Diagnostics } from '../src/diagnostics.ts'
import { SCHEMA_VERSION } from '../src/domain/types.ts'
import type { ActivityRecord, ObjectRecord, TurnRecord, TurnStatus } from '../src/domain/types.ts'
import { createObjectStore } from '../src/storage/object-store.ts'
import { BUFFER_CEILING, createTurnAssembler } from '../src/adapter/assembler.ts'
import type { AssemblerOutput } from '../src/adapter/assembler.ts'
import { describeLabel, normalizeEvent } from '../src/adapter/normalize.ts'
import type { RawSessionEvent } from '../src/adapter/normalize.ts'
import { createRecorder } from '../src/trace-core.ts'
import type { TraceSink } from '../src/trace-core.ts'

const TIME = 1_789_042_697_930
const SESSION = 's-1'
const WORKSPACE = 'w-1'
/** `sk-` plus 24 characters, the exact shape the redactor recognizes. */
const SECRET = `sk-${'abcdefghijklmnopqrstuvwx'}`

/** The config every test normalizes with, unless it overrides one field. */
const CONFIG = resolveConfig({})

/** One upstream envelope, shaped exactly like the verified harness dumps. */
const raw = (type: string, seq: number, data: unknown, time = TIME + seq): RawSessionEvent => ({
  type,
  seq,
  time,
  data,
})

const turnStart = (turn = 0, seq = 0): RawSessionEvent => raw('turn/start', seq, { turn })
const turnEnd = (reason: unknown, turn = 0, seq = 99): RawSessionEvent =>
  raw('turn/end', seq, { turn, reason })
const stepStart = (turn = 0, step = 0, seq = 1): RawSessionEvent =>
  raw('step/start', seq, { turn, step })
const stepEnd = (turn = 0, step = 0, seq = 6): RawSessionEvent =>
  raw('step/end', seq, { turn, step })
const toolCall = (seq = 2, turn = 0, name = 'read_file'): RawSessionEvent =>
  raw('tool/call', seq, { turn, step: 0, callId: 'call-1', name, arguments: '{"path":"/tmp/x"}' })
const userMessage = (seq = 1, text = 'hello from spike'): RawSessionEvent =>
  raw('user/message', seq, {
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
    role: 'user',
    id: 'u-1',
  })
const assistantMessage = (seq = 5): RawSessionEvent =>
  raw('assistant/message', seq, {
    turn: 0,
    step: 0,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      id: 'a-1',
    },
  })

/** A `tool/result` in the exact nested shape the harness records. */
const toolResult = (seq: number, text: string, isError = false, turn = 0): RawSessionEvent =>
  raw('tool/result', seq, {
    turn,
    step: 0,
    message: {
      source: { kind: 'tool', callId: 'call-1' },
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text }],
          isError,
        },
      ],
      role: 'user',
      id: 'r-1',
    },
  })

/** The eight-event sequence of one complete turn, per the verified dumps. */
const completedTurn = (): readonly RawSessionEvent[] => [
  turnStart(0, 0),
  userMessage(1),
  stepStart(0, 0, 2),
  toolCall(3),
  toolResult(4, 'file body'),
  assistantMessage(5),
  stepEnd(0, 0, 6),
  turnEnd({ kind: 'completed' }, 0, 7),
]

describe('normalizeEvent + createTurnAssembler', () => {
  type Assembler = ReturnType<typeof createTurnAssembler>

  /** Normalize then ingest, exactly as the recorder composes the two. */
  const feed = (
    target: Assembler,
    event: RawSessionEvent,
    config: TurnscopeConfig = CONFIG,
  ): AssemblerOutput => target.ingest(normalizeEvent(SESSION, WORKSPACE, event, config))

  const play = (
    target: Assembler,
    events: readonly RawSessionEvent[],
  ): readonly AssemblerOutput[] => events.map(event => feed(target, event))

  it('opens a turn as running when only turn/start arrives', () => {
    const output = feed(createTurnAssembler(), turnStart(0, 0))
    expect(output.ignored).toBe(false)
    expect(output.turns).toHaveLength(1)
    expect(output.turns[0]).toMatchObject({
      id: 's-1:turn:0',
      sessionId: SESSION,
      ordinal: 0,
      status: 'running',
      activityCount: 1,
      errorCount: 0,
    })
    expect(output.turns[0]?.endedAt).toBeUndefined()
    expect(output.activities.map(activity => activity.kind)).toEqual(['turn'])
  })

  it('assembles one completed turn with its activities in seq order', () => {
    const outputs = play(createTurnAssembler(), completedTurn())
    const activities = outputs.flatMap(output => [...output.activities])
    const last = outputs[outputs.length - 1]

    expect(activities).toHaveLength(8)
    expect(activities.map(activity => activity.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(activities.map(activity => activity.kind)).toEqual([
      'turn',
      'system',
      'model',
      'tool',
      'tool',
      'model',
      'model',
      'turn',
    ])
    expect(activities.map(activity => activity.phase)).toEqual([
      'started',
      'updated',
      'started',
      'started',
      'completed',
      'completed',
      'completed',
      'completed',
    ])
    expect(activities.every(activity => activity.turnId === 's-1:turn:0')).toBe(true)
    expect(activities.every(activity => activity.label.length > 0)).toBe(true)

    expect(last?.ignored).toBe(false)
    // One turn, not one output that mentions a turn: every event of an open
    // turn re-emits that turn so `activityCount` and `errorCount` stay current,
    // which is what makes the counters below readable without a read-back.
    const emitted = outputs.flatMap(output => [...output.turns])
    expect(new Set(emitted.map(turn => turn.id))).toEqual(new Set(['s-1:turn:0']))
    expect(last?.turns[0]).toMatchObject({
      id: 's-1:turn:0',
      status: 'completed',
      ordinal: 0,
      startedAt: TIME,
      endedAt: TIME + 7,
      activityCount: 8,
      errorCount: 0,
    })
  })

  it('counts a failed tool result and marks its activity failed', () => {
    const assembler = createTurnAssembler()
    play(assembler, [turnStart(0, 0)])
    const output = feed(assembler, toolResult(1, 'boom', true))
    expect(output.activities).toHaveLength(1)
    expect(output.activities[0]?.kind).toBe('tool')
    expect(output.activities[0]?.phase).toBe('failed')
    expect(output.turns[0]?.errorCount).toBe(1)
    expect(output.turns[0]?.activityCount).toBe(2)
  })

  it('maps every turn/end reason onto a terminal status', () => {
    const cases: ReadonlyArray<readonly [unknown, TurnStatus]> = [
      [{ kind: 'completed' }, 'completed'],
      [{ kind: 'error', error: { message: 'x', code: 'UNKNOWN' } }, 'failed'],
      [{ kind: 'blocked' }, 'failed'],
      [{ kind: 'max-tokens' }, 'failed'],
      [{ kind: 'interrupted' }, 'interrupted'],
      [{ kind: 'aborted', reason: { kind: 'user' } }, 'interrupted'],
    ]
    for (const [reason, expected] of cases) {
      const outputs = play(createTurnAssembler(), [turnStart(0, 0), turnEnd(reason, 0, 1)])
      expect(outputs[1]?.turns[0]?.status).toBe(expected)
    }
  })

  it('closes a turn it never saw start, and maps an unknown reason to interrupted', () => {
    const outputs = play(createTurnAssembler(), [turnEnd({ kind: 'something-new' }, 3, 0)])
    expect(outputs[0]?.turns[0]).toMatchObject({
      id: 's-1:turn:3',
      ordinal: 3,
      status: 'interrupted',
      activityCount: 1,
    })
  })

  it('absorbs a late turn/end without reverting the status already reached', () => {
    const assembler = createTurnAssembler()
    play(assembler, [turnStart(0, 0), turnEnd({ kind: 'interrupted' }, 0, 1)])
    const late = feed(assembler, turnEnd({ kind: 'completed' }, 0, 2))
    expect(late.turns[0]?.status).toBe('interrupted')
    // The first end is the real one, so the late event must not move it...
    expect(late.turns[0]?.endedAt).toBe(TIME + 1)
    // ...but its activity is still appended rather than dropped.
    expect(late.activities).toHaveLength(1)
    expect(late.activities[0]?.phase).toBe('completed')
    expect(late.turns[0]?.activityCount).toBe(3)
  })

  it('never resurrects a closed turn from a stale running record', () => {
    const assembler = createTurnAssembler()
    play(assembler, [turnStart(0, 0), turnEnd({ kind: 'completed' }, 0, 1)])
    const stale = feed(assembler, turnStart(0, 2))
    expect(stale.turns[0]?.status).toBe('completed')
    expect(stale.turns[0]?.endedAt).toBe(TIME + 1)
  })

  it('ignores an unrecognised event type and counts it by name', () => {
    const assembler = createTurnAssembler()
    const diagnostics = new Diagnostics()
    for (const seq of [0, 1]) {
      const event = raw('vendor/custom', seq, { anything: true })
      const normalized = normalizeEvent(SESSION, WORKSPACE, event, CONFIG)
      expect(normalized).toBeUndefined()
      const output = assembler.ingest(normalized)
      expect(output.ignored).toBe(true)
      expect(output.activities).toHaveLength(0)
      expect(output.turns).toHaveLength(0)
      diagnostics.recordIgnoredKind(event.type)
    }
    expect(diagnostics.snapshotIgnoredKinds().get('vendor/custom')).toBe(2)
  })

  it('ignores malformed upstream data instead of throwing', () => {
    const assembler = createTurnAssembler()
    const malformed: readonly RawSessionEvent[] = [
      raw('turn/start', 0, {}),
      raw('turn/start', 1, null),
      raw('turn/start', 2, 42),
      raw('tool/result', 3, { turn: 0, step: 0 }),
      raw('step/start', 4, { step: 0 }),
    ]
    for (const event of malformed) {
      let output: AssemblerOutput | undefined
      expect(() => {
        output = feed(assembler, event)
      }).not.toThrow()
      expect(output?.ignored).toBe(true)
      expect(output?.activities).toHaveLength(0)
    }
    expect(assembler.pendingCount()).toBe(0)
    // The assembler is still usable after malformed input.
    expect(feed(assembler, turnStart(0, 9)).turns).toHaveLength(1)
  })

  it('buffers an event whose turn has not opened yet and drains it on turn/start', () => {
    const assembler = createTurnAssembler()
    const orphan = feed(assembler, toolResult(5, 'late result', false, 2))
    expect(orphan.turns).toHaveLength(0)
    expect(orphan.activities).toHaveLength(0)
    expect(orphan.ignored).toBe(false)
    expect(assembler.pendingCount()).toBe(1)

    const opened = feed(assembler, turnStart(2, 2))
    expect(assembler.pendingCount()).toBe(0)
    const drained = opened.activities.find(activity => activity.kind === 'tool')
    expect(drained?.turnId).toBe('s-1:turn:2')
    expect(drained?.label).toBe('Tool: call-1')
    expect(opened.turns[0]).toMatchObject({
      id: 's-1:turn:2',
      ordinal: 2,
      status: 'running',
      activityCount: 2,
    })
  })

  it('bounds the buffer and sheds the oldest entries rather than growing', () => {
    const assembler = createTurnAssembler()
    let dropped = 0
    for (let index = 0; index < 1_000; index += 1) {
      const output = feed(assembler, toolResult(index, `orphan ${index}`, false, 7))
      dropped += output.dropped
      expect(assembler.pendingCount()).toBeLessThanOrEqual(BUFFER_CEILING)
    }
    expect(assembler.pendingCount()).toBe(BUFFER_CEILING)
    expect(dropped).toBe(1_000 - BUFFER_CEILING)

    // The turn itself is still created, so shedding never loses a turn.
    const opened = feed(assembler, turnStart(7, 1_001))
    expect(opened.turns[0]?.id).toBe('s-1:turn:7')
    expect(opened.activities).toHaveLength(BUFFER_CEILING + 1)
  })

  it('labels activities from identifiers only, never from payload text', () => {
    const assembler = createTurnAssembler()
    const call = raw('tool/call', 1, {
      turn: 0,
      step: 0,
      callId: 'call-1',
      name: 'read_file',
      arguments: JSON.stringify({ apiKey: SECRET }),
    })
    play(assembler, [turnStart(0, 0)])
    const output = feed(assembler, call)
    expect(output.activities[0]?.label).toBe('Tool: read_file')
    expect(JSON.stringify(output.activities)).not.toContain(SECRET)

    const normalized = normalizeEvent(SESSION, WORKSPACE, call, CONFIG)
    expect(normalized).toBeDefined()
    if (normalized === undefined) return
    expect(normalized.label).toBe('Tool: read_file')
    expect(describeLabel(normalized, call)).toBe('Tool: read_file')
    expect(describeLabel(normalized, call)).not.toContain('sk-')
  })

  it('labels a turn, a step and a compaction from identifiers alone', () => {
    const events: readonly RawSessionEvent[] = [
      turnStart(0, 0),
      stepStart(0, 2, 1),
      raw('compaction/start', 2, { turn: 0, summary: SECRET }),
      turnEnd({ kind: 'max-tokens' }, 0, 3),
    ]
    for (const event of events) {
      const normalized = normalizeEvent(SESSION, WORKSPACE, event, CONFIG)
      expect(normalized).toBeDefined()
      if (normalized === undefined) continue
      expect(normalized.label.length).toBeGreaterThan(0)
      expect(normalized.label).not.toContain(SECRET)
    }
    const start = normalizeEvent(SESSION, WORKSPACE, turnStart(0, 0), CONFIG)
    expect(start?.label).toBe('Turn started')
    const failed = normalizeEvent(SESSION, WORKSPACE, turnEnd({ kind: 'error' }, 0, 1), CONFIG)
    expect(failed?.label).toBe('Turn failed')
  })
})

interface FakeSink extends TraceSink {
  readonly turns: Map<string, TurnRecord>
  readonly activities: ActivityRecord[]
  readonly objects: ObjectRecord[]
}

const createFakeSink = (): FakeSink => {
  const turns = new Map<string, TurnRecord>()
  const activities: ActivityRecord[] = []
  const objects: ObjectRecord[] = []
  return {
    turns,
    activities,
    objects,
    getTurn: async id => turns.get(id),
    upsertTurn: async record => {
      turns.set(record.id, record)
    },
    appendActivity: async record => {
      activities.push(record)
    },
    putObjectRecord: async record => {
      objects.push(record)
    },
  }
}

interface Harness {
  readonly sink: FakeSink
  readonly diagnostics: Diagnostics
  readonly config: TurnscopeConfig
  readonly store: ReturnType<typeof createObjectStore>
  readonly recorder: ReturnType<typeof createRecorder>
}

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const harness = async (config: unknown = {}): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), 'turnscope-assembler-'))
  roots.push(root)
  const store = createObjectStore(root)
  const sink = createFakeSink()
  const diagnostics = new Diagnostics()
  const resolved = resolveConfig(config)
  const recorder = createRecorder({ config: resolved, sink, store, diagnostics })
  return { sink, diagnostics, config: resolved, store, recorder }
}

const playRecorder = async (h: Harness, events: readonly RawSessionEvent[]): Promise<void> => {
  for (const event of events) await h.recorder.record({ id: SESSION, cwd: undefined }, event)
}

describe('recorder persistence', () => {
  it('redacts a payload before the object store ever sees it', async () => {
    const h = await harness()
    await playRecorder(h, [
      turnStart(0, 0),
      toolResult(1, `the file said ${SECRET} and then ${SECRET} again`),
    ])

    const stored = h.sink.activities.find(activity => activity.kind === 'tool')
    expect(stored?.payloadRef).toMatch(/^sha256:[0-9a-f]{64}$/)
    // A payload that was not cut must not claim it was.
    expect('truncated' in (stored ?? {})).toBe(false)

    // No string the assembler emitted carries the secret...
    expect(JSON.stringify(h.sink.turns)).not.toContain(SECRET)
    expect(JSON.stringify(h.sink.activities)).not.toContain(SECRET)

    // ...and neither do the bytes the object store actually holds.
    if (stored?.payloadRef === undefined) return
    const bytes = await h.store.get(stored.payloadRef)
    const text = Buffer.from(bytes).toString('utf8')
    expect(text).not.toContain(SECRET)
    expect(text).toContain('[REDACTED:openai-key]')

    // The index row names the same object the activity references.
    expect(h.sink.objects).toHaveLength(1)
    expect(h.sink.objects[0]?.ref).toBe(stored.payloadRef)
    expect(h.sink.objects[0]?.byteSize).toBe(bytes.byteLength)
  })

  it('stores an oversized payload truncated and reports the true original size', async () => {
    const h = await harness({ maxOutputBytes: 64 })
    const body = 'A'.repeat(500)
    const normalized = normalizeEvent(SESSION, WORKSPACE, toolResult(1, body), h.config)
    expect(normalized?.payload?.originalBytes).toBe(500)
    expect(normalized?.payload?.truncated).toBe(true)
    expect(normalized?.payload?.byteSize).toBeLessThanOrEqual(64)

    await playRecorder(h, [turnStart(0, 0), toolResult(1, body)])
    const stored = h.sink.activities.find(activity => activity.kind === 'tool')
    expect(stored?.truncated).toBe(true)
    if (stored?.payloadRef === undefined) return
    const text = Buffer.from(await h.store.get(stored.payloadRef)).toString('utf8')
    expect(text).toContain('…[truncated]')
    expect(text.length).toBeLessThan(500)
  })

  it('records the turn and only drops the payload when the object store fails', async () => {
    const h = await harness()
    const failing = {
      ...h.store,
      put: async (): Promise<never> => {
        throw new Error('store offline')
      },
    }
    const recorder = createRecorder({
      config: h.config,
      sink: h.sink,
      store: failing,
      diagnostics: h.diagnostics,
    })
    await recorder.record({ id: SESSION, cwd: undefined }, turnStart(0, 0))
    await recorder.record({ id: SESSION, cwd: undefined }, toolResult(1, 'file body'))

    const stored = h.sink.activities.find(activity => activity.kind === 'tool')
    expect(stored).toBeDefined()
    // An activity must never name an object that was not stored.
    expect(stored?.payloadRef).toBeUndefined()
    expect(h.sink.turns.get('s-1:turn:0')?.activityCount).toBe(2)
    expect(h.diagnostics.snapshot().some(entry => entry.code === 'trace.payload-failed')).toBe(true)
  })

  it('does not resurrect a turn the index already holds as terminal', async () => {
    const h = await harness()
    // What a re-mounted plugin sees after a restart: a closed row it did not write.
    await h.sink.upsertTurn({
      schemaVersion: SCHEMA_VERSION,
      id: 's-1:turn:0',
      sessionId: SESSION,
      ordinal: 0,
      status: 'completed',
      startedAt: TIME,
      endedAt: TIME + 1,
      activityCount: 4,
      errorCount: 0,
    })
    await playRecorder(h, [turnStart(0, 5)])

    const turn = h.sink.turns.get('s-1:turn:0')
    expect(turn?.status).toBe('completed')
    expect(turn?.endedAt).toBe(TIME + 1)
    // The guard protects the terminal state, not the whole row: the fields the
    // assembler legitimately updates still flow through.
    expect(turn?.activityCount).toBe(1)
  })

  it('never lets a malformed event reject the record promise', async () => {
    const h = await harness()
    await expect(
      h.recorder.record({ id: SESSION, cwd: undefined }, raw('turn/start', 0, null)),
    ).resolves.toBeUndefined()
    await expect(
      h.recorder.record({ id: SESSION, cwd: undefined }, raw('vendor/other', 1, {})),
    ).resolves.toBeUndefined()
    await expect(
      h.recorder.record({ id: SESSION, cwd: undefined }, raw('turn/start', Number.NaN, { turn: 0 })),
    ).resolves.toBeUndefined()
    expect(h.diagnostics.snapshotIgnoredKinds().get('vendor/other')).toBe(1)
  })
})
