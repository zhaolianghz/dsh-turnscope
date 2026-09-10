/**
 * The on-disk schema of the plugin-private SQLite index.
 *
 * Everything the plugin can read back is declared here, once. Two values make
 * the file self-identifying so an unrelated SQLite database can never be
 * mistaken for ours: {@link TRACESCOPE_APPLICATION_ID} in the header, and
 * {@link SCHEMA_VERSION} in `user_version`.
 */
import { SCHEMA_VERSION } from '../domain/types.ts';
export { SCHEMA_VERSION };
/**
 * Header `application_id` of a Turnscope index.
 *
 * A random-looking constant, not a sequence number: its whole job is to be
 * unlikely to collide with any other application's, so a foreign file is
 * recognised as foreign rather than adopted.
 */
export declare const TRACESCOPE_APPLICATION_ID = 1414035280;
/**
 * Ordered migrations: `MIGRATIONS[n]` upgrades a database from `user_version`
 * `n` to `n + 1`, so applying every entry from the file's current version takes
 * it to {@link SCHEMA_VERSION}.
 *
 * Each entry is idempotent with respect to a version, never re-run, and applied
 * inside one `BEGIN IMMEDIATE` transaction, so a failure part-way through leaves
 * `user_version` — and therefore the schema — exactly where it started.
 */
export declare const MIGRATIONS: readonly string[];
//# sourceMappingURL=schema.d.ts.map