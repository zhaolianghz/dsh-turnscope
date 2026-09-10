import type { DatabaseSync } from 'node:sqlite';
/**
 * An open index, and the only thing in the process that holds a `node:sqlite`
 * handle. Everything above this module reaches the database through
 * {@link TraceRepository}.
 */
export interface IndexHandle {
    /** The raw connection, for migrations and for tests that need SQL directly. */
    readonly db: DatabaseSync;
    /** Bring the file up to {@link SCHEMA_VERSION}. A no-op when it already is. */
    migrate(): void;
    /** Close the connection. Idempotent, so lifecycle cleanup cannot double-fail. */
    close(): void;
}
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
export declare function openIndex(dbPath: string): Promise<IndexHandle>;
//# sourceMappingURL=sqlite-index.d.ts.map