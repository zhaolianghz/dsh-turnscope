import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Receives every event the harness publishes on a session's log. */
export type SessionObserver = (session: Session, event: SessionEvent) => void

/**
 * Subscribe to the session event firehose.
 *
 * Two constraints are load-bearing, and both are the opposite of what the
 * surrounding code style would suggest:
 *
 * - **Register on the context `apply` receives, never a scope-tagged child.**
 *   A listener attached to a scope-tagged context is quietly filtered and
 *   observes *nothing at all* — no error, no diagnostic, just an empty trace.
 *   `inject: ['sessions']` is not required for the listener itself, only for
 *   reading `ctx.sessions`, so this subscription works before the store mounts
 *   and never needs the recorder to be composed per agent or per session.
 * - **Contain every failure inside the listener.** The dispatch is
 *   fire-and-forget and the harness reports one listener's failure without
 *   detaching it, but this plugin owns the promise that recording is optional;
 *   wrapping the body here means the guarantee holds on the harness's terms
 *   rather than on the harness's current implementation.
 *
 * @param ctx - the plugin context; the listener is disposed with its fiber.
 * @param onEvent - called for every published event; may throw freely.
 * @returns a disposer that unsubscribes.
 */
export function subscribeSessionEvents(ctx: Context, onEvent: SessionObserver): () => void {
  const listener = (session: Session, event: SessionEvent): void => {
    try {
      onEvent(session, event)
    } catch {
      // fail-open: one malformed event must not cost the rest of the session
    }
  }
  return ctx.on('session/event', listener)
}
