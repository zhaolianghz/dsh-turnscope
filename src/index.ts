import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.ts'

export const name = 'turnscope'

/**
 * Host entry. Recording is best-effort: a failure here must never surface to
 * the harness, so this function is a hard boundary and never throws.
 */
export function apply(ctx: Context, config?: unknown): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return
  try {
    // Task 6 replaces this body with the real trace core.
    void ctx
  } catch {
    // fail-open: recording is optional, the agent is not
  }
}
