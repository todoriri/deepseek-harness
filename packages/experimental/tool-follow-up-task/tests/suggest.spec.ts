/**
 * `suggest_follow_up_task` behavior: registration shape, reserved session
 * identities, trimmed presentation metadata, and the refusal order (no agent,
 * subagent, empty field, per-turn cap).
 */

import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/index.ts'
import { executeCall, harness, SUGGEST_TOOL_NAME } from './harness.ts'
import type { Bench } from './harness.ts'

const DESCRIPTION = 'Offer the user a follow-up task that they can start later as a new session. Use it for worthwhile work you notice outside the current request, such as a bug found in passing, missing test coverage, stale documentation, or a confirmed TODO, instead of doing that work now. Do not use it for work the current request needs, for small fixes you can finish now, or for speculative ideas. Nothing runs unless the user starts the task; the user sees `title` and `summary` and reviews `prompt` before sending it. The new session cannot see this conversation, so `prompt` must stand alone: state the goal, the relevant file paths, what you observed, and how to verify the result.'

const TITLE_DESCRIPTION = 'Imperative label of at most about 60 characters, such as "Fix the stale config example in README".'

const SUMMARY_DESCRIPTION = 'One or two plain-text sentences for the user, without Markdown: what you noticed and what the task will do.'

const PROMPT_DESCRIPTION = 'Complete instructions for the agent in the new session, which cannot see this conversation.'

const AGENTLESS_REFUSAL = 'suggest_follow_up_task requires a calling agent.'

const SUBAGENT_REFUSAL = 'Only the top-level agent can suggest follow-up tasks; report this follow-up to your parent agent instead.'


const ARGS = {
  title: 'Fix the stale config example in README',
  summary: 'The config example no longer matches the loader.',
  prompt: 'Fix the stale config example in README and verify the snippet still works.',
}

/** Open one turn in the Session log. */
function startTurn(bench: Bench): void {
  bench.session.append('turn/start', { turn: 1 })
}

/** Append one logged suggest call to the open turn. */
function logSuggestCall(bench: Bench, callId: ToolCallId): void {
  bench.session.append('tool/call', { turn: 1, step: 1, callId, name: SUGGEST_TOOL_NAME, arguments: '{}' })
}

/** Read the canonical output of one successful execution. */
function valueOf(result: ToolExecutionResult): { taskId: string; sessionId: string } {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error(`expected success: ${result.error.message}`)
  return result.value as { taskId: string; sessionId: string }
}

/** Read the model-facing refusal of one failed execution. */
function refusalOf(result: ToolExecutionResult): string {
  expect(result.isError).toBe(true)
  if (!result.isError) throw new Error('expected a refusal')
  return result.error.message
}

/** The cap refusal text for one configured maximum. */
function capRefusal(max: number): string {
  return `At most ${max} follow-up tasks can be suggested per turn; keep only the most valuable ones.`
}

