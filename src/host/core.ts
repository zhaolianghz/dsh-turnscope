import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { TurnscopeConfig } from '../config.ts'
import type { Diagnostics } from '../diagnostics.ts'
import { SCHEMA_VERSION } from './domain/types.ts'
import { isTerminal, transitionTurn } from './domain/turn-state.ts'
import type { TurnRecord, TurnStatus } from './domain/types.ts'
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
import { createFileDiffReader } from './diff/reader.ts'
import { createTurnInspector } from './inspection/inspector.ts'
import type { TurnInspector } from './inspection/types.ts'
import { createQueryService } from './query/service.ts'
import { mountTurnscopeRemoteWhenReady } from './adapters/dsh/remote.ts'

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
 * for a repository with a handful of methods instead of sixteen.
 */
export type TraceSink = Pick<
  TraceRepository,
  'getTurn' | 'upsertTurn' | 'appendActivity' | 'putObjectRecord'
>

/**
 * Where a session's working directory belongs.
 *
 * The repository root is optional because a working directory need not be in a
 * repository. When it is absent the recorder still captures, and the capture
 * records "not a git worktree" — which the safety rules read as `S009` rather
 * than as a gap.
 */
export interface WorkspaceResolution {
  readonly workspaceId: string
  readonly repoRoot: string | undefined
}

/** What the recorder needs from its environment. */
export interface RecorderOptions {
  readonly config: TurnscopeConfig
  readonly sink: TraceSink
  readonly store: ObjectStore
  readonly diagnostics: Diagnostics
  /**
   * The turn-boundary pipeline, when the host has one.
   *
   * Injected rather than built here because building it means spawning Git, and
   * the recorder is unit-tested without a repository. Absent, turns are still
   * recorded and simply never inspected — the recorder degrades to what Phase C
   * was, which is the honest thing for a host that cannot observe a workspace.
   */
  readonly inspector?: TurnInspector | undefined
  /**
   * Resolve the workspace a session's `cwd` belongs to.
   *
   * Injected for the same reason as {@link inspector}: resolving a real
   * repository identity spawns Git. Omitted, it falls back to the opaque cwd
   * hash below — which is the honest answer when the working directory is not a
   * repository, and is also what the resolver itself falls back to. It is never
   * allowed to throw: see {@link createRecorder}.
   */
  readonly resolveWorkspace?: (
    cwd: string | undefined,
  ) => Promise<WorkspaceResolution>
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
  const { config, sink, store, diagnostics, inspector, resolveWorkspace: resolve } = options
  const assembler = createTurnAssembler()
  let queue: Promise<void> = Promise.resolve()

  /**
   * Workspaces already resolved, keyed by cwd.
   *
   * The memo is what keeps repository resolution off the per-event path: a
   * session emits hundreds of events from one cwd, and resolving the identity
   * once per session is the difference between one `git` call and hundreds.
   * Failure is cached too — a cwd that is not a repository will not become one
   * mid-session, and a broken `git` should be reported once rather than per
   * event.
   */
  const workspaces = new Map<string, Promise<WorkspaceResolution>>()

