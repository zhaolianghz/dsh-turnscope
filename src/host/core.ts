import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { TurnscopeConfig } from '../config.ts'
import type { Diagnostics } from '../diagnostics.ts'
import { SCHEMA_VERSION } from './domain/types.ts'
import { transitionTurn } from './domain/turn-state.ts'
import type { TurnRecord } from './domain/types.ts'
import { subscribeSessionEvents } from './adapters/dsh/subscribe.ts'
import { createTurnAssembler } from './adapters/dsh/assembler.ts'
import { normalizeEvent } from './adapters/dsh/normalize.ts'
import type { NormalizedActivity, RawSessionEvent } from './adapters/dsh/normalize.ts'
import { OBJECT_KINDS, createObjectStore } from './storage/object-store.ts'
import type { ObjectStore } from './storage/object-store.ts'
import { resolveDataRoot } from './storage/paths.ts'
import { openIndex } from './storage/sqlite-index.ts'
import { createRepository } from './storage/repository.ts'
import type { TraceRepository } from './storage/repository.ts'
import { createExecFileRunner } from './git/command-runner.ts'
import { createGitPort } from './git/git-port.ts'
import { resolveRepositoryIdentity } from './git/identity.ts'

/** Index file name under the plugin's private data root, per `docs/ARCHITECTURE.md §4.2`. */
export const INDEX_FILENAME = 'index.sqlite3'

/** The plugin-private index path for an already-resolved data root. */
export function resolveIndexPath(dataRoot: string): string {
  return join(dataRoot, INDEX_FILENAME)
}

/** The part of a session the recorder needs; the harness `Session` satisfies it. */
export interface SessionIdentity {
  readonly id: string
  /** Absolute working directory the session was created in, when it recorded one. */
  readonly cwd: string | undefined
}

/**
 * The slice of {@link TraceRepository} the recorder writes through.
 *
 * Narrow on purpose: the recorder is the only writer, and a test can stand in
 * for a repository with four methods instead of sixteen.
 */
export type TraceSink = Pick<
  TraceRepository,
  'getTurn' | 'upsertTurn' | 'appendActivity' | 'putObjectRecord'
>

/** What the recorder needs from its environment. */
export interface RecorderOptions {
  readonly config: TurnscopeConfig
  readonly sink: TraceSink
  readonly store: ObjectStore
  readonly diagnostics: Diagnostics
  /**
   * Resolve the workspace a session's `cwd` belongs to.
   *
   * Injected rather than built in because resolving a real repository identity
   * spawns Git, and the recorder is unit-tested without a repository. Omitted,
   * it falls back to the opaque cwd hash below — which is the honest answer when
   * the working directory is not a repository, and is also what the resolver
   * itself falls back to. It is never allowed to throw: see
   * {@link createRecorder}.
   */
  readonly resolveWorkspaceId?: (cwd: string | undefined) => Promise<string>
}

/** Accepts events and persists the records they imply. */
export interface Recorder {
  /** Accept one event; the returned promise never rejects. */
  record(session: SessionIdentity, event: RawSessionEvent): Promise<void>
  /** Resolve once every accepted event has been persisted. */
  flush(): Promise<void>
}

const WORKSPACE_UNKNOWN = 'workspace:unknown'

/**
 * The fallback workspace id: an opaque hash of the session's `cwd`.
 *
 * Hashing rather than storing the path keeps even the placeholder free of a user
 * directory, matching `WorkspaceRecord.repoRootHash`. It is used when the cwd is
 * not a repository, where a real repository identity does not exist to be had.
 */
