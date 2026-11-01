/**
 * The `followUpTasks` Session projection: the suggest calls recorded in the
 * open turn and the identity of every successful suggestion in this Session,
 * in log order. The tools read this fold instead of scanning Session history.
 * @module @deepseek-ai/dsh-experimental-tool-follow-up-task/projection
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
// Type-only: resolves the `tool/ptc-dispatch*` Session event declarations.
import type {} from '@deepseek-ai/dsh-tools/types'
import type { FollowUpTaskSuggestedMeta } from './contract.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    followUpTasks: FollowUpTasksState
  }
}

/**
 * Host-only fold state of the `followUpTasks` projection. Neither field is
 * served to clients; the Web card reads the delivered tool events.
 */
export interface FollowUpTasksState {
  /** Call ids of suggest calls in the open turn, in log order; null outside a turn. */
  readonly openTurnCalls: readonly string[] | null
  /** taskIds of every successful suggestion in this Session, in log order. */
  readonly suggested: readonly string[]
}

/**
 * The model-facing name of the suggesting tool. The fold recognizes suggest
 * calls by this exact name, and the tool registration uses the same constant.
 */
export const SUGGEST_TOOL_NAME = 'suggest_follow_up_task'

/** Metadata `type` discriminator of one successful suggestion. */
const SUGGESTED_META_TYPE = 'follow-up-task.suggested'

/** Fields a suggested-metadata record must carry as non-empty strings. */
const SUGGESTED_META_TEXT_FIELDS = ['taskId', 'sessionId', 'title', 'summary', 'prompt'] as const

const followUpTasksStateSchema: ZodType<FollowUpTasksState> = zod.object({
  openTurnCalls: zod.array(zod.string()).nullable(),
  suggested: zod.array(zod.string()),
})

/**
 * Whether `value` is a non-array object, the only container logged metadata
 * can be.
 * @param value - untrusted durable metadata.
 * @returns whether the value can carry record fields.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether `value` is a complete {@link FollowUpTaskSuggestedMeta} record.
 * Logged metadata is durable untrusted data, so every field the card displays
 * or starts from is checked before the fold accepts it.
 * @param value - `tool/result` or `tool/ptc-dispatch` metadata.
 * @returns whether the value is suggested metadata carrying five non-empty strings.
 */
export function isSuggestedMeta(value: unknown): value is FollowUpTaskSuggestedMeta {
  if (!isRecord(value)) return false
  if (value.type !== SUGGESTED_META_TYPE) return false
  return SUGGESTED_META_TEXT_FIELDS.every(field => typeof value[field] === 'string' && value[field] !== '')
}

/**
 * Append one suggest call id to the open turn when a turn is open.
 * @param state - current fold state.
 * @param callId - native call id or PTC sub-call id.
 * @returns the next state, or the same reference outside a turn.
 */
function appendOpenTurnCall(state: FollowUpTasksState, callId: string): FollowUpTasksState {
  if (state.openTurnCalls === null) return state
  return { openTurnCalls: [...state.openTurnCalls, callId], suggested: state.suggested }
}

/**
 * Record one successful suggestion's task id, keeping the open-turn list.
 * @param state - current fold state.
 * @param taskId - the suggesting call id carried by validated metadata.
 * @returns the next state.
 */
function appendSuggestion(state: FollowUpTasksState, taskId: string): FollowUpTasksState {
  return { openTurnCalls: state.openTurnCalls, suggested: [...state.suggested, taskId] }
}

/**
 * The `followUpTasks` projection unit registered by this package. Call ids fill
 * the open turn for the per-turn cap; suggested task ids answer the dismiss
 * check without reading Session history. Every event that changes nothing
 * returns the same state reference.
 */
export const followUpTasksProjection = {
  key: 'followUpTasks',
  stateVersion: 1,
  stateSchema: followUpTasksStateSchema,
  init: () => ({ openTurnCalls: null, suggested: [] }),
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        return { openTurnCalls: [], suggested: state.suggested }
      case 'turn/end':
        return state.openTurnCalls === null ? state : { openTurnCalls: null, suggested: state.suggested }
      case 'tool/call':
        return event.data.name === SUGGEST_TOOL_NAME ? appendOpenTurnCall(state, event.data.callId) : state
      case 'tool/ptc-dispatch-start':
        return event.data.name === SUGGEST_TOOL_NAME ? appendOpenTurnCall(state, event.data.subCallId) : state
      case 'tool/result':
        return isSuggestedMeta(event.data.meta) ? appendSuggestion(state, event.data.meta.taskId) : state
      case 'tool/ptc-dispatch':
        return isSuggestedMeta(event.data.meta) ? appendSuggestion(state, event.data.meta.taskId) : state
      default:
        return state
    }
  },
} satisfies ProjectionDefinition<'followUpTasks', FollowUpTasksState>
