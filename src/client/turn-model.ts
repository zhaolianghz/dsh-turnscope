import type { ConversationNode, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

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

export function deriveTurnModels(snapshot: ConversationSnapshot): readonly TurnModel[] {
  const endSeqs = [...snapshot.turnEnds.entries()].sort((left, right) => left[1] - right[1])
  const openTurn = [...snapshot.turnTimings.keys()]
    .sort((left, right) => right - left)
    .find(turn => !snapshot.turnEnds.has(turn))
  const turnForSeq = (seq: number): number | undefined =>
    endSeqs.find(([, endSeq]) => seq <= endSeq)?.[0] ?? openTurn

  const groups = new Map<number, ConversationNode[]>()
  for (const conversationNode of snapshot.nodes) {
    const explicit = 'turn' in conversationNode && typeof conversationNode.turn === 'number'
      ? conversationNode.turn
      : undefined
    const turn = explicit ?? turnForSeq(conversationNode.seq)
    if (turn === undefined || !snapshot.turnTimings.has(turn)) continue
    const group = groups.get(turn) ?? []
    group.push(conversationNode)
    groups.set(turn, group)
  }

  return [...snapshot.turnTimings.entries()].map(([turn, timing]): TurnModel => {
    const nodes = groups.get(turn) ?? []
    const hasTurnError = nodes.some(item => item.kind === 'turn-error')
    const hasMaxTokens = nodes.some(item => item.kind === 'turn-max-tokens')
    const status: TurnStatus = hasTurnError
      ? 'failed'
      : hasMaxTokens
        ? 'max-tokens'
        : timing.endTime === undefined ? 'running' : 'completed'
    const errorCount = nodes.filter(item =>
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
      toolCount: nodes.filter(item => item.kind === 'tool-result').length,
      errorCount,
      activities: Object.freeze(nodes.map(activityFromNode)),
    })
  }).sort((left, right) => right.turn - left.turn)
}
