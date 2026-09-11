export const NS = 'turnscope'

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
export const zh = {
  'view.title': '轮次',
  'state.loading': '正在加载时间线',
  'state.empty': '此会话还没有可显示的轮次',
  'action.refresh': '刷新',
  'safety.unavailable': '无法向主进程查询安全结论：{reason}',
  'safety.unjudged': '未评估',
  'safety.SAFE': '安全',
  'safety.CAUTION': '注意',
  'safety.FORK_ONLY': '仅可分叉',
  'safety.UNPROTECTED': '无保护',
  // `§14.3` wants the preview named before anything is written; the V0.1 panel
  // offers no write at all, so these words describe what the host *recommends*
  // rather than something a button here performs.
  'action.recommended': '建议动作',
  'action.INSPECT': '先人工检查',
  'action.PREVIEW_REWIND': '回滚前先预览',
  'action.REWIND': '可安全回滚',
  'action.FORK': '建议分叉后继续',
  'action.NONE': '不提供恢复动作',
  'status.running': '运行中',
  'status.completed': '已完成',
  'status.failed': '失败',
  'status.maxTokens': '达到输出限制',
  'status.pending': '待开始',
  'status.interrupted': '已中断',
  'status.cancelled': '已取消',
  'status.hostSays': '主进程记录：{status}',
  'summary.changes': '变更文件',
  'summary.tools': '工具',
  'summary.errors': '异常',
  'summary.duration': '耗时',
  'evidence.complete': '证据完整',
  'evidence.partial': '证据不完整',
  'evidence.missing': '证据缺失',
  'freshness.loading': '正在查询主进程',
  'freshness.error': '未能查询主进程',
  'freshness.live': '实时',
  'freshness.stale': '落后于主进程',
  'freshness.stable': '与主进程一致',
} satisfies Record<string, string>

export type TurnscopeKey = keyof typeof zh

export const en = {
  'view.title': 'Turns',
  'state.loading': 'Loading timeline',
  'state.empty': 'No turns to display in this session',
  'action.refresh': 'Refresh',
  'safety.unavailable': 'Could not ask the host for safety verdicts: {reason}',
  'safety.unjudged': 'Not judged',
  'safety.SAFE': 'Safe',
  'safety.CAUTION': 'Caution',
  'safety.FORK_ONLY': 'Fork only',
  'safety.UNPROTECTED': 'Unprotected',
  'action.recommended': 'Recommended',
  'action.INSPECT': 'Inspect before acting',
  'action.PREVIEW_REWIND': 'Preview rewind first',
  'action.REWIND': 'Safe to rewind',
  'action.FORK': 'Fork recommended',
  'action.NONE': 'No recovery action',
  'status.running': 'Running',
  'status.completed': 'Completed',
  'status.failed': 'Failed',
  'status.maxTokens': 'Output limit reached',
  'status.pending': 'Not started',
  'status.interrupted': 'Interrupted',
  'status.cancelled': 'Cancelled',
  'status.hostSays': 'Host recorded: {status}',
  'summary.changes': 'Changed files',
  'summary.tools': 'Tools',
  'summary.errors': 'Errors',
  'summary.duration': 'Duration',
  'evidence.complete': 'Evidence complete',
  'evidence.partial': 'Evidence incomplete',
  'evidence.missing': 'Evidence missing',
  'freshness.loading': 'Asking the host',
  'freshness.error': 'Could not ask the host',
  'freshness.live': 'Live',
  'freshness.stale': 'Behind the host',
  'freshness.stable': 'In step with the host',
} satisfies Record<TurnscopeKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    turnscope: TurnscopeKey
  }
}
