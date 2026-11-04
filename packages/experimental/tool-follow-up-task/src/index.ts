/**
 * Model-facing `suggest_follow_up_task` and `dismiss_follow_up_task` tools.
 * A suggestion reserves a Session identity and records a card the user may
 * start later; nothing runs until the user starts it.
 * @module @deepseek-ai/dsh-experimental-tool-follow-up-task
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
// Type-only: resolves the required ctx.sessionProjections service declaration.
import type {} from '@deepseek-ai/dsh-session-projection'
import { followUpTasksProjection, SUGGEST_TOOL_NAME } from './projection.ts'
import type { FollowUpTaskDismissedMeta, FollowUpTaskSuggestedMeta } from './contract.ts'

export type * from './contract.ts'

/** Cordis plugin name. */
export const name = 'tool-follow-up-task'
/** Services required to register the follow-up task tools. */
export const inject = ['tools', 'sessionProjections']

/** Deployment configuration of the follow-up task tools. */
export interface Config {
  /** Most `suggest_follow_up_task` calls one turn may make; later calls in that turn fail. */
  maxSuggestionsPerTurn: number
}

/** Schemastery configuration for the follow-up task tools. */
export const Config: z<Config> = z.object({
  maxSuggestionsPerTurn: z.natural().min(1).default(3)
    .description('Most suggest_follow_up_task calls one turn may make; later calls in that turn fail.'),
})

const DESCRIPTION = 'Offer the user a follow-up task that they can start later as a new session. Use it for worthwhile work you notice outside the current request, such as a bug found in passing, missing test coverage, stale documentation, or a confirmed TODO, instead of doing that work now or only mentioning it. Do not use it for work the current request needs, for small fixes you can finish now, or for speculative ideas. Nothing runs unless the user starts the task; the user sees `title` and `summary` and reviews `prompt` before sending it. The new session cannot see this conversation, so `prompt` must stand alone: state the goal, the relevant file paths, what you observed, and how to verify the result.'

const TITLE_DESCRIPTION = 'Imperative label of at most about 60 characters, such as "Fix the stale config example in README".'

const SUMMARY_DESCRIPTION = 'One or two plain-text sentences for the user, without Markdown: what you noticed and what the task will do.'

const PROMPT_DESCRIPTION = 'Complete instructions for the agent in the new session, which cannot see this conversation.'

const DISMISS_DESCRIPTION = 'Withdraw a follow-up task you suggested earlier in this session when it is no longer needed, for example because it was done here or a better suggestion replaced it. Pass the `taskId` that suggest_follow_up_task returned. A session the user already started is not affected.'

const TASK_ID_DESCRIPTION = 'The taskId returned by suggest_follow_up_task.'

/** Refusal when the call has no owning Agent. */
const AGENTLESS_REFUSAL = 'suggest_follow_up_task requires a calling agent.'

/** Refusal when a delegated subagent calls the tool. */
const SUBAGENT_REFUSAL = 'Only the top-level agent can suggest follow-up tasks; report this follow-up to your parent agent instead.'

/** Refusal when the dismiss call has no owning Agent. */
const DISMISS_AGENTLESS_REFUSAL = 'dismiss_follow_up_task requires a calling agent.'

/** Refusal when a delegated subagent calls the dismiss tool. */
const DISMISS_SUBAGENT_REFUSAL = 'Only the top-level agent can dismiss follow-up tasks.'

/**
 * Refusal text for one empty task field.
 * @param field - the empty parameter name.
 * @returns the model-facing refusal message.
 */
function emptyFieldRefusal(field: string): string {
  return `${field} must not be empty.`
}

/**
 * Refusal text for one call past the per-turn cap.
 * @param max - the configured maximum for one turn.
 * @returns the model-facing refusal message.
 */
function capRefusal(max: number): string {
  return `At most ${max} follow-up tasks can be suggested per turn; keep only the most valuable ones.`
}

/**
 * Refusal text for one task id that this Session never recorded.
 * @param taskId - the unrecognized task id.
 * @returns the model-facing refusal message.
 */
function unknownTaskRefusal(taskId: string): string {
  return `No follow-up task with taskId ${taskId} was suggested in this session.`
}

/**
 * Register the follow-up task tools and the `followUpTasks` projection in the
 * mounting scope.
 * @param ctx - tool and session-projection registry scope.
 * @param config - deployment's per-turn suggestion limit.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const projection = await ctx.sessionProjections.register(followUpTasksProjection)
  ctx.tools.register(defineTool({
    name: SUGGEST_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      title: { type: 'string', required: true, description: TITLE_DESCRIPTION },
      summary: { type: 'string', required: true, description: SUMMARY_DESCRIPTION },
      prompt: { type: 'string', required: true, description: PROMPT_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Follow-up task ${value.taskId} is shown to the user and starts only if they choose to. Continue with the current request.`,
      }],
      presentationMeta: (args, value) => ({
        type: 'follow-up-task.suggested',
        taskId: ToolCallId(value.taskId),
        sessionId: SessionId(value.sessionId),
        title: args.title.trim(),
        summary: args.summary.trim(),
        prompt: args.prompt.trim(),
      } satisfies FollowUpTaskSuggestedMeta),
    },
    presentCall: args => ({ card: 'generic', title: 'Suggest follow-up task', kind: 'other', rawInput: args }),
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error(AGENTLESS_REFUSAL)
      if (delegationDepthOf(agent) > 0) throw new Error(SUBAGENT_REFUSAL)
      const title = args.title.trim()
      if (title.length === 0) throw new Error(emptyFieldRefusal('title'))
      const summary = args.summary.trim()
      if (summary.length === 0) throw new Error(emptyFieldRefusal('summary'))
      const prompt = args.prompt.trim()
      if (prompt.length === 0) throw new Error(emptyFieldRefusal('prompt'))
      const state = projection.stateOf(agent.session)
      if (state.openTurnCalls !== null) {
        const index = state.openTurnCalls.indexOf(exec.callId)
        const position = index === -1 ? state.openTurnCalls.length + 1 : index + 1
        if (position > config.maxSuggestionsPerTurn) throw new Error(capRefusal(config.maxSuggestionsPerTurn))
      }
      return Promise.resolve({ taskId: exec.callId, sessionId: SessionId(`session-${randomUUID()}`) })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'dismiss_follow_up_task',
    description: DISMISS_DESCRIPTION,
    parameters: {
      taskId: { type: 'string', required: true, description: TASK_ID_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Follow-up task ${value.taskId} is withdrawn.`,
      }],
      presentationMeta: (_args, value) => ({
        type: 'follow-up-task.dismissed',
        taskId: ToolCallId(value.taskId),
      } satisfies FollowUpTaskDismissedMeta),
    },
    presentCall: args => ({ card: 'generic', title: 'Dismiss follow-up task', kind: 'other', rawInput: args }),
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error(DISMISS_AGENTLESS_REFUSAL)
      if (delegationDepthOf(agent) > 0) throw new Error(DISMISS_SUBAGENT_REFUSAL)
      const state = projection.stateOf(agent.session)
      if (!state.suggested.includes(args.taskId)) throw new Error(unknownTaskRefusal(args.taskId))
      return Promise.resolve({ taskId: args.taskId })
    },
  }))
}
