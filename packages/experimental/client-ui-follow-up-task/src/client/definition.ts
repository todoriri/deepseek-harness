/** One hidden turn-tail card per follow-up task suggestion, withdrawn by a later dismissal record. */

import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { FollowUpTaskSuggestedMeta } from '@deepseek-ai/dsh-experimental-tool-follow-up-task/contract'
import { followUpTaskMetaOf } from './task.ts'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One follow-up task suggestion and whether the agent withdrew it. */
    'follow-up-task': FollowUpTaskNodeState
  }
}

/** Card state of one follow-up task suggestion. */
export interface FollowUpTaskNodeState {
  /** The suggestion the card renders and starts. */
  readonly task: FollowUpTaskSuggestedMeta
  /** Whether a later dismissal record withdrew the suggestion. */
  readonly withdrawn: boolean
}

/** The Chat Definition folding one suggestion and its withdrawal into a hidden turn-tail card. */
export const followUpTaskDefinition: ConversationNodeDefinition<FollowUpTaskNodeState> = {
  kind: 'follow-up-task',
  target: 'chat',
  match: (event) => {
    const meta = followUpTaskMetaOf(event)
    if (meta === undefined) return null
    return { id: meta.taskId, role: meta.type === 'follow-up-task.dismissed' ? 'update' : 'start' }
  },
  start: (_context, match) => ({
    task: followUpTaskMetaOf(match.event) as FollowUpTaskSuggestedMeta,
    withdrawn: false,
  }),
  update: (context, match) => followUpTaskMetaOf(match.event)?.type === 'follow-up-task.dismissed'
    ? { task: context.state.task, withdrawn: true }
    : context.state,
  buildViewNode: (context) => {
    const start = context.start ?? context.matches[0]
    if (context.state === undefined || start === undefined) return null
    return {
      key: context.key,
      kind: 'follow-up-task',
      id: context.id,
      target: 'chat',
      anchorSeq: start.event.seq,
      location: start.location,
      visibility: 'hidden',
      data: context.state,
    } satisfies ChatNode<'follow-up-task'>
  },
}
