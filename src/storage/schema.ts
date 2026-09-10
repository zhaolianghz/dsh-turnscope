/**
 * The on-disk schema of the plugin-private SQLite index.
 *
 * Everything the plugin can read back is declared here, once. Two values make
 * the file self-identifying so an unrelated SQLite database can never be
 * mistaken for ours: {@link TRACESCOPE_APPLICATION_ID} in the header, and
 * {@link SCHEMA_VERSION} in `user_version`.
 */

import { SCHEMA_VERSION } from '../domain/types.ts'

export { SCHEMA_VERSION }

/**
 * Header `application_id` of a Turnscope index.
 *
 * A random-looking constant, not a sequence number: its whole job is to be
 * unlikely to collide with any other application's, so a foreign file is
 * recognised as foreign rather than adopted.
 */
export const TRACESCOPE_APPLICATION_ID = 1414035280

/**
 * Every table, with the indexes the read paths need.
 *
 * Tables are `STRICT` and timestamps are `INTEGER` epoch milliseconds, per
 * `docs/ARCHITECTURE.md §4.1`. The columns correspond one-to-one with the Task 2
 * records, except that a record's `schemaVersion` is not stored: it is the
 * constant `SCHEMA_VERSION` of the file that holds the row, so a column would
 * only duplicate the header.
 *
 * There is deliberately no `checkpoints.tree_ref`. `docs/ARCHITECTURE.md §4.1`
 * lists one, but this slice performs zero Git writes and therefore never creates
 * a tree object to reference; a column nothing can populate is a liability, not
 * a convenience. A later Restore/Fork plan that needs it adds it with the
 * migration this versioned schema exists for.
 *
 * Note also that there are no `REFERENCES` clauses. Writes arrive from a report
 * path that batches records per event, so a child row can legitimately be
 * written before its parent; enforcing the graph here would turn a tolerable
 * ordering into a lost record. `foreign_keys` is still enabled so that any
 * constraint a later migration adds is honoured immediately.
 */
const SCHEMA_V1 = `
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
`

/**
 * Ordered migrations: `MIGRATIONS[n]` upgrades a database from `user_version`
 * `n` to `n + 1`, so applying every entry from the file's current version takes
 * it to {@link SCHEMA_VERSION}.
 *
 * Each entry is idempotent with respect to a version, never re-run, and applied
 * inside one `BEGIN IMMEDIATE` transaction, so a failure part-way through leaves
 * `user_version` — and therefore the schema — exactly where it started.
 */
export const MIGRATIONS: readonly string[] = Object.freeze([SCHEMA_V1])
