/**
 * Schema 2 is reached by migrating a schema 1 file, not by recreating it.
 *
 * The v1 schema was never published, so there is no user data in the world that
 * this protects. It is tested anyway, for a reason that outlives that fact: the
 * migration machinery is the thing every future release depends on, and a
 * version bump whose upgrade path has never once been executed is a version bump
 * that does not work. These tests are the only execution it gets.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '../../src/host/domain/types.ts'
import { MIGRATIONS, TRACESCOPE_APPLICATION_ID } from '../../src/host/storage/schema.ts'
import { openIndex } from '../../src/host/storage/sqlite-index.ts'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function scratchPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'turnscope-migration-'))
  created.push(dir)
  return join(dir, 'index.sqlite3')
}

/**
 * Build a genuine schema-1 file: the schema-1 DDL, our application id, and
 * `user_version = 1`. Deliberately not produced by calling `openIndex`, which
 * would migrate it on the way out and leave nothing to test.
 */
async function writeV1File(path: string): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA application_id = ${TRACESCOPE_APPLICATION_ID}`)
  db.exec(MIGRATIONS[0] ?? '')
  db.exec('PRAGMA user_version = 1')
  db.exec(
    `INSERT INTO turns (id, session_id, ordinal, status, started_at, ended_at,
                        activity_count, error_count, pre_checkpoint_id, post_checkpoint_id)
     VALUES ('s-1:turn:0', 's-1', 0, 'completed', 1000, 2000, 3, 1, NULL, NULL)`,
  )
  db.close()
}

const columnNames = (db: { prepare(sql: string): { all(): unknown[] } }, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name)

describe('schema 1 to schema 2', () => {
  it('upgrades a v1 file in place and records the new version', async () => {
    const path = await scratchPath()
    await writeV1File(path)

    const handle = await openIndex(path)
    try {
      const version = handle.db.prepare('PRAGMA user_version').get() as { user_version: number }
      expect(version.user_version).toBe(SCHEMA_VERSION)
      expect(SCHEMA_VERSION).toBe(2)
    } finally {
      handle.close()
    }
  })

  it('keeps the rows that were already there, defaulting the new columns honestly', async () => {
    const path = await scratchPath()
    await writeV1File(path)

    const handle = await openIndex(path)
    try {
      const row = handle.db.prepare('SELECT * FROM turns WHERE id = ?').get('s-1:turn:0') as Record<
        string,
        unknown
      >
      // The old data is untouched...
      expect(row['status']).toBe('completed')
      expect(row['activity_count']).toBe(3)
      // ...and the new columns say what is actually true about a turn recorded
      // before the workspace was ever observed: no workspace, no evidence.
      // `complete` here would be the migration claiming evidence it never had.
      expect(row['workspace_id']).toBe('')
      expect(row['evidence_completeness']).toBe('missing')
    } finally {
      handle.close()
    }
  })

  it('adds every schema-2 table and column', async () => {
    const path = await scratchPath()
    await writeV1File(path)

    const handle = await openIndex(path)
    try {
      const tables = (
        handle.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map(row => row.name)
      expect(tables).toEqual(
        expect.arrayContaining([
          'checkpoint_paths',
          'file_changes',
          'commands',
          'tests',
          'safety_verdicts',
        ]),
      )

      expect(columnNames(handle.db, 'turns')).toEqual(
        expect.arrayContaining(['workspace_id', 'evidence_completeness']),
      )
      expect(columnNames(handle.db, 'checkpoints')).toEqual(
        expect.arrayContaining([
          'merge_in_progress',
          'rebase_in_progress',
          'cherry_pick_in_progress',
          'completeness',
        ]),
      )
    } finally {
      handle.close()
    }
  })

  it('is idempotent: reopening a migrated file changes nothing', async () => {
    const path = await scratchPath()
    await writeV1File(path)

    const first = await openIndex(path)
    const afterFirst = columnNames(first.db, 'turns')
    first.close()

    const second = await openIndex(path)
    try {
      expect(columnNames(second.db, 'turns')).toEqual(afterFirst)
      const row = second.db.prepare('SELECT * FROM turns WHERE id = ?').get('s-1:turn:0') as Record<
        string,
        unknown
      >
      expect(row['activity_count']).toBe(3)
    } finally {
      second.close()
    }
  })

  it('still refuses a file written by a newer schema', async () => {
    const path = await scratchPath()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    db.exec(`PRAGMA application_id = ${TRACESCOPE_APPLICATION_ID}`)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    db.close()

    await expect(openIndex(path)).rejects.toThrow(/newer version of Turnscope/)
  })
})
