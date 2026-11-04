/**
 * Shared Host harness for the follow-up task tools: a real Session, a stub
 * Agent whose scope owns the tool lookup, the tool and projection registries,
 * and execution through the tool runtime.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { Config } from '../src/index.ts'
import * as ToolFollowUpTask from '../src/index.ts'
import { SUGGEST_TOOL_NAME } from '../src/projection.ts'

/** One booted Host bench with its mounted plugin fiber. */
export interface Bench {
  /** Host context carrying the services and the mounted plugin. */
  readonly ctx: Context
  /** Real Session the calls execute against. */
  readonly session: Session
  /** Stub Agent whose session and scope the tools see. */
  readonly agent: Agent
  /** Mounted plugin fiber; disposing it unregisters the tools and the projection. */
  readonly fiber: Fiber
}

/** Options for {@link harness}. */
export interface HarnessOptions {
  /** Explicit per-turn cap; omitted mounts the plugin at the Config default. */
  readonly maxSuggestionsPerTurn?: number
  /** Extra Agent options copied onto the stub Agent, such as `subagentDepth`. */
  readonly agentOptions?: AgentOptions
}

/**
 * Build one stub Agent with a real createScope-backed context.
 * @param ctx - Host context already carrying the `tools` service.
 * @param session - real Session the Agent owns.
 * @param options - Agent route and delegation options.
 * @returns the registered stub Agent.
 */
async function stubAgent(ctx: Context, session: Session, options: AgentOptions): Promise<Agent> {
  let scope: Scope
  const value: Agent = {
    id: session.id,
    options,
    session,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'idle',
    get ctx() { return scope.ctx },
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, value) }, { inject: ['tools'] }))
  await ctx.agents.register(value)
  return value
}

/**
 * Boot the Host services, mount the plugin, and create the Session and Agent.
 * @param options - explicit cap and Agent options.
 * @returns the booted bench.
 */
export async function harness(options: HarnessOptions = {}): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  const config: Config = { maxSuggestionsPerTurn: options.maxSuggestionsPerTurn ?? 3 }
  const fiber = await ctx.plugin(ToolFollowUpTask, config)
  const session = ctx.sessions.create()
  const agent = await stubAgent(ctx, session, options.agentOptions ?? {})
  return { ctx, session, agent, fiber }
}

/**
 * Execute one tool call through the runtime.
 * @param bench - booted Host bench.
 * @param name - registered tool name.
 * @param callId - call identity used for the per-turn position and the result.
 * @param args - model-supplied arguments.
 * @param agent - calling Agent; `null` dispatches without one.
 * @returns the normalized execution result.
 */
export function executeCall(
  bench: Bench,
  name: string,
  callId: ToolCallId,
  args: Record<string, unknown>,
  agent: Agent | null = bench.agent,
): Promise<ToolExecutionResult> {
  return executeToolFixture(bench.ctx, {
    callId,
    name,
    arguments: args,
    signal: new AbortController().signal,
    ...agent === null ? {} : { agent },
  })
}

/** The registered suggest-tool name, re-exported for the specs. */
export { SUGGEST_TOOL_NAME }
