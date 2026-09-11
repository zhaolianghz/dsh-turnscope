import type { Context } from '@deepseek-ai/cordis';
import type { TurnscopeConfig } from '../config.ts';
import type { Diagnostics } from '../diagnostics.ts';
import type { RawSessionEvent } from './adapters/dsh/normalize.ts';
import type { ObjectStore } from './storage/object-store.ts';
import type { TraceRepository } from './storage/repository.ts';
/** Index file name under the plugin's private data root, per `docs/ARCHITECTURE.md §4.2`. */
export declare const INDEX_FILENAME = "index.sqlite3";
/** The plugin-private index path for an already-resolved data root. */
export declare function resolveIndexPath(dataRoot: string): string;
/** The part of a session the recorder needs; the harness `Session` satisfies it. */
export interface SessionIdentity {
    readonly id: string;
    /** Absolute working directory the session was created in, when it recorded one. */
    readonly cwd: string | undefined;
}
/**
 * The slice of {@link TraceRepository} the recorder writes through.
 *
 * Narrow on purpose: the recorder is the only writer, and a test can stand in
 * for a repository with four methods instead of sixteen.
 */
export type TraceSink = Pick<TraceRepository, 'getTurn' | 'upsertTurn' | 'appendActivity' | 'putObjectRecord'>;
/** What the recorder needs from its environment. */
export interface RecorderOptions {
    readonly config: TurnscopeConfig;
    readonly sink: TraceSink;
    readonly store: ObjectStore;
    readonly diagnostics: Diagnostics;
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
    readonly resolveWorkspaceId?: (cwd: string | undefined) => Promise<string>;
}
/** Accepts events and persists the records they imply. */
export interface Recorder {
    /** Accept one event; the returned promise never rejects. */
    record(session: SessionIdentity, event: RawSessionEvent): Promise<void>;
    /** Resolve once every accepted event has been persisted. */
    flush(): Promise<void>;
}
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
export declare function createRecorder(options: RecorderOptions): Recorder;
/** The running recorder and the resources it owns. */
export interface TraceCore {
    /** Resolve once every accepted event has reached the index. */
    flush(): Promise<void>;
    /** Unsubscribe, drain, and close. Idempotent, and never throws. */
    stop(): Promise<void>;
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
export declare function startTraceCore(ctx: Context, config: TurnscopeConfig, diagnostics: Diagnostics): Promise<TraceCore>;
//# sourceMappingURL=core.d.ts.map