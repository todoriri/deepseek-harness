/**
 * `followUpTaskDefinition` turns one logged suggestion and its optional
 * withdrawal into one hidden turn-tail Chat node.
 */

import { describe, expect, it } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  ConversationContextReader,
  ConversationLocation,
  ConversationMatch,
  ConversationNodeContext,
  ConversationStartMatch,
  ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { followUpTaskDefinition } from '../src/client/definition.ts'
import type { FollowUpTaskNodeState } from '../src/client/definition.ts'

const LOCATION: ConversationLocation = { kind: 'unresolved' }

/** One complete suggestion record. */
function suggestedMeta() {
  return {
    type: 'follow-up-task.suggested' as const,
    taskId: ToolCallId('call-1'),
    sessionId: SessionId('session-1'),
    title: 'Title',
    summary: 'Summary.',
    prompt: 'Prompt.',
  }
}

/** One complete dismissal record. */
function dismissedMeta() {
  return { type: 'follow-up-task.dismissed' as const, taskId: ToolCallId('call-1') }
}

/** One settled native tool result carrying optional presentation metadata. */
function resultEvent(seq: number, meta?: JsonValue): SessionEvent<'tool/result'> {
  return {
    type: 'tool/result',
    seq: SessionSeq(seq),
    time: 1_700_000_000_000 + seq,
    data: {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('call-1'),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
      ...meta === undefined ? {} : { meta },
    },
    surfaceOp: 'append',
  }
}

/** One start match for a settled tool result. */
function startMatch(event: SessionEvent): ConversationStartMatch {
  return { event, role: 'start', location: LOCATION }
}

/** One update match for a settled tool result. */
function updateMatch(event: SessionEvent): ConversationMatch {
  return { event, role: 'update', location: LOCATION }
}

/** A Conversation node context with no matches unless overridden. */
function context(
  overrides: Partial<ConversationNodeContext<FollowUpTaskNodeState>> = {},
): ConversationNodeContext<FollowUpTaskNodeState> {
  return {
    key: 'follow-up-task:context',
    kind: 'follow-up-task',
    id: 'call-1',
    matches: [],
    start: undefined,
    state: undefined,
    current: new Map<string, ConversationViewNode | null>(),
    ...overrides,
  }
}

const reader: ConversationContextReader = { previous: () => undefined }

describe('followUpTaskDefinition', () => {
  it('matches a suggestion as start and a dismissal as update under the same taskId', () => {
    expect(followUpTaskDefinition.match(resultEvent(3, suggestedMeta())))
      .toEqual({ id: 'call-1', role: 'start' })
    expect(followUpTaskDefinition.match(resultEvent(9, dismissedMeta())))
      .toEqual({ id: 'call-1', role: 'update' })
    const unrelated: SessionEvent<'turn/start'> = {
      type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 },
    }
    expect(followUpTaskDefinition.match(unrelated)).toBeNull()
  })

  it('marks the task withdrawn on a dismissal and keeps state for a later suggestion', () => {
    const task = suggestedMeta()
    const start = startMatch(resultEvent(3, task))
    const state: FollowUpTaskNodeState = { task, withdrawn: false }
    const initial = context({ start, matches: [start], state })
    const withdrawn = followUpTaskDefinition.update(
      { ...initial, state },
      updateMatch(resultEvent(9, dismissedMeta())),
    )
    expect(withdrawn).toEqual({ task, withdrawn: true })
    expect(followUpTaskDefinition.update(
      { ...initial, state: withdrawn },
      startMatch(resultEvent(12, suggestedMeta())),
    )).toBe(withdrawn)
    expect(followUpTaskDefinition.update({ ...initial, state }, updateMatch(resultEvent(15))))
      .toBe(state)
  })

  it('builds one hidden chat node anchored at the suggesting event', () => {
    const task = suggestedMeta()
    const start = startMatch(resultEvent(3, task))
    const state = followUpTaskDefinition.start(context(), start, reader)
    expect(state).toEqual({ task, withdrawn: false })
    expect(followUpTaskDefinition.buildViewNode!(context({ start, matches: [start], state })))
      .toEqual({
        key: 'follow-up-task:context',
        kind: 'follow-up-task',
        id: 'call-1',
        target: 'chat',
        anchorSeq: 3,
        location: LOCATION,
        visibility: 'hidden',
        data: state,
      })
  })

  it('builds nothing when only a dismissal is loaded', () => {
    const dismissal = updateMatch(resultEvent(9, dismissedMeta()))
    expect(followUpTaskDefinition.buildViewNode!(context({ matches: [dismissal] }))).toBeNull()
    expect(followUpTaskDefinition.buildViewNode!(context({
      state: { task: suggestedMeta(), withdrawn: false },
    }))).toBeNull()
  })
})
