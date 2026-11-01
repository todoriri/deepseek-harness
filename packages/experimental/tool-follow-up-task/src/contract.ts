/**
 * Durable presentation records written by the follow-up task tools as
 * `tool/result.meta` (native calls) or `tool/ptc-dispatch.meta` (PTC calls).
 * The module is type-only and browser-safe; readers treat logged records as
 * untrusted durable data and validate them before use.
 * @module @deepseek-ai/dsh-experimental-tool-follow-up-task/contract
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Result metadata of one successful `suggest_follow_up_task` call. It carries
 * every field the Web card displays and starts, so a card never depends on
 * reparsing the model's call arguments.
 */
export interface FollowUpTaskSuggestedMeta {
  readonly type: 'follow-up-task.suggested'
  /** Id of the suggesting call; `dismiss_follow_up_task` accepts it as `taskId`. */
  readonly taskId: ToolCallId
  /**
   * Identity reserved for the Session the task starts. No Session exists under
   * it until the user starts the task; Session creation then adopts it.
   */
  readonly sessionId: SessionId
  /** Imperative label shown on the card. */
  readonly title: string
  /** One or two sentences shown on the card. */
  readonly summary: string
  /** Complete instructions placed in the new Session's composer for review before sending. */
  readonly prompt: string
}

/** Result metadata of one successful `dismiss_follow_up_task` call. */
export interface FollowUpTaskDismissedMeta {
  readonly type: 'follow-up-task.dismissed'
  /** Id of the withdrawn suggestion. */
  readonly taskId: ToolCallId
}

/** Every metadata record the follow-up task tools write. */
export type FollowUpTaskMeta = FollowUpTaskSuggestedMeta | FollowUpTaskDismissedMeta
