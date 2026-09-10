import { mkdir, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DIRECTORY_MODE, FILE_MODE } from './atomic.ts'
import { MIGRATIONS, SCHEMA_VERSION, TRACESCOPE_APPLICATION_ID } from './schema.ts'

/**
 * An open index, and the only thing in the process that holds a `node:sqlite`
 * handle. Everything above this module reaches the database through
 * {@link TraceRepository}.
 */
export interface IndexHandle {
  /** The raw connection, for migrations and for tests that need SQL directly. */
  readonly db: DatabaseSync
  /** Bring the file up to {@link SCHEMA_VERSION}. A no-op when it already is. */
  migrate(): void
  /** Close the connection. Idempotent, so lifecycle cleanup cannot double-fail. */
  close(): void
}

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
async function createExclusively(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE })

  let handle: FileHandle | undefined
  try {
    handle = await open(path, 'wx', FILE_MODE)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    await handle?.close()
  }
}

/**
 * Read a numeric PRAGMA. This is the first statement run against a freshly
 * opened file, so it is also how a file that is not a database at all is
 * detected: SQLite opens lazily and only reports `file is not a database` once
 * something is actually read.
 */
function pragmaInteger(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get()
  const value = row === undefined ? undefined : Object.values(row)[0]
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`PRAGMA ${name} returned ${String(value)} rather than a number`)
  }
  return Number(value)
}

/** Whether the file holds tables of its own, i.e. does more than host us. */
function hasUserTables(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .get()
  const value = row === undefined ? undefined : row['n']
  return typeof value === 'number' ? value > 0 : typeof value === 'bigint' && value > 0n
}

/** Close without letting a teardown failure mask the error being reported. */
function closeQuietly(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    // Nothing useful can be done with a failure to close a handle we are
    // abandoning; the caller's error is the one worth surfacing.
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

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
export async function openIndex(dbPath: string): Promise<IndexHandle> {
  await createExclusively(dbPath)

  // Loaded on demand so the experimental built-in is only pulled in when an
  // index is actually opened, and so the sync driver stays behind this seam.
  const { DatabaseSync: Sqlite } = await import('node:sqlite')

  let db: DatabaseSync
  try {
    db = new Sqlite(dbPath)
  } catch (error) {
    throw new Error(`${dbPath} is not a usable SQLite database: ${describe(error)}`)
  }

  let applicationId: number
  let userVersion: number
  try {
    applicationId = pragmaInteger(db, 'application_id')
    userVersion = pragmaInteger(db, 'user_version')
  } catch (error) {
    closeQuietly(db)
    throw new Error(`${dbPath} is not a SQLite database: ${describe(error)}`)
  }

  if (applicationId !== 0 && applicationId !== TRACESCOPE_APPLICATION_ID) {
    closeQuietly(db)
    throw new Error(
      `${dbPath} belongs to another application (application_id ${applicationId}, ` +
        `expected ${TRACESCOPE_APPLICATION_ID}); Turnscope will not read or write it`,
    )
  }

  if (applicationId === 0 && hasUserTables(db)) {
    closeQuietly(db)
    throw new Error(
      `${dbPath} already contains tables and carries no Turnscope application id; ` +
        `refusing to adopt a database that belongs to another application`,
    )
  }

  if (userVersion > SCHEMA_VERSION) {
    closeQuietly(db)
    throw new Error(
      `${dbPath} was written by a newer version of Turnscope ` +
        `(schema ${userVersion}; this build understands ${SCHEMA_VERSION})`,
    )
  }

  db.exec(`PRAGMA application_id = ${TRACESCOPE_APPLICATION_ID}`)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')

  let closed = false
  const close = (): void => {
    // Closing is a lifecycle obligation, not a command: a second call — from an
    // `afterEach`, from a shutdown hook, from both — must not throw.
    if (closed) return
    closed = true
    db.close()
  }

  const migrate = (): void => {
    const current = pragmaInteger(db, 'user_version')
    if (current >= SCHEMA_VERSION) return

    // One transaction for the whole upgrade, so an interrupted migration leaves
    // `user_version` at its old value and the next open retries from there.
    // `IMMEDIATE` takes the write lock up front rather than discovering a
    // competing writer after the work is done.
    db.exec('BEGIN IMMEDIATE')
    try {
      for (let version = current; version < SCHEMA_VERSION; version += 1) {
        const migration = MIGRATIONS[version]
        if (migration === undefined) {
          throw new Error(`no migration from schema version ${version} to ${version + 1}`)
        }
        db.exec(migration)
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // SQLite may already have unwound the transaction on a failed statement;
        // the migration error is the one that explains what happened.
      }
      throw error
    }
  }

  migrate()

  return { db, migrate, close }
}
