import type { Context } from '@deepseek-ai/cordis';
export declare const name = "turnscope";
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
export declare function apply(ctx: Context, config?: unknown): Promise<void>;
//# sourceMappingURL=index.d.ts.map