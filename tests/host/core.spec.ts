import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Fiber } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, name } from '../../src/index.ts'
import { createRepository } from '../../src/host/storage/repository.ts'
import type { TraceRepository } from '../../src/host/storage/repository.ts'
import { openIndex } from '../../src/host/storage/sqlite-index.ts'
import { resolveIndexPath } from '../../src/host/core.ts'

const SECRET = `sk-${'abcdefghijklmnopqrstuvwx'}`

const roots: string[] = []
const locked: string[] = []

afterEach(async () => {
  // Restore write permission first, or the recursive remove cannot unlink the
  // entries inside a directory the test made read-only.
  for (const dir of locked.splice(0)) await chmod(dir, 0o700)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'turnscope-core-'))
  roots.push(root)
  return root
}

/**
 * Mount the real plugin on a real context over a real session store.
 *
 * `fiber.await()` resolves only once the plugin callback settled and rethrows
 * anything it threw, so awaiting it *is* the "the plugin loaded" assertion.
 */
const mount = async (dataDir: string): Promise<{ ctx: Context; fiber: Fiber }> => {
  const ctx = new Context()
  await ctx.plugin(SessionStore).await()
  const fiber = ctx.plugin({ name, apply }, { dataDir })
  await fiber.await()
  return { ctx, fiber }
}

/** Open a second handle on the same index, the way a reader would. */
const reader = async (
  dataDir: string,
): Promise<{ repo: TraceRepository; close: () => Promise<void> }> => {
  const handle = await openIndex(resolveIndexPath(dataDir))
  const repo = createRepository(handle)
  return { repo, close: () => repo.close() }
}

/** Poll until a probe answers, so the test never waits on a fixed sleep. */
const waitFor = async <T>(
  probe: () => Promise<T | undefined>,
  timeoutMs = 4_000,
): Promise<T | undefined> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Give the recorder's async queue a chance to drain before asserting absence. */
const settle = async (): Promise<void> => {
  for (let round = 0; round < 20; round += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('trace core over a real session store', () => {
  it('records a complete turn driven through ctx.sessions', async () => {
    const dataDir = await tempRoot()
    const { ctx } = await mount(dataDir)

    const session = ctx.sessions.create(SessionId('s-e2e'), { meta: { cwd: dataDir } })
    session.append('turn/start', { turn: 0 })
    session.append('step/start', { turn: 0, step: 0 })
    session.append('tool/call', {
      turn: 0,
      step: 0,
      callId: CallId('c1'),
      name: 'read_file',
      arguments: '{"path":"x"}',
    })
    session.append(
      'tool/result',
      {
        turn: 0,
        step: 0,
        message: createToolResultMessage({
          callId: CallId('c1'),
          content: [{ type: 'text', text: `the file said ${SECRET}` }],
          isError: false,
        }),
      },
      { surfaceOp: 'append' },
    )
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })

    const { repo, close } = await reader(dataDir)
    try {
      const turn = await waitFor(async () => {
        const found = await repo.getTurn('s-e2e:turn:0')
        return found?.status === 'completed' ? found : undefined
      })
      expect(turn).toBeDefined()
      expect(turn).toMatchObject({
        id: 's-e2e:turn:0',
        sessionId: 's-e2e',
        ordinal: 0,
        status: 'completed',
        activityCount: 5,
        errorCount: 0,
      })
      expect(turn?.endedAt).toBeGreaterThanOrEqual(turn?.startedAt ?? 0)

      const activities = await repo.getActivities('s-e2e:turn:0')
      expect(activities.map(activity => activity.kind)).toEqual([
        'turn',
        'model',
        'tool',
        'tool',
        'turn',
      ])
      expect(activities.map(activity => activity.seq)).toEqual([0, 1, 2, 3, 4])
      expect(activities.map(activity => activity.phase)).toEqual([
        'started',
        'started',
        'started',
        'completed',
        'completed',
      ])

      // The tool result's payload lives in the object store, redacted.
      const result = activities[3]
      expect(result?.label).toBe('Tool: c1')
      expect(result?.payloadRef).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect('truncated' in (result ?? {})).toBe(false)
      expect(JSON.stringify(activities)).not.toContain(SECRET)

      const record = await repo.statObject(result?.payloadRef ?? '')
      expect(record?.kind).toBe('activity-payload')

      // Two objects, because the turn stores two payloads: the tool result's
      // text, and the tool call's `arguments` taken verbatim (normalize never
      // parses that string, so it is the call's payload rather than a label
      // input). Both are redacted before either reaches the store — the
      // assertion above checks the result's bytes, and the assembler suite
      // checks the secret is absent from everything the recorder emits.
      const refs = await repo.referencedRefs()
      expect(refs).toHaveLength(2)
      expect(refs).toContain(result?.payloadRef)
      expect(JSON.stringify(await repo.storageUsage())).toMatch(/"objectCount":2/)
    } finally {
      await close()
    }
  })

  it('stays loaded and inert when its data directory cannot be written', async () => {
    const base = await tempRoot()
    const dataDir = join(base, 'locked')
    await mkdir(dataDir, { mode: 0o500 })
    locked.push(dataDir)

    const { ctx, fiber } = await mount(dataDir)
    const session = ctx.sessions.create(SessionId('s-locked'), { meta: { cwd: base } })

    // The harness keeps working: losing recording never blocks the agent.
    expect(() => {
      session.append('turn/start', { turn: 0 })
      session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    }).not.toThrow()
    expect(session.seq).toBe(2)

    await settle()
    expect(existsSync(resolveIndexPath(dataDir))).toBe(false)
    await fiber.dispose()
  })

  it('refuses a foreign index and leaves its bytes untouched', async () => {
    const dataDir = await tempRoot()
    const dbPath = resolveIndexPath(dataDir)
    const foreign = Buffer.from('this is not a turnscope index')
    await writeFile(dbPath, foreign)

    const { ctx, fiber } = await mount(dataDir)
    const session = ctx.sessions.create(SessionId('s-foreign'), { meta: { cwd: dataDir } })
    expect(() => {
      session.append('turn/start', { turn: 0 })
    }).not.toThrow()

    await settle()
    expect(await readFile(dbPath)).toEqual(foreign)
    await fiber.dispose()
  })
})
