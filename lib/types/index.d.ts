import type { Context } from '@deepseek-ai/cordis';
export declare const name = "turnscope";
/**
 * Host entry. Recording is best-effort: a failure here must never surface to
 * the harness, so this function is a hard boundary and never throws.
 */
export declare function apply(ctx: Context, config?: unknown): void;
//# sourceMappingURL=index.d.ts.map