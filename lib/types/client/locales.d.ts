export declare const NS = "turnscope";
export declare const zh: {
    'view.title': string;
    'state.loading': string;
    'state.empty': string;
    'status.running': string;
    'status.completed': string;
    'status.failed': string;
    'status.maxTokens': string;
    'summary.tools': string;
    'summary.errors': string;
    'summary.duration': string;
};
export type TurnscopeKey = keyof typeof zh;
export declare const en: {
    'view.title': string;
    'state.loading': string;
    'state.empty': string;
    'status.running': string;
    'status.completed': string;
    'status.failed': string;
    'status.maxTokens': string;
    'summary.tools': string;
    'summary.errors': string;
    'summary.duration': string;
};
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        turnscope: TurnscopeKey;
    }
}
//# sourceMappingURL=locales.d.ts.map