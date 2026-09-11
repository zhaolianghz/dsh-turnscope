import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/**
 * `connection` joins the list because the panel has to *ask* the host what it
 * recorded: the timeline is assembled in the browser, but whether a turn is safe
 * to undo is a statement about a repository on the host, and only the host can
 * make it. Without the connection the panel could still render the timeline, but
 * it would render verdicts it does not have.
 */
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map