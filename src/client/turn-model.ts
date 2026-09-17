import type { ChatSnapshot, ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'

export type TurnStatus = 'running' | 'completed' | 'failed' | 'max-tokens'

export interface ActivityModel {
  readonly id: string
  readonly seq: number
  readonly kind: 'user' | 'assistant' | 'tool' | 'command' | 'error' | 'max-tokens' | 'system' | 'unknown'
  readonly label: string
  readonly time: number
}

export interface TurnModel {
  readonly turn: number
  readonly status: TurnStatus
  readonly startedAt: number
  readonly endedAt?: number
  readonly durationMs?: number
  readonly toolCount: number
  readonly errorCount: number
  readonly activities: readonly ActivityModel[]
}

function activityFromNode(node: ConversationNode): ActivityModel {
  const base = { id: `${node.kind}:${node.seq}`, seq: node.seq, time: node.time }
  switch (node.kind) {
    case 'user': return { ...base, kind: 'user', label: 'User message' }
    case 'assistant': return { ...base, kind: 'assistant', label: `Assistant step ${node.step}` }
    case 'tool-result': return { ...base, kind: 'tool', label: `Tool: ${node.call?.name ?? node.callId}` }
    case 'command': return { ...base, kind: 'command', label: `Command: /${node.name ?? 'unknown'}` }
    case 'turn-error': return { ...base, kind: 'error', label: 'Turn failed' }
    case 'turn-max-tokens': return { ...base, kind: 'max-tokens', label: 'Token limit reached' }
    case 'context': return { ...base, kind: 'system', label: 'Context' }
    case 'steering': return { ...base, kind: 'user', label: 'Steering message' }
    case 'model-retry': return { ...base, kind: 'system', label: 'Model retry' }
    case 'compaction': return { ...base, kind: 'system', label: 'Compaction' }
    case 'unknown': return { ...base, kind: 'unknown', label: `Unknown: ${node.type}` }
    default: {
      const future = node as { kind?: unknown; seq: number; time: number }
      return {
        id: `unknown:${future.seq}`,
        seq: future.seq,
        time: future.time,
        kind: 'unknown',
        label: `Unknown: ${String(future.kind ?? 'event')}`,
      }
    }
  }
}

export function deriveTurnModels(chat: ChatSnapshot): readonly TurnModel[] {
  // The renderer reads chat data through DSH's `useChat` hook, which returns a
  // `ChatSnapshot`. Turn timing and end data live on the snapshot's `legacy`
  // compatibility projection (same shape DSH's own `StatsLine` and `ChatView`
  // components pull from via `useChat((s) => s.legacy.turnTimings)`).
  //
  // An empty `legacy.turnTimings` is the "blank session" signal — no turn has
  // started yet. Return an empty list and let the view render its
  // empty-state branch.
  const turnTimings = chat.legacy.turnTimings
  const turnEnds = chat.legacy.turnEnds
  const nodes = chat.legacy.nodes
  if (turnTimings.size === 0) return []

  const endSeqs = [...turnEnds.entries()].sort((left, right) => left[1] - right[1])
  const openTurn = [...turnTimings.keys()]
    .sort((left, right) => right - left)
    .find(turn => !turnEnds.has(turn))
  const turnForSeq = (seq: number): number | undefined =>
    endSeqs.find(([, endSeq]) => seq <= endSeq)?.[0] ?? openTurn
  // A session's bootstrap burst — the instructions, catalog, and recall the
  // harness injects before the first user prompt — lands in the conversation
  // as `context` nodes with seqs earlier than the first `user` / `assistant`
  // seq. Those nodes are not turn activity, so we drop them here. When the
  // snapshot has no user/assistant yet (fresh session, no message sent), we
  // keep the entries: there is no signal to distinguish bootstrap from
  // "the user is composing their first prompt" and dropping them would be
  // worse than showing them.
  const firstRealSeq = nodes.reduce<number | undefined>((min, n) => {
    if (n.kind !== 'user' && n.kind !== 'assistant') return min
    return min === undefined ? n.seq : Math.min(min, n.seq)
  }, undefined)

  const groups = new Map<number, ConversationNode[]>()
  for (const conversationNode of nodes) {
    if (conversationNode.kind === 'context'
        && firstRealSeq !== undefined
        && conversationNode.seq < firstRealSeq) {
      continue
    }
    const explicit = 'turn' in conversationNode && typeof conversationNode.turn === 'number'
      ? conversationNode.turn
      : undefined
    const turn = explicit ?? turnForSeq(conversationNode.seq)
    if (turn === undefined || !turnTimings.has(turn)) continue
    const group = groups.get(turn) ?? []
    group.push(conversationNode)
    groups.set(turn, group)
  }

  return [...turnTimings.entries()].map(([turn, timing]): TurnModel => {
    const turnNodes = groups.get(turn) ?? []
    const hasTurnError = turnNodes.some(item => item.kind === 'turn-error')
    const hasMaxTokens = turnNodes.some(item => item.kind === 'turn-max-tokens')
    const status: TurnStatus = hasTurnError
      ? 'failed'
      : hasMaxTokens
        ? 'max-tokens'
        : timing.endTime === undefined ? 'running' : 'completed'
    const errorCount = turnNodes.filter(item =>
      item.kind === 'turn-error'
      || (item.kind === 'tool-result' && item.isError)
      || (item.kind === 'command' && item.outcome?.kind === 'error')).length

    return Object.freeze({
      turn,
      status,
      startedAt: timing.startTime,
      ...(timing.endTime === undefined
        ? {}
        : { endedAt: timing.endTime, durationMs: Math.max(0, timing.endTime - timing.startTime) }),
      toolCount: turnNodes.filter(item => item.kind === 'tool-result').length,
      errorCount,
      activities: Object.freeze(turnNodes.map(activityFromNode)),
    })
  }).sort((left, right) => right.turn - left.turn)
}
