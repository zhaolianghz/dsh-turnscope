import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'

/**
 * The minimal empty `ChatSnapshot` the renderer uses as a first-frame fallback.
 *
 * DSH ships `EMPTY_CHAT_SNAPSHOT` from `@deepseek-ai/dsh-client-ui-chat/client`,
 * but importing it pulls the runtime's `client.js` into the renderer bundle,
 * which references `window` at module load and crashes any non-browser test.
 *
 * This re-implementation only fills the fields `deriveTurnModels` reads from
 * (`legacy.turnTimings` / `legacy.turnEnds` / `legacy.nodes`) with empty
 * values; the rest of the snapshot is stubbed enough to satisfy the type
 * without influencing the renderer's behaviour. `deriveTurnModels` will
 * short-circuit on `turnTimings.size === 0` and return `[]`, which is the
 * right answer for "no chat data yet".
 */
export const EMPTY_CHAT: ChatSnapshot = {
  order: [],
  nodes: {
    get: () => undefined,
    source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
    processSource: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
    values: () => [],
  } as unknown as ChatSnapshot['nodes'],
  locations: {
    getTurn: () => [],
    getStep: () => [],
  },
  navigation: { items: () => [] },
  timeline: { turnOrder: [], turns: new Map() },
  legacy: {
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
  },
}
