/** Follow-up task presentation records read from logged native and PTC tool results. */

import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FollowUpTaskDismissedMeta, FollowUpTaskMeta, FollowUpTaskSuggestedMeta } from '@deepseek-ai/dsh-experimental-tool-follow-up-task/contract'

/**
 * Whether `value` is a non-array object, the only container logged metadata can be.
 * @param value - untrusted durable metadata.
 * @returns whether the value can carry record fields.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one non-empty string field from a record.
 * @param value - untrusted field value.
 * @returns the string, or undefined when it is empty or not a string.
 */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Validate and brand one suggested task record.
 * @param meta - untrusted metadata carrying the suggested discriminator.
 * @returns the suggested record, or undefined when any displayed field is invalid.
 */
function suggestedMetaOf(meta: Record<string, unknown>): FollowUpTaskSuggestedMeta | undefined {
  const taskId = textOf(meta.taskId)
  const sessionId = textOf(meta.sessionId)
  const title = textOf(meta.title)
  const summary = textOf(meta.summary)
  const prompt = textOf(meta.prompt)
  if (taskId === undefined || sessionId === undefined || title === undefined
    || summary === undefined || prompt === undefined) return undefined
  return {
    type: 'follow-up-task.suggested',
    taskId: ToolCallId(taskId),
    sessionId: SessionId(sessionId),
    title,
    summary,
    prompt,
  }
}

/**
 * Validate and brand one dismissed task record.
 * @param meta - untrusted metadata carrying the dismissed discriminator.
 * @returns the dismissed record, or undefined when `taskId` is invalid.
 */
function dismissedMetaOf(meta: Record<string, unknown>): FollowUpTaskDismissedMeta | undefined {
  const taskId = textOf(meta.taskId)
  if (taskId === undefined) return undefined
  return { type: 'follow-up-task.dismissed', taskId: ToolCallId(taskId) }
}

/**
 * Read the follow-up task record carried by one logged tool result.
 * @param event - durable event from Session history.
 * @returns the validated and branded record, or undefined for unrelated events and malformed metadata.
 */
export function followUpTaskMetaOf(event: { readonly type: string; readonly data: unknown }): FollowUpTaskMeta | undefined {
  if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') return undefined
  const data = event.data
  if (!isRecord(data)) return undefined
  const meta = data.meta
  if (!isRecord(meta)) return undefined
  if (meta.type === 'follow-up-task.suggested') return suggestedMetaOf(meta)
  if (meta.type === 'follow-up-task.dismissed') return dismissedMetaOf(meta)
  return undefined
}
