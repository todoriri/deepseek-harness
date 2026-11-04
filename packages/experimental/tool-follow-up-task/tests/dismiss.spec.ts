/**
 * `dismiss_follow_up_task` behavior: registration shape, withdrawn result text
 * and metadata, and the refusal order (no agent, subagent, missing projection,
 * unknown task).
 */

import { describe, expect, it } from 'vitest'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { executeCall, harness, SUGGEST_TOOL_NAME } from './harness.ts'
import type { Bench } from './harness.ts'

const DISMISS_TOOL_NAME = 'dismiss_follow_up_task'

const DESCRIPTION = 'Withdraw a follow-up task you suggested earlier in this session when it is no longer needed, for example because it was done here or a better suggestion replaced it. Pass the `taskId` that suggest_follow_up_task returned. A session the user already started is not affected.'

const TASK_ID_DESCRIPTION = 'The taskId returned by suggest_follow_up_task.'

const AGENTLESS_REFUSAL = 'dismiss_follow_up_task requires a calling agent.'

const SUBAGENT_REFUSAL = 'Only the top-level agent can dismiss follow-up tasks.'


/** Build one complete suggestion record for a logged result. */
function suggestedMeta(taskId: ToolCallId) {
  return {
    type: 'follow-up-task.suggested' as const,
    taskId,
    sessionId: SessionId(`session-${taskId}`),
    title: `Task ${taskId}`,
    summary: `Summary for ${taskId}.`,
    prompt: `Do ${taskId}.`,
  }
}

/** Append one settled native suggest result carrying suggested metadata. */
function appendSuggestedResult(bench: Bench, taskId: ToolCallId): void {
  bench.session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: taskId,
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }),
    meta: suggestedMeta(taskId),
  }, { surfaceOp: 'append' })
}

/** Append one settled PTC suggest sub-call carrying suggested metadata. */
function appendSuggestedDispatch(bench: Bench, taskId: ToolCallId): void {
  bench.session.append('tool/ptc-dispatch', {
    rootCallId: ToolCallId('run-code'),
    parentCallId: ToolCallId('run-code'),
    subCallId: taskId,
    name: SUGGEST_TOOL_NAME,
    arguments: {},
    isError: false,
    content: [{ type: 'text', text: 'ok' }],
    meta: suggestedMeta(taskId),
  })
}

/** Read the canonical output of one successful execution. */
function valueOf(result: ToolExecutionResult): { taskId: string } {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error(`expected success: ${result.error.message}`)
  return result.value as { taskId: string }
}

/** Read the model-facing refusal of one failed execution. */
function refusalOf(result: ToolExecutionResult): string {
  expect(result.isError).toBe(true)
  if (!result.isError) throw new Error('expected a refusal')
  return result.error.message
}

describe('dismiss_follow_up_task', () => {
  it('registers the tool with the verbatim description and a required taskId', async () => {
    const bench = await harness()
    const definition = bench.ctx.tools.get(DISMISS_TOOL_NAME, bench.agent)
    expect(definition).toBeDefined()
    if (definition === undefined) throw new Error('dismiss_follow_up_task is not registered')
    expect(definition.description).toBe(DESCRIPTION)
    const parameters = definition.parameters as {
      properties: Record<string, { type?: string; description?: string }>
      required?: string[]
    }
    expect(parameters.required).toEqual(['taskId'])
    expect(parameters.properties.taskId).toEqual({ type: 'string', description: TASK_ID_DESCRIPTION })
  })

  it('dismisses a task whose suggestion result is logged', async () => {
    const bench = await harness()
    appendSuggestedResult(bench, ToolCallId('call-1'))
    const result = await executeCall(bench, DISMISS_TOOL_NAME, ToolCallId('call-2'), { taskId: 'call-1' })
    expect(valueOf(result)).toEqual({ taskId: 'call-1' })
    expect(result.content).toEqual([{ type: 'text', text: 'Follow-up task call-1 is withdrawn.' }])
    expect(result.meta).toEqual({ type: 'follow-up-task.dismissed', taskId: 'call-1' })
  })

  it('dismisses a task suggested through PTC', async () => {
    const bench = await harness()
    appendSuggestedDispatch(bench, ToolCallId('call-1:ptc:0'))
    const result = await executeCall(bench, DISMISS_TOOL_NAME, ToolCallId('call-2'), { taskId: 'call-1:ptc:0' })
    expect(valueOf(result)).toEqual({ taskId: 'call-1:ptc:0' })
    expect(result.meta).toEqual({ type: 'follow-up-task.dismissed', taskId: 'call-1:ptc:0' })
  })

  it('refuses a taskId that was never suggested', async () => {
    const bench = await harness()
    appendSuggestedResult(bench, ToolCallId('call-1'))
    const result = await executeCall(bench, DISMISS_TOOL_NAME, ToolCallId('call-2'), { taskId: 'call-9' })
    expect(refusalOf(result)).toBe('No follow-up task with taskId call-9 was suggested in this session.')
  })

  it('refuses a call without an agent', async () => {
    const bench = await harness()
    const result = await executeCall(bench, DISMISS_TOOL_NAME, ToolCallId('call-1'), { taskId: 'call-1' }, null)
    expect(refusalOf(result)).toBe(AGENTLESS_REFUSAL)
  })

  it('refuses a subagent caller', async () => {
    const bench = await harness({ agentOptions: { subagentDepth: 1 } })
    const result = await executeCall(bench, DISMISS_TOOL_NAME, ToolCallId('call-1'), { taskId: 'call-1' })
    expect(refusalOf(result)).toBe(SUBAGENT_REFUSAL)
  })

  it('succeeds when the same task is dismissed twice', async () => {
    const bench = await harness()
    appendSuggestedResult(bench, ToolCallId('call-1'))
    const first = await executeCall(bench, DISMISS_TOOL_NAME, ToolCallId('call-2'), { taskId: 'call-1' })
    const second = await executeCall(bench, DISMISS_TOOL_NAME, ToolCallId('call-3'), { taskId: 'call-1' })
    expect(valueOf(first)).toEqual({ taskId: 'call-1' })
    expect(valueOf(second)).toEqual({ taskId: 'call-1' })
    expect(second.content).toEqual([{ type: 'text', text: 'Follow-up task call-1 is withdrawn.' }])
  })

  it('presents the pending call as the generic card', async () => {
    const bench = await harness()
    const definition = bench.ctx.tools.get(DISMISS_TOOL_NAME, bench.agent)
    if (definition === undefined) throw new Error('dismiss_follow_up_task is not registered')
    const args = { taskId: 'call-1' }
    expect(definition.presentCall?.(args)).toEqual({
      card: 'generic',
      title: 'Dismiss follow-up task',
      kind: 'other',
      rawInput: args,
    })
  })
})