describe('suggest_follow_up_task', () => {
  it('registers the tool with the verbatim description and three required string parameters', async () => {
    const bench = await harness()
    const definition = bench.ctx.tools.get(SUGGEST_TOOL_NAME, bench.agent)
    expect(definition).toBeDefined()
    if (definition === undefined) throw new Error('suggest_follow_up_task is not registered')
    expect(definition.description).toBe(DESCRIPTION)
    const parameters = definition.parameters as {
      properties: Record<string, { type?: string; description?: string }>
      required?: string[]
    }
    expect(parameters.required).toEqual(['title', 'summary', 'prompt'])
    expect(parameters.properties.title).toEqual({ type: 'string', description: TITLE_DESCRIPTION })
    expect(parameters.properties.summary).toEqual({ type: 'string', description: SUMMARY_DESCRIPTION })
    expect(parameters.properties.prompt).toEqual({ type: 'string', description: PROMPT_DESCRIPTION })
  })

  it('returns the call id and a fresh reserved session id for each call', async () => {
    const bench = await harness()
    const first = valueOf(await executeCall(bench, SUGGEST_TOOL_NAME, ToolCallId('call-1'), ARGS))
    expect(first.taskId).toBe('call-1')
    expect(first.sessionId).toMatch(/^session-[0-9a-f-]{36}$/)
    const second = valueOf(await executeCall(bench, SUGGEST_TOOL_NAME, ToolCallId('call-2'), ARGS))
    expect(second.taskId).toBe('call-2')
    expect(second.sessionId).toMatch(/^session-[0-9a-f-]{36}$/)
    expect(second.sessionId).not.toBe(first.sessionId)
  })

  it('renders the verbatim result text', async () => {
    const bench = await harness()
    const result = await executeCall(bench, SUGGEST_TOOL_NAME, ToolCallId('call-1'), ARGS)
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Follow-up task call-1 is shown to the user and starts only if they choose to. Continue with the current request.',
    }])
  })

  it('records trimmed suggested metadata', async () => {
    const bench = await harness()
    const result = await executeCall(bench, SUGGEST_TOOL_NAME, ToolCallId('call-1'), {
      title: '  Title  ',
      summary: '\n Summary. \n',
      prompt: '\tPrompt.\t',
    })
    const value = valueOf(result)
    expect(result.meta).toEqual({
      type: 'follow-up-task.suggested',
      taskId: 'call-1',
      sessionId: value.sessionId,
      title: 'Title',
      summary: 'Summary.',
      prompt: 'Prompt.',
    })
  })

  it('refuses a call without an agent', async () => {
    const bench = await harness()
    const result = await executeCall(bench, SUGGEST_TOOL_NAME, ToolCallId('call-1'), ARGS, null)
    expect(refusalOf(result)).toBe(AGENTLESS_REFUSAL)
  })

  it('refuses a subagent caller', async () => {
    const bench = await harness({ agentOptions: { subagentDepth: 1 } })
    const result = await executeCall(bench, SUGGEST_TOOL_NAME, ToolCallId('call-1'), ARGS)
    expect(refusalOf(result)).toBe(SUBAGENT_REFUSAL)
  })

  it.each(['title', 'summary', 'prompt'] as const)('refuses %s when it is only whitespace', async (field) => {
    const bench = await harness()
    const result = await executeCall(bench, SUGGEST_TOOL_NAME, ToolCallId('call-1'), { ...ARGS, [field]: ' \n\t ' })
    expect(refusalOf(result)).toBe(`${field} must not be empty.`)
  })

  it('refuses the call past maxSuggestionsPerTurn in the open turn', async () => {
    const bench = await harness({ maxSuggestionsPerTurn: 2 })
    startTurn(bench)
    for (const callId of ['call-1', 'call-2', 'call-3']) logSuggestCall(bench, ToolCallId(callId))
    expect(valueOf(await executeCall(bench, SUGGEST_TOOL_NAME, ToolCallId('call-1'), ARGS)).taskId).toBe('call-1')
    expect(valueOf(await executeCall(bench, SUGGEST_TOOL_NAME, ToolCallId('call-2'), ARGS)).taskId).toBe('call-2')
    const third = await executeCall(bench, SUGGEST_TOOL_NAME, ToolCallId('call-3'), ARGS)
    expect(refusalOf(third)).toBe(capRefusal(2))
  })

  it('counts a call that is not in the open turn list as the next position', async () => {
    const bench = await harness({ maxSuggestionsPerTurn: 1 })
    startTurn(bench)
    logSuggestCall(bench, ToolCallId('call-1'))
    const unlisted = await executeCall(bench, SUGGEST_TOOL_NAME, ToolCallId('call-unlisted'), ARGS)
    expect(refusalOf(unlisted)).toBe(capRefusal(1))
    expect(valueOf(await executeCall(bench, SUGGEST_TOOL_NAME, ToolCallId('call-1'), ARGS)).taskId).toBe('call-1')
  })

  it('applies no cap when no turn is open', async () => {
    const bench = await harness({ maxSuggestionsPerTurn: 1 })
    expect(valueOf(await executeCall(bench, SUGGEST_TOOL_NAME, ToolCallId('call-1'), ARGS)).taskId).toBe('call-1')
  })

  it('defaults maxSuggestionsPerTurn to 3 and rejects values below 1', () => {
    expect(Config['~standard'].validate({})).toEqual({ value: { maxSuggestionsPerTurn: 3 } })
    expect(Config({ maxSuggestionsPerTurn: 5 })).toEqual({ maxSuggestionsPerTurn: 5 })
    expect(() => Config({ maxSuggestionsPerTurn: 0 })).toThrow()
    expect(() => Config({ maxSuggestionsPerTurn: 1.5 })).toThrow()
  })

  it('presents the pending call as the generic card', async () => {
    const bench = await harness()
    const definition = bench.ctx.tools.get(SUGGEST_TOOL_NAME, bench.agent)
    if (definition === undefined) throw new Error('suggest_follow_up_task is not registered')
    expect(definition.presentCall?.(ARGS)).toEqual({
      card: 'generic',
      title: 'Suggest follow-up task',
      kind: 'other',
      rawInput: ARGS,
    })
  })

  it('removes the tool and the projection when the plugin fiber unloads', async () => {
    const bench = await harness()
    expect(bench.ctx.tools.get(SUGGEST_TOOL_NAME, bench.agent)).toBeDefined()
    await bench.fiber.dispose()
    expect(bench.ctx.tools.get(SUGGEST_TOOL_NAME, bench.agent)).toBeUndefined()
    expect(bench.ctx.sessionProjections.checkpoint(bench.ctx.sessions.create())).not.toHaveProperty('followUpTasks')
  })
})
