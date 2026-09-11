/**
 * One path's diff.
 *
 * The three things this can show are the three things `docs/PRD.md FR-07` asks
 * for: the comparison, the metadata of a comparison that cannot be drawn (a binary
 * file), and the reason there is no comparison at all. The last one is the one
 * that has to be rendered as a *sentence*, because a diff that cannot be produced
 * looks exactly like a diff that came back empty, and "we never saved the old
 * bytes" and "nothing changed here" are opposite claims
 * (`docs/ARCHITECTURE.md §28.3`).
 *
 * The unavailable reason's sentence is the host's, shown as written. It is written
 * where the missing bytes are known to be missing; rewording it here would be a
 * second place that has to know what retention did.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { FileDiffState } from './file-diffs.ts';
export interface DiffViewProps {
    readonly state: FileDiffState;
}
export declare function DiffView({ state, t }: DiffViewProps & PropsLocale<'turnscope'>): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=DiffView.d.ts.map