export declare const NS = "turnscope";
/**
 * The panel's vocabulary.
 *
 * Two rules came from the product spec and are visible in the wording itself.
 * `docs/PRD.md §14.2` forbids hedging about safety — no "probably", no "should be
 * fine" — so a level is a statement and a recommended action is named rather than
 * hinted at ("Safe to rewind", "Fork recommended"). `§14.4` forbids colour as the
 * only carrier of meaning, so every state below is a word first and a colour
 * second, and the words are what a reader (or a screen reader) gets.
 */
export declare const zh: {
    'view.title': string;
    'state.loading': string;
    'state.empty': string;
    'action.refresh': string;
    'safety.unavailable': string;
    'safety.unjudged': string;
    'safety.SAFE': string;
    'safety.CAUTION': string;
    'safety.FORK_ONLY': string;
    'safety.UNPROTECTED': string;
    'action.recommended': string;
    'action.INSPECT': string;
    'action.PREVIEW_REWIND': string;
    'action.REWIND': string;
    'action.FORK': string;
    'action.NONE': string;
    'status.running': string;
    'status.completed': string;
    'status.failed': string;
    'status.maxTokens': string;
    'status.pending': string;
    'status.interrupted': string;
    'status.cancelled': string;
    'status.hostSays': string;
    'summary.changes': string;
    'summary.tools': string;
    'summary.errors': string;
    'summary.duration': string;
    'evidence.complete': string;
    'evidence.partial': string;
    'evidence.missing': string;
    'freshness.loading': string;
    'freshness.error': string;
    'freshness.live': string;
    'freshness.stale': string;
    'freshness.stable': string;
};
export type TurnscopeKey = keyof typeof zh;
export declare const en: {
    'view.title': string;
    'state.loading': string;
    'state.empty': string;
    'action.refresh': string;
    'safety.unavailable': string;
    'safety.unjudged': string;
    'safety.SAFE': string;
    'safety.CAUTION': string;
    'safety.FORK_ONLY': string;
    'safety.UNPROTECTED': string;
    'action.recommended': string;
    'action.INSPECT': string;
    'action.PREVIEW_REWIND': string;
    'action.REWIND': string;
    'action.FORK': string;
    'action.NONE': string;
    'status.running': string;
    'status.completed': string;
    'status.failed': string;
    'status.maxTokens': string;
    'status.pending': string;
    'status.interrupted': string;
    'status.cancelled': string;
    'status.hostSays': string;
    'summary.changes': string;
    'summary.tools': string;
    'summary.errors': string;
    'summary.duration': string;
    'evidence.complete': string;
    'evidence.partial': string;
    'evidence.missing': string;
    'freshness.loading': string;
    'freshness.error': string;
    'freshness.live': string;
    'freshness.stale': string;
    'freshness.stable': string;
};
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        turnscope: TurnscopeKey;
    }
}
//# sourceMappingURL=locales.d.ts.map