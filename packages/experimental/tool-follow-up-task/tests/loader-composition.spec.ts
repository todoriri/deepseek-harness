/**
 * `cordis.patch.yml` through the real Cordis Loader: both tool rows mount, the
 * patch's deployment config reaches the tool, invalid config fails at load, and
 * disposing the tool row's Loader entry removes both tools and the projection.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as ToolFollowUpTask from '../src/index.ts'

const BIN_NAME = 'follow-up-task-test'
const TOOL_PACKAGE = '@deepseek-ai/dsh-experimental-tool-follow-up-task'
const CLIENT_PACKAGE = '@deepseek-ai/dsh-experimental-client-ui-follow-up-task'

const SUGGEST_TOOL_NAME = 'suggest_follow_up_task'
const DISMISS_TOOL_NAME = 'dismiss_follow_up_task'

const ARGS = { title: 'Task', summary: 'Summary.', prompt: 'Do it.' }

const CAP_REFUSAL = 'At most 1 follow-up tasks can be suggested per turn; keep only the most valuable ones.'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Options for {@link boot}. */
interface BootOptions {
  /** Deployment cap patched onto the tool row; omitted leaves the Config default. */
  readonly maxSuggestionsPerTurn?: number
}

/**
 * Load the client card package's Host half. The host aggregate excludes the
 * client package's source project, so the specifier stays a runtime value
 * instead of a statically resolved import.
 * @returns the Host plugin module.
 */
function clientHostHalf(): Promise<unknown> {
  const specifier = '@deepseek-ai/dsh-experimental-client-ui-follow-up-task'
  return import(specifier)
}

/**
 * Route the patch's bare package names through the Loader's `cordis:` builtins,
 * so the test resolves the plugins from source imports instead of built `lib/`
 * artifacts.
 * @param patches - the package patch list as loaded.
 * @returns the same patches with inserted row names prefixed.
 */
function sourcePlanePatches(patches: readonly PatchOptions[]): PatchOptions[] {
  return patches.map(patch => patch.insert === undefined ? { ...patch } : {
    ...patch,
    insert: patch.insert.map(entry => entry.name === undefined
      ? entry
      : { ...entry, name: `cordis:${entry.name}` }),
  })
}

/**
 * Boot one temp `cordis.yml` with the services the tools need, then mount this
 * package's own `cordis.patch.yml` through the Loader's patch mechanism.
 * @param options - row config patched after the package patch.
 * @returns the booted context.
 */
async function boot(options: BootOptions = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-follow-up-task-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'cordis:@deepseek-ai/dsh-agent'",
    "- name: 'cordis:@deepseek-ai/dsh-session'",
    "- name: 'cordis:@deepseek-ai/dsh-session-projection'",
    "- name: 'cordis:@deepseek-ai/dsh-system-prompt'",
    "- name: 'cordis:@deepseek-ai/dsh-tools'",
    '',
  ].join('\n'))
  const patches = [
    ...sourcePlanePatches(loadOverlayPatches(BIN_NAME, fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))),
    ...options.maxSuggestionsPerTurn === undefined ? [] : [{
      id: 'tool-follow-up-task',
      config: { maxSuggestionsPerTurn: options.maxSuggestionsPerTurn },
    }],
  ]

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const clientModule = await clientHostHalf()
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    [TOOL_PACKAGE, ToolFollowUpTask],
    [CLIENT_PACKAGE, clientModule],
  ])
  for (const [specifier, plugin] of modules) ctx.loader.builtins[specifier] = plugin
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href, patches },
  })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

/** Register one idle top-level Agent over a store-owned Session. */
async function createAgent(ctx: Context): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const id = SessionId('follow-up-task-loader-agent')
  const session = ctx.sessions.create(id)
  const value: Agent = {
    id,
    options: {},
    session,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

/** Execute one tool call through the step admission and the composed runtime. */
async function executeCall(
  ctx: Context,
  agent: Agent,
  name: string,
  callId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'test', model: 'test' }, signal })
  try {
    return await executeToolFixture(ctx, {
      name,
      callId: ToolCallId(callId),
      arguments: args,
      signal,
      agent,
      toolSet,
    })
  } finally {
    toolSet.dispose()
  }
}

describe('follow-up task tools through real Loader composition', () => {
  it('mounts both tools and loads the client card package host half', async () => {
    const ctx = await boot()
    expect(ctx.tools.schemas().map(schema => schema.name))
      .toEqual(expect.arrayContaining([SUGGEST_TOOL_NAME, DISMISS_TOOL_NAME]))
    const clientEntry = [...ctx.loader.entries()]
      .find(entry => entry.options.id === 'client-ui-follow-up-task')
    expect(clientEntry?.fiber).toBeDefined()
    expect(clientEntry?.disabled).toBe(false)
  })

  it('passes maxSuggestionsPerTurn from the patch row config to the tool', async () => {
    const ctx = await boot({ maxSuggestionsPerTurn: 1 })
    const agent = await createAgent(ctx)
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('call-1'), name: SUGGEST_TOOL_NAME, arguments: '{}',
    })
    agent.session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('call-2'), name: SUGGEST_TOOL_NAME, arguments: '{}',
    })
    const first = await executeCall(ctx, agent, SUGGEST_TOOL_NAME, 'call-1', ARGS)
    expect(first.isError).toBe(false)
    const second = await executeCall(ctx, agent, SUGGEST_TOOL_NAME, 'call-2', ARGS)
    expect(second.isError).toBe(true)
    if (!second.isError) throw new Error('expected the cap refusal')
    expect(second.error.message).toBe(CAP_REFUSAL)
  })

  it('fails at load when maxSuggestionsPerTurn is 0', async () => {
    await expect(boot({ maxSuggestionsPerTurn: 0 }))
      .rejects.toThrow('$.maxSuggestionsPerTurn expected number >= 1 but got 0')
  })

  it('unregisters both tools and the projection when the tool row disposes', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx)
    expect(ctx.sessionProjections.checkpoint(agent.session)).toHaveProperty('followUpTasks')
    const entry = [...ctx.loader.entries()]
      .find(candidate => candidate.options.id === 'tool-follow-up-task')
    expect(entry?.fiber).toBeDefined()
    await entry!.fiber!.dispose()
    expect(ctx.tools.get(SUGGEST_TOOL_NAME)).toBeUndefined()
    expect(ctx.tools.get(DISMISS_TOOL_NAME)).toBeUndefined()
    expect(ctx.sessionProjections.checkpoint(ctx.sessions.create())).not.toHaveProperty('followUpTasks')
  })
})