  /**
   * Resolve a session's workspace, never throwing.
   *
   * A resolver that rejects would take the whole event with it, and the event's
   * workspace is bookkeeping rather than evidence, so a failure degrades to the
   * cwd hash and a diagnostic instead of losing the turn. The repository root is
   * dropped along with it: the fallback cannot claim to know one.
   */
  const resolveWorkspace = (cwd: string | undefined): Promise<WorkspaceResolution> => {
    const key = cwd ?? ''
    const cached = workspaces.get(key)
    if (cached !== undefined) return cached
    const pending = (async (): Promise<WorkspaceResolution> => {
      if (resolve === undefined) return { workspaceId: workspaceIdFor(cwd), repoRoot: cwd }
      try {
        return await resolve(cwd)
      } catch (error) {
        diagnostics.record({
          at: Date.now(),
          code: 'trace.workspace-unresolved',
          message: `${key || '(no cwd)'}: ${describe(error)}`,
        })
        return { workspaceId: workspaceIdFor(cwd), repoRoot: cwd }
      }
    })()
    workspaces.set(key, pending)
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
   *
   * The status read on the way in is returned rather than discarded: it is the
   * only evidence of whether this record *opened* or *closed* the turn, and the
   * inspector needs exactly that and nothing else to decide which checkpoint to
   * take. `undefined` means the index had never heard of this turn.
   */
  const writeTurn = async (record: TurnRecord): Promise<TurnStatus | undefined> => {
    const stored = await sink.getTurn(record.id)
    if (stored === undefined) {
      await sink.upsertTurn(record)
      return undefined
    }
    const status = transitionTurn(stored.status, record.status)
    if (status === record.status) {
      await sink.upsertTurn(record)
    } else {
      await sink.upsertTurn({ ...record, status, endedAt: stored.endedAt })
    }
    return stored.status
  }

  /**
   * Record one turn, then let the inspector look at the boundary it may have
   * just crossed.
   *
   * The two are deliberately not interleaved: the turn row is written first so
   * that a capture which fails still leaves a turn the user can see. An
   * inspection failure is a diagnostic and never an `await` that can lose the
   * turn, because the turn is the evidence and the verdict is a reading of it.
   */
  const writeAndObserveTurn = async (
    record: TurnRecord,
    workspace: WorkspaceResolution,
  ): Promise<void> => {
    const previous = await writeTurn(record)
    if (inspector === undefined) return
    const repoRoot = workspace.repoRoot
    if (repoRoot === undefined) return
    try {
      const result = await inspector.observe(
        record,
        { workspaceId: workspace.workspaceId, repoRoot },
        previous,
      )
      if (result !== undefined) {
        diagnostics.record({
          at: Date.now(),
          code: 'trace.turn-inspected',
          message: `${record.id}: ${result.verdict.level} (${result.verdict.reasons.length} reason(s))`,
        })
      }
    } catch (error) {
      diagnostics.record({
        at: Date.now(),
        code: 'trace.turn-inspection-failed',
        message: `${record.id}: ${describe(error)}`,
      })
    }
  }

  const handle = async (session: SessionIdentity, event: RawSessionEvent): Promise<void> => {
    const workspace = await resolveWorkspace(session.cwd)
    const normalized = normalizeEvent(session.id, workspace.workspaceId, event, config)
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

    // Evidence before summary. A turn row carries `activityCount`, so writing it
    // first would let a reader see a completed turn that claims activities which
    // are not in the table yet — and with an inspection spawning Git between the
    // two writes, that window is no longer microseconds wide. The activities are
    // the facts; the row is a reading of them.
    for (const activity of output.activities) await sink.appendActivity(activity)
    for (const turn of output.turns) await writeAndObserveTurn(turn, workspace)
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
      // The real workspace is the repository root, not the working directory:
      // a session started in a subdirectory, or in a linked worktree, must land
      // in the same workspace as every other session on that repository, or
      // retention and history would each see only part of it. A directory that
      // is not a repository keeps the opaque cwd hash and is handed to the
      // inspector as-is, so the capture can record "not a git worktree" — which
      // is `S009`'s evidence, not a hole in the pipeline.
      const resolveWorkspace = async (
        cwd: string | undefined,
      ): Promise<WorkspaceResolution> => {
        const identity =
          cwd === undefined || cwd.length === 0
            ? undefined
            : await resolveRepositoryIdentity(git, cwd)
        return {
          workspaceId: identity?.rootIdentity ?? workspaceIdFor(cwd),
          repoRoot: identity?.repoRoot ?? cwd,
        }
      }
      const inspector = createTurnInspector({
        git,
        store,
        sink: repository,
        maxBlobBytes: config.maxBlobBytes,
        ignorePaths: config.ignorePaths,
      })
      const recorder = createRecorder({
        config,
        sink: repository,
        store,
        diagnostics,
        inspector,
        resolveWorkspace,
      })
      const unsubscribe = subscribeSessionEvents(ctx, (session, event) => {
        void recorder.record({ id: session.id, cwd: session.header.cwd }, event)
      })
      // The read side is built here rather than in `apply` so that it shares the
      // recorder's repository handle: a second handle on the same file would be
      // a second WAL writer, and its own `stop()` to get wrong. Mounting waits
      // for the gateway (see `mountTurnscopeRemoteWhenReady`) and is best-effort
      // — a host with no Typert registry loses the API and keeps recording — so
      // it cannot fail this function.
      const query = createQueryService({
        sink: repository,
        inspector,
        diffs: createFileDiffReader({ git, store, sink: repository }),
      })
      const unmountRemote = mountTurnscopeRemoteWhenReady(ctx, query, diagnostics)
      return {
        flush: () => recorder.flush(),
        stop: async () => {
          try {
            unsubscribe()
            unmountRemote()
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
