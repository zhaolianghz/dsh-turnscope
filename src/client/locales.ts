export const NS = 'turnscope'

export const zh = {
  'view.title': '轮次',
  'state.loading': '正在加载时间线',
  'state.empty': '此会话还没有可显示的轮次',
  'safety.unavailable': '无法向主进程查询安全结论：{reason}',
  'safety.SAFE': '安全',
  'safety.CAUTION': '注意',
  'safety.FORK_ONLY': '仅可分叉',
  'safety.UNPROTECTED': '无保护',
  'status.running': '运行中',
  'status.completed': '已完成',
  'status.failed': '失败',
  'status.maxTokens': '达到输出限制',
  'summary.tools': '工具',
  'summary.errors': '异常',
  'summary.duration': '耗时',
} satisfies Record<string, string>

export type TurnscopeKey = keyof typeof zh

export const en = {
  'view.title': 'Turns',
  'state.loading': 'Loading timeline',
  'state.empty': 'No turns to display in this session',
  'safety.unavailable': 'Could not ask the host for safety verdicts: {reason}',
  'safety.SAFE': 'Safe',
  'safety.CAUTION': 'Caution',
  'safety.FORK_ONLY': 'Fork only',
  'safety.UNPROTECTED': 'Unprotected',
  'status.running': 'Running',
  'status.completed': 'Completed',
  'status.failed': 'Failed',
  'status.maxTokens': 'Output limit reached',
  'summary.tools': 'Tools',
  'summary.errors': 'Errors',
  'summary.duration': 'Duration',
} satisfies Record<TurnscopeKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    turnscope: TurnscopeKey
  }
}
