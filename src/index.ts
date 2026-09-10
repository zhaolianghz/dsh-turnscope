import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.ts'
import { Diagnostics } from './diagnostics.ts'
import { startTraceCore } from './trace-core.ts'

export const name = 'turnscope'

/**
 * Host entry. Recording is best-effort: a failure here must never surface to
 * the harness, so this function is a hard boundary and never throws.
 *
 * It is `async` so that the recorder is fully wired before the plugin's fiber
 * reports itself loaded — a caller that awaits the fiber is then guaranteed
 * that the subscription is in place, and no event published at mount time can
 * race the listener into existence. `startTraceCore` already contains its own
 * failures; the `try/catch` here is the guarantee that nothing else can escape,
 * including a disposal that races this body.
 */
export async function apply(ctx: Context, config?: unknown): Promise<void> {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return
  const diagnostics = new Diagnostics()
  try {
    const core = await startTraceCore(ctx, resolved, diagnostics)
    // Registered on the plugin's own fiber, so unloading the plugin releases
    // the listener, drains the buffer and closes the index handle with it.
    ctx.effect(() => () => core.stop(), 'turnscope trace core')
  } catch {
    // fail-open: recording is optional, the agent is not
  }
}