function workspaceIdFor(cwd: string | undefined): string {
  if (typeof cwd !== 'string' || cwd.length === 0) return WORKSPACE_UNKNOWN
  return `workspace:${createHash('sha256').update(cwd).digest('hex')}`
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Build the recorder: the event-to-record pipeline, without any of its I/O
 * wiring.
 *
 * Events are processed strictly one at a time through a promise chain, so the
 * order the harness published them in is the order they are written and no two
 * events can interleave a read-modify-write of the same turn. Every step is
 * contained: a malformed event, a failing payload write or a rejecting sink is
 * recorded as a diagnostic and dropped, never propagated — a recorder that can
 * fail its caller is a recorder that can fail the agent, which is the one thing
 * `docs/PRD.md` forbids.
 */
export function createRecorder(options: RecorderOptions): Recorder {
  const { config, sink, store, diagnostics, resolveWorkspaceId } = options
  const assembler = createTurnAssembler()
  let queue: Promise<void> = Promise.resolve()

  /**
   * Workspace ids already resolved, keyed by cwd.
   *
   * The memo is what keeps repository resolution off the per-event path: a
   * session emits hundreds of events from one cwd, and resolving the identity
   * once per session is the difference between one `git` call and hundreds.
   * Failure is cached too — a cwd that is not a repository will not become one
   * mid-session, and a broken `git` should be reported once rather than per
   * event.
   */
  const workspaceIds = new Map<string, Promise<string>>()

  /**
   * Resolve a session's workspace id, never throwing.
   *
   * A resolver that rejects would take the whole event with it, and the event's
   * workspace is bookkeeping rather than evidence, so a failure degrades to the
   * cwd hash and a diagnostic instead of losing the turn.
   */
  const resolveWorkspace = (cwd: string | undefined): Promise<string> => {
    const key = cwd ?? ''
    const cached = workspaceIds.get(key)
    if (cached !== undefined) return cached
    const pending = (async (): Promise<string> => {
      if (resolveWorkspaceId === undefined) return workspaceIdFor(cwd)
      try {
        return await resolveWorkspaceId(cwd)
      } catch (error) {
        diagnostics.record({
          at: Date.now(),
          code: 'trace.workspace-unresolved',
          message: `${key || '(no cwd)'}: ${describe(error)}`,
        })
        return workspaceIdFor(cwd)
      }
    })()
    workspaceIds.set(key, pending)
    return pending
  }

  /**
   * Write a payload's bytes before the activity that references them.
   *
   * Redaction has already run — `normalizeEvent` hands over bytes that have
   * been redacted and truncated — so the store is told `redaction: 'applied'`
   * and would reject the call if the kind and the policy disagreed. On failure
   * the payload is dropped from the event rather than recorded: an activity must
   * never name an object that is not there.
   */
  const writePayload = async (event: NormalizedActivity): Promise<NormalizedActivity> => {
    const bytes = event.payloadBytes
    const meta = event.payload
    if (bytes === undefined || meta === undefined) return event
    const stored = await store.put(OBJECT_KINDS.ACTIVITY_PAYLOAD, bytes, { redaction: 'applied' })
    await sink.putObjectRecord({
      schemaVersion: SCHEMA_VERSION,
      ref: stored.ref,
      kind: OBJECT_KINDS.ACTIVITY_PAYLOAD,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      createdAt: Date.now(),
    })
    return event
  }

  /** The event with every payload field stripped, for when the write failed. */
  const withoutPayload = (event: NormalizedActivity): NormalizedActivity => {
    const { payloadRef: _ref, payloadBytes: _bytes, payload: _meta, ...rest } = event
    return rest
  }

  /**
   * Persist one turn row, protecting a terminal status.
   *
   * `upsertTurn` is a plain last-write-wins upsert by design, so writing a
   * stale non-terminal record for a turn the index already considers finished
   * would silently resurrect it. `transitionTurn` against the *stored* status
   * is the guard, and it protects only the terminal facts — the terminal status
   * and the end timestamp — so the counts this layer legitimately updates still
   * flow through. Reading first is what makes this correct across a restart,
   * where the assembler has no memory of a turn it did not close.
   */
  const writeTurn = async (record: TurnRecord): Promise<void> => {
    const stored = await sink.getTurn(record.id)
    if (stored === undefined) {
      await sink.upsertTurn(record)
      return
    }
    const status = transitionTurn(stored.status, record.status)
    if (status === record.status) {
      await sink.upsertTurn(record)
      return
    }
    await sink.upsertTurn({ ...record, status, endedAt: stored.endedAt })
  }

  const handle = async (session: SessionIdentity, event: RawSessionEvent): Promise<void> => {
    const workspaceId = await resolveWorkspace(session.cwd)
    const normalized = normalizeEvent(session.id, workspaceId, event, config)
    if (normalized === undefined) {
      // Unknown or unusable upstream event: counted by type and ignored.
      if (typeof event.type === 'string') diagnostics.recordIgnoredKind(event.type)
      return
    }

    let ingestable = normalized
    try {
      ingestable = await writePayload(normalized)
    } catch (error) {
      diagnostics.record({
        at: Date.now(),
        code: 'trace.payload-failed',
        message: `${normalized.activityId}: ${describe(error)}`,
      })
      ingestable = withoutPayload(normalized)
    }

    const output = assembler.ingest(ingestable)
    if (output.ignored) {
      diagnostics.record({
        at: Date.now(),
        code: 'trace.event-unattributed',
        message: `${normalized.activityId} (${normalized.kind}) has no open turn to belong to`,
      })
      return
    }
    if (output.dropped > 0) {
      diagnostics.record({
        at: Date.now(),
        code: 'trace.buffer-overflow',
        message: `shed ${output.dropped} event(s) waiting for a turn that never opened`,
      })
    }

    for (const turn of output.turns) await writeTurn(turn)
    for (const activity of output.activities) await sink.appendActivity(activity)
  }

  const record = (session: SessionIdentity, event: RawSessionEvent): Promise<void> => {
    const task = queue
      .then(() => handle(session, event))
      .catch((error: unknown) => {
        // The chain must survive anything, including a diagnostic sink that
        // somehow throws, so this catch is the last line rather than a policy.
        diagnostics.record({
          at: Date.now(),
          code: 'trace.event-failed',
          message: describe(error),
        })
      })
    queue = task
    return task
  }

  return {
    record,
    flush: async () => {
      await queue
    },
  }
}

/** The running recorder and the resources it owns. */
export interface TraceCore {
  /** Resolve once every accepted event has reached the index. */
  flush(): Promise<void>
  /** Unsubscribe, drain, and close. Idempotent, and never throws. */
  stop(): Promise<void>
}

/**
 * Wire the recorder into a live plugin context.
 *
 * This is the fail-open boundary of the whole plugin. Everything that can go
 * wrong here — a data root that cannot be resolved, a foreign or corrupt index
 * file, an unwritable directory, a store that will not mount — is caught and
 * turned into a diagnostic plus an inert core, because the alternative is an
 * exception escaping into harness startup. Losing recording is an acceptable
 * outcome; blocking the agent is not, and that is a hard requirement of
 * `docs/PRD.md`, not a preference.
 *
 * A partially built core releases what it already opened before it gives up,
 * so a failure never leaks a database handle for the life of the process.
 */
export async function startTraceCore(
  ctx: Context,
  config: TurnscopeConfig,
  diagnostics: Diagnostics,
): Promise<TraceCore> {
  try {
    const root = resolveDataRoot(config, { DSH_HOME: process.env['DSH_HOME'] }, homedir())
    const handle = await openIndex(resolveIndexPath(root))
    try {
      const repository = createRepository(handle)
      const store = createObjectStore(root)
      const git = createGitPort(createExecFileRunner())
      const recorder = createRecorder({
        config,
        sink: repository,
        store,
        diagnostics,
        // The real workspace is the repository root, not the working directory:
        // a session started in a subdirectory, or in a linked worktree, must
        // land in the same workspace as every other session on that repository,
        // or retention and history would each see only part of it. A directory
        // that is not a repository keeps the opaque cwd hash.
        resolveWorkspaceId: async cwd => {
          const identity =
            cwd === undefined || cwd.length === 0
              ? undefined
              : await resolveRepositoryIdentity(git, cwd)
          return identity?.rootIdentity ?? workspaceIdFor(cwd)
        },
      })
      const unsubscribe = subscribeSessionEvents(ctx, (session, event) => {
        void recorder.record({ id: session.id, cwd: session.header.cwd }, event)
      })
      return {
        flush: () => recorder.flush(),
        stop: async () => {
          try {
            unsubscribe()
            await recorder.flush()
            await repository.close()
          } catch (error) {
            diagnostics.record({
              at: Date.now(),
              code: 'trace.stop-failed',
              message: describe(error),
            })
          }
        },
      }
    } catch (error) {
      // Nothing was observed yet, so there is nothing to drain; just make sure
      // the open handle does not outlive the failure.
      try {
        handle.close()
      } catch {
        // The original error is the one that explains what happened.
      }
      throw error
    }
  } catch (error) {
    diagnostics.record({ at: Date.now(), code: 'trace.disabled', message: describe(error) })
    return {
      flush: async () => {},
      stop: async () => {},
    }
  }
}
