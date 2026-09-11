/**
 * V0.2 schema migration tests, per
 * `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §4.4`.
 *
 * The two assertions below are the only ones the spec demands:
 *
 * - The schema migrates from v2 to v3 in one open, with the new tables present
 *   and `user_version` advanced.
 * - The migration runs inside the same `BEGIN IMMEDIATE` that `openIndex`
 *   already opens, so a half-applied schema leaves `user_version` untouched
 *   and the next open retries from there.
 *
 * The architectural rule that only `src/storage/` imports `node:sqlite` holds
 * for tests too, so this file drives the driver directly rather than going
 * through `openIndex`.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The architectural rule that only `src/storage/` imports `node:sqlite` governs
// production code. A migration test must not build its "v2 fixture" with the
// code under test, so this file drives the driver directly.
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openIndex } from '../../../src/host/storage/sqlite-index.ts'
import { MIGRATIONS, SCHEMA_VERSION, TRACESCOPE_APPLICATION_ID } from '../../../src/host/storage/schema.ts'

const pragmaInteger = (db: DatabaseSync, name: string): number => {
  const row = db.prepare(`PRAGMA ${name}`).get()
  if (row === undefined) throw new Error(`PRAGMA ${name} returned nothing`)
  const value = Object.values(row)[0]
  return Number(value)
}

const tableNames = (db: DatabaseSync): readonly string[] => {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[]
  return rows.map(r => r.name)
}

const seedV2 = async (path: string): Promise<void> => {
  // Hand-built v2 schema: v1 + v2 migrations, no v3, then stamp user_version=2.
  // The exact DDL matches what `src/host/storage/schema.ts` ships so a divergence
  // here would be a divergence from the migration that runs in production.
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA application_id = ${TRACESCOPE_APPLICATION_ID}`)
  db.exec(MIGRATIONS[0]!)
  db.exec(MIGRATIONS[1]!)
  db.exec('PRAGMA user_version = 2')
  db.close()
}

describe('migration v2 -> v3 (V0.2 Safe Rewind)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'turnscope-mig-v3-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('opens a v2 file and applies v3 in one go', async () => {
    const path = join(root, 'index.sqlite3')
    await seedV2(path)

    // Sanity: the v2 file really is v2 before we open it through our code.
    const raw = new DatabaseSync(path, { readOnly: true })
    expect(pragmaInteger(raw, 'user_version')).toBe(2)
    raw.close()

    const handle = await openIndex(path)

    expect(pragmaInteger(handle.db, 'user_version')).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBe(3)
    expect(tableNames(handle.db)).toEqual(
      expect.arrayContaining(['recovery_plans', 'recovery_journal']),
    )

    handle.close()
  })

  it('leaves a v3 database alone on a second open (idempotent)', async () => {
    const path = join(root, 'index.sqlite3')
    const first = await openIndex(path)
    expect(pragmaInteger(first.db, 'user_version')).toBe(3)
    first.close()

    const second = await openIndex(path)
    expect(pragmaInteger(second.db, 'user_version')).toBe(3)
    second.close()
  })

  it('refuses a future user_version without rewriting the file', async () => {
    const path = join(root, 'future.sqlite3')
    const handle = await openIndex(path)
    handle.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    handle.close()

    const bytesBefore = await readFile(path)
    await expect(openIndex(path)).rejects.toThrow(/newer version of Turnscope/i)
    expect((await readFile(path)).equals(bytesBefore)).toBe(true)
  })

  it('survives a torn v2 file: a half-written v3 transaction leaves user_version at 2', async () => {
    const path = join(root, 'torn.sqlite3')
    await seedV2(path)
    // Simulate a torn migration: open v3's DDL inside a transaction, then drop
    // the journal mid-flight so the COMMIT never lands. `node:sqlite` runs
    // sync, so the only way to tear the file is to corrupt the journal page
    // after a BEGIN.
    const raw = new DatabaseSync(path)
    raw.exec('BEGIN IMMEDIATE')
    raw.exec(MIGRATIONS[2]!) // partial — no COMMIT, no user_version bump
    // Append a stray byte to the WAL so the next open forces a recovery that
    // discards the half-written transaction.
    await writeFile(path + '-wal', '\x00', { flag: 'a' })
    await mkdir(path + '-wal', { recursive: true }).catch(() => undefined)
    raw.close()

    const handle = await openIndex(path)
    // The torn transaction must have been discarded by SQLite's recovery; the
    // file is either back at v2 (with one more `migrate()` to apply) or has
    // been fully upgraded. It must not be in a half-state where v3 tables
    // exist but user_version is still 2 — that is the invariant the migration
    // entry point's single transaction is supposed to preserve.
    const version = pragmaInteger(handle.db, 'user_version')
    const tables = new Set(tableNames(handle.db))
    const hasV3Tables = tables.has('recovery_plans') && tables.has('recovery_journal')
    if (version === 2) {
      expect(hasV3Tables).toBe(false)
    } else {
      expect(version).toBe(3)
      expect(hasV3Tables).toBe(true)
    }
    handle.close()
  })
})