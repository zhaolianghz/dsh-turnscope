import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client';
export type TurnStatus = 'running' | 'completed' | 'failed' | 'max-tokens';
export interface ActivityModel {
    readonly id: string;
    readonly seq: number;
    readonly kind: 'user' | 'assistant' | 'tool' | 'command' | 'error' | 'max-tokens' | 'system' | 'unknown';
    readonly label: string;
    readonly time: number;
}
export interface TurnModel {
    readonly turn: number;
    readonly status: TurnStatus;
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly durationMs?: number;
    readonly toolCount: number;
    readonly errorCount: number;
    readonly activities: readonly ActivityModel[];
}
export declare function deriveTurnModels(snapshot: ConversationSnapshot): readonly TurnModel[];
//# sourceMappingURL=turn-model.d.ts.map