/**
 * The host API's read side, over a real index.
 *
 * A real repository rather than a stub, because the interesting parts of this
 * service are the two grouped statements behind the turn list and the workspace
 * lookup behind a refresh — a hand-written fake would agree with whatever the
 * service assumed and prove nothing about either. The inspector is faked,
 * because what this file is testing is the *call* into it, not the work inside.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  EvaluateSafetyRequest,
  GetTurnDetailRequest,
  ListTurnsData,
  ListTurnsRequest,
  TurnDetailData,
} from '../../../src/shared/contracts/api.ts'
import { API_VERSION, TURN_PAGE_LIMIT, lookup, readReply } from '../../../src/shared/contracts/api.ts'
import type { TurnscopeLookupReply } from '../../../src/shared/contracts/api.ts'
import { SCHEMA_VERSION } from '../../../src/host/domain/types.ts'
import type {
  CommandRecord,
  SafetyVerdict,
  TestRecord,
  WorkspaceRecord,
} from '../../../src/host/domain/types.ts'
import type { TurnInspector, TurnWorkspace } from '../../../src/host/inspection/types.ts'
import { createQueryService } from '../../../src/host/query/service.ts'
import { createRepository } from '../../../src/host/storage/repository.ts'
import type { TraceRepository } from '../../../src/host/storage/repository.ts'
import { openIndex } from '../../../src/host/storage/sqlite-index.ts'
import { change, turnRecord } from '../safety/support.ts'

/** The base every request carries; a test says only what it actually varies. */
const base = { apiVersion: API_VERSION } as const

/** The turn the fixture seeds first, and the one every record below belongs to. */
const TURN = 's-1:turn:0'

/**
 * A change on a named turn.
 *
 * The shared builder defaults to its own turn id, but ids here are per turn and
 * a change filed under the wrong one would be silently invisible to every query
 * in this file — the kind of mistake that makes a test pass for the wrong
 * reason.
 */
/**
 * The payload of a lookup the test expects to have found something.
 *
 * Asserting here rather than reaching through `data!` keeps the null case a
 * failing assertion with a readable message instead of a `TypeError` three lines
 * later that says only that reading a property of `null` failed.
 */
const found = <T>(reply: TurnscopeLookupReply<T>): T => {
  expect(reply.data).not.toBeNull()
  return reply.data as T
}

const changeOn = (turnId: string, path: string) =>
  change({ turnId, id: `${turnId}:chg:${path}`, path })

const verdictOn = (turnId: string, level: SafetyVerdict['level'], evaluatedAt: number) => ({
  ...verdict(level, evaluatedAt),
  id: `${turnId}:safety:${evaluatedAt}`,
  turnId,
})

const workspaceRecord = (): WorkspaceRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id: 'ws-1',
  repoRoot: '/repo',
  repoRootHash: 'a'.repeat(64),
  settingsJson: '{}',
  createdAt: 1_700_000_000_000,
})

const commandRecord = (id: string, turnId: string): CommandRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id,
  turnId,
  activityId: 's-1:act:1',
  command: 'pnpm test',
  exitCode: 0,
  durationMs: 1_000,
})

const testRecord = (id: string, turnId: string): TestRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id,
  turnId,
  commandId: 's-1:cmd:1',
  kind: 'test',
  status: 'passed',
  summary: 'auth suite: 12 passed',
})

const verdict = (level: SafetyVerdict['level'], evaluatedAt: number): SafetyVerdict => ({
  schemaVersion: SCHEMA_VERSION,
  id: 'placeholder',
  turnId: TURN,
  level,
  reasons: [],
  allowedActions: ['INSPECT'],
  recommendedAction: 'INSPECT',
  evaluatedAt,
  engineVersion: 1,
})

describe('createQueryService', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  /**
   * A real index plus a recorded-inspector double.
   *
   * The double records how it was called rather than doing anything, so a test
   * about `evaluateSafety` can assert on the workspace it was handed — the part
   * of that method which is real logic and would otherwise be invisible.
   */
  const fixture = async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'turnscope-query-'))
    cleanups.push(async () => rm(dataRoot, { recursive: true, force: true }))
    const handle = await openIndex(join(dataRoot, 'index.sqlite3'))
    const repo: TraceRepository = createRepository(handle)
    cleanups.push(async () => repo.close())

    const refreshCalls: Array<{ turnId: string; workspace: TurnWorkspace }> = []
    const inspector: TurnInspector = {
      observe: async () => undefined,
      inspect: async () => undefined,
      refresh: async (turn, workspace) => {
        refreshCalls.push({ turnId: turn.id, workspace })
        return {
          turnId: turn.id,
          changeSet: undefined,
          verdict: verdict('CAUTION', 1_700_000_099_000),
          current: undefined as never,
          pre: undefined,
          post: undefined,
        }
      },
      latestVerdict: async () => undefined,
    }

    return {
      repo,
      refreshCalls,
      service: createQueryService({ sink: repo, inspector }),
      /** Record a session's worth of turns, newest ordinal last. */
      seed: async (count: number) => {
        await repo.upsertWorkspace(workspaceRecord())
        for (let ordinal = 0; ordinal < count; ordinal += 1) {
          await repo.upsertTurn(
            turnRecord({ id: `s-1:turn:${ordinal}`, ordinal, sessionId: 's-1' }),
          )
        }
      },
    }
  }

  describe('listTurns', () => {
    it('answers an empty session with an empty page rather than nothing', async () => {
      const f = await fixture()

      const reply = await f.service.listTurns({ ...base, sessionId: 's-1', limit: 10 })

      // A session that exists and has no turns is a normal state, so it has to
      // be distinguishable from a failure: an empty list, not an absent reply.
      expect(reply.data).toEqual({ turns: [] })
      expect(reply.apiVersion).toBe(API_VERSION)
    })

    it('summarizes each turn with its change count and latest verdict', async () => {
      const f = await fixture()
      await f.seed(2)
      await f.repo.putFileChange(changeOn('s-1:turn:1', 'src/auth.ts'))
      await f.repo.putFileChange(changeOn('s-1:turn:1', 'src/db.ts'))
      await f.repo.putSafetyVerdict(verdictOn('s-1:turn:1', 'FORK_ONLY', 1_700_000_050_000))

      const reply = await f.service.listTurns({ ...base, sessionId: 's-1', limit: 10 })

      expect(reply.data.turns).toHaveLength(2)
      // Newest first, and only the turn that has them carries counts.
      const [newest, oldest] = reply.data.turns
      expect(newest?.turnId).toBe('s-1:turn:1')
      expect(newest?.changeCount).toBe(2)
      expect(newest?.safety).toEqual({
        level: 'FORK_ONLY',
        recommendedAction: 'INSPECT',
        evaluatedAt: 1_700_000_050_000,
      })
      // No verdict is not the same as a `SAFE` verdict, and the absence has to
      // survive the wire rather than defaulting to the reassuring answer.
      expect(oldest?.changeCount).toBe(0)
      expect(oldest?.safety).toBeUndefined()
      expect(oldest?.evidenceCompleteness).toBe('complete')
    })

    it('reports the freshest verdict when a turn has been judged more than once', async () => {
      const f = await fixture()
      await f.seed(1)
      // `§16` says a verdict is about now, so re-evaluating replaces it. Two
      // rows exist; the newer is the one a list must show, and the bulk lookup
      // has to agree with the single-turn lookup about which that is.
      await f.repo.putSafetyVerdict(verdictOn(TURN, 'SAFE', 1_700_000_050_000))
      // A second judgement of the same turn, which is what a re-evaluation
      // produces: `§16` forbids reusing the first, so both rows exist.
      await f.repo.putSafetyVerdict(verdictOn(TURN, 'FORK_ONLY', 1_700_000_060_000))

      const reply = await f.service.listTurns({ ...base, sessionId: 's-1', limit: 10 })

      expect(reply.data.turns[0]?.safety?.level).toBe('FORK_ONLY')
      expect((await f.repo.getLatestVerdict(TURN))?.level).toBe('FORK_ONLY')
    })

    it('pages with a cursor and stops advertising one at the end', async () => {
      const f = await fixture()
      await f.seed(3)

      const first = await f.service.listTurns({ ...base, sessionId: 's-1', limit: 2 })
      expect(first.data.turns.map(turn => turn.turnId)).toEqual(['s-1:turn:2', 's-1:turn:1'])
      expect(first.data.nextCursor).toBe(1)

      const second = await f.service.listTurns({
        ...base,
        sessionId: 's-1',
        limit: 2,
        cursor: first.data.nextCursor as number,
      })
      expect(second.data.turns.map(turn => turn.turnId)).toEqual(['s-1:turn:0'])
      // Absence, not a sentinel: a client that keeps paging on a `0` cursor
      // would read the whole session forever.
      expect(second.data.nextCursor).toBeUndefined()
    })

    it('clamps a limit that arrived from a browser', async () => {
      const f = await fixture()
      await f.seed(3)

      // A `limit` in a request is user input. `Math.min` is the whole defence
      // and it has to hold for the cases a UI would never send but a hand-rolled
      // call would: zero, negative, fractional, `NaN`, and absurd.
      const sizes = [
        { requested: 0, expected: 1 },
        { requested: -5, expected: 1 },
        { requested: 2.9, expected: 2 },
        { requested: Number.NaN, expected: TURN_PAGE_LIMIT.default },
        { requested: 1e9, expected: TURN_PAGE_LIMIT.max },
      ]
      for (const { requested, expected } of sizes) {
        const reply = await f.service.listTurns({ ...base, sessionId: 's-1', limit: requested })
        expect(reply.data.turns.length).toBe(Math.min(expected, 3))
      }
    })
  })

  describe('getTurnDetail', () => {
    it('returns the summary alongside the evidence it was counted from', async () => {
      const f = await fixture()
      await f.seed(1)
      await f.repo.putFileChange(changeOn(TURN, 'src/auth.ts'))
      await f.repo.putCommand(commandRecord('s-1:cmd:1', TURN))
      await f.repo.putTest(testRecord('s-1:test:1', TURN))
      await f.repo.putSafetyVerdict(verdictOn(TURN, 'CAUTION', 1_700_000_050_000))

      const reply = await f.service.getTurnDetail({
        ...base,
        turnId: 's-1:turn:0',
      } satisfies GetTurnDetailRequest)
      const data = found(reply)

      expect(data.summary.turnId).toBe(TURN)
      // The same count the list reports, computed the same way, so a detail
      // view opened from a row cannot contradict the row.
      expect(data.summary.changeCount).toBe(1)
      expect(data.changes.map(c => c.path)).toEqual(['src/auth.ts'])
      expect(data.commands.map(c => c.command)).toEqual(['pnpm test'])
      expect(data.tests.map(t => t.summary)).toEqual(['auth suite: 12 passed'])
      // The full verdict, reasons included: this is the screen that renders them.
      expect(data.safety?.level).toBe('CAUTION')
    })

    it('says there is no such turn rather than failing to answer', async () => {
      const f = await fixture()

      const reply = await f.service.getTurnDetail({ ...base, turnId: 's-1:turn:99' })

      // `null` and not an absent reply: the host answered, and the answer is
      // that the turn is not there. A version mismatch is the other case, and
      // the two are told apart by `readReply` naming them separately.
      expect(reply.data).toBeNull()
      expect(reply.apiVersion).toBe(API_VERSION)
    })
  })

  describe('evaluateSafety', () => {
    it('refreshes against the workspace the turn was recorded in', async () => {
      const f = await fixture()
      await f.seed(1)

      const reply = await f.service.evaluateSafety({
        ...base,
        turnId: 's-1:turn:0',
      } satisfies EvaluateSafetyRequest)

      // The repository root is looked up rather than carried in the request: a
      // client that could name the tree to observe could ask us to judge the
      // wrong one, and the workspace record is the only authority on it.
      expect(f.refreshCalls).toEqual([
        { turnId: 's-1:turn:0', workspace: { workspaceId: 'ws-1', repoRoot: '/repo' } },
      ])
      expect(found(reply).verdict.level).toBe('CAUTION')
      expect(found(reply).changeCount).toBe(0)
    })

    it('refuses to judge a turn whose workspace is gone', async () => {
      const f = await fixture()
      // Deliberately no `upsertWorkspace`: this is a turn whose workspace row
      // was pruned or never written, and there is no tree to observe. Guessing
      // one would mean judging against whoever happens to be in that directory.
      await f.repo.upsertTurn(turnRecord({ id: 's-1:turn:0', ordinal: 0 }))

      const reply = await f.service.evaluateSafety({ ...base, turnId: 's-1:turn:0' })

      expect(reply.data).toBeNull()
      expect(f.refreshCalls).toEqual([])
    })

    it('refuses to judge a turn that does not exist', async () => {
      const f = await fixture()
      await f.seed(1)

      const reply = await f.service.evaluateSafety({ ...base, turnId: 's-1:turn:99' })

      expect(reply.data).toBeNull()
      expect(f.refreshCalls).toEqual([])
    })
  })

  describe('lookup', () => {
    it('maps a missing result onto the wire null', () => {
      // The gateway rejects `undefined` as a business result, so a lookup that
      // finds nothing has to say so rather than omit the field.
      expect(lookup<string>(undefined)).toEqual({ apiVersion: API_VERSION, data: null })
      expect(lookup('a').data).toBe('a')
    })
  })

  describe('readReply', () => {
    it('reads a reply from this version', async () => {
      const f = await fixture()
      const reply = await f.service.listTurns({
        ...base,
        sessionId: 's-1',
        limit: 10,
      } satisfies ListTurnsRequest)

      expect(readReply<ListTurnsData>(reply)).toEqual({ kind: 'value', value: reply.data })
    })

    it('refuses a reply from another version instead of reading its fields', async () => {
      const f = await fixture()
      const reply = await f.service.listTurns({ ...base, sessionId: 's-1', limit: 10 })

      // The failure this exists for: a browser bundle older than the host. The
      // shapes may well still line up, which is exactly why the version has to
      // be checked rather than hoped about.
      const mismatch = readReply({ ...reply, apiVersion: API_VERSION + 1 })
      expect(mismatch.kind).toBe('unusable')
      expect(mismatch.kind === 'unusable' && mismatch.detail).toContain(String(API_VERSION))
      expect(readReply(null).kind).toBe('unusable')
      expect(readReply('CAUTION').kind).toBe('unusable')
    })

    it('tells "the host says there is nothing" apart from "there is no answer"', async () => {
      const f = await fixture()
      await f.seed(1)
      const missing = await f.service.getTurnDetail({ ...base, turnId: 's-1:turn:99' })
      const present = await f.service.getTurnDetail({ ...base, turnId: 's-1:turn:0' })

      // Both readings a UI could get wrong, in one place: a `null` data is an
      // answer, an absent field is a broken reply, and collapsing them would
      // report a version mismatch as a confidently empty screen.
      expect(readReply(missing)).toEqual({ kind: 'absent' })
      expect(readReply<TurnDetailData>(present).kind).toBe('value')
      expect(readReply({ apiVersion: API_VERSION })).toEqual({
        kind: 'unusable',
        detail: 'the host reply carries no data',
      })
    })
  })
})
