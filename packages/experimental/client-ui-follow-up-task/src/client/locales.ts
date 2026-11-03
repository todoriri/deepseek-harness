/** `followUpTask` namespace dictionaries (follow-up task card and transcript row copy). */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'card.label': '后续任务',
  'card.start': '开始',
  'card.startNamed': '开始后续任务：{title}',
  'card.dismiss': '忽略',
  'card.restore': '恢复',
  'card.open': '打开会话',
  'card.openDraft': '打开草稿',
  'card.showPrompt': '显示提示词',
  'card.hidePrompt': '隐藏提示词',
  'card.dismissed': '已忽略',
  'card.withdrawn': '已由智能体撤回',
  'row.suggestTitle': '建议后续任务',
  'row.dismissTitle': '撤回后续任务',
  'row.preparing': '正在准备调用',
  'row.running': '运行中',
  'row.failed': '失败',
  'row.stopped': '已停止',
  'row.inspect': '查看调用',
} satisfies Record<string, string>

/** The follow-up task namespace key union. */
export type FollowUpTaskKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Follow-up task card and transcript row copy. */
    followUpTask: FollowUpTaskKey
  }
}

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'card.label': 'Follow-up task',
  'card.start': 'Start',
  'card.startNamed': 'Start follow-up task: {title}',
  'card.dismiss': 'Dismiss',
  'card.restore': 'Restore',
  'card.open': 'Open session',
  'card.openDraft': 'Open draft',
  'card.showPrompt': 'Show prompt',
  'card.hidePrompt': 'Hide prompt',
  'card.dismissed': 'Dismissed',
  'card.withdrawn': 'Withdrawn by the agent',
  'row.suggestTitle': 'Suggest follow-up task',
  'row.dismissTitle': 'Withdraw follow-up task',
  'row.preparing': 'Preparing tool call',
  'row.running': 'Running',
  'row.failed': 'Failed',
  'row.stopped': 'Stopped',
  'row.inspect': 'Inspect call',
} satisfies Record<FollowUpTaskKey, string>
