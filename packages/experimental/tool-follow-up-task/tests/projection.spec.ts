/**
 * The `followUpTasks` projection provider: suggest-call positions in the open
 * turn and the identity of every successful suggestion, folded from committed
 * Session events so the tools never scan history. Mounted beside the registry
 * it serves the host-only key; unmounting it removes the key (HMR safety).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as FollowUpTasks from '../src/index.ts'
import { SUGGEST_TOOL_NAME, isSuggestedMeta } from '../src/projection.ts'
import type { FollowUpTasksState } from '../src/projection.ts'

interface Bench {
  ctx: Context
  session: Session
}

/** Boot the registry services and, unless deferred, this package's plugin. */
async function harness(withPlugin = true): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  if (withPlugin) await ctx.plugin(FollowUpTasks)
  const session = ctx.sessions.create()
  await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return { ctx, session }
}

/** Read the host-side fold through the registry's public read face. */
function state(bench: Bench): FollowUpTasksState | undefined {
  return bench.ctx.sessionProjections.stateOf(bench.session, 'followUpTasks')
}

function startTurn(session: Session, turn = 1): void {
  session.append('turn/start', { turn })
}

function endTurn(session: Session, turn = 1): void {
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function callTool(session: Session, callId: ToolCallId, name: string, turn = 1): void {
  session.append('tool/call', { turn, step: 1, callId, name, arguments: '{}' })
}

function startDispatch(session: Session, subCallId: ToolCallId, name: string): void {
  session.append('tool/ptc-dispatch-start', {
    rootCallId: ToolCallId('root'),
    parentCallId: ToolCallId('root'),
    subCallId,
    name,
    arguments: {},
  })
}

function resultMessage(callId: ToolCallId) {
  return createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false })
}

/** Append one settled tool result, optionally carrying presentation metadata. */
function appendResult(session: Session, callId: ToolCallId, meta?: Record<string, string | number>): void {
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: resultMessage(callId),
    ...meta === undefined ? {} : { meta },
  }, { surfaceOp: 'append' })
}

/** Append one settled PTC sub-call result, optionally carrying presentation metadata. */
function appendDispatch(session: Session, subCallId: ToolCallId, meta?: Record<string, string | number>): void {
  session.append('tool/ptc-dispatch', {
    rootCallId: ToolCallId('root'),
    parentCallId: ToolCallId('root'),
    subCallId,
    name: SUGGEST_TOOL_NAME,
    arguments: {},
    isError: false,
    content: [{ type: 'text', text: 'ok' }],
    ...meta === undefined ? {} : { meta },
  })
}

/** One complete suggested record; the return type stays an object literal type so it is JSON-assignable. */
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

/** The five text fields `isSuggestedMeta` requires on a suggested record. */
const TEXT_FIELDS = ['taskId', 'sessionId', 'title', 'summary', 'prompt'] as const

/** Build a metadata record with one field removed, emptied, or replaced. */
function metaWith(field: string, value?: string | number): Record<string, string | number> {
  const meta: Record<string, string | number> = {
    type: 'follow-up-task.suggested',
    taskId: 'task-1',
    sessionId: 'session-1',
    title: 'Title',
    summary: 'Summary.',
    prompt: 'Prompt.',
  }
  if (value === undefined) {
    return Object.fromEntries(Object.entries(meta).filter(([key]) => key !== field))
  }
  meta[field] = value
  return meta
}

describe('followUpTasks projection provider', () => {
  it('starts with no open turn calls and no suggestions', async () => {
    const bench = await harness()
    expect(state(bench)).toEqual({ openTurnCalls: null, suggested: [] })
  })

  it('opens an empty call list on turn/start and closes it on turn/end', async () => {
    const bench = await harness()
    startTurn(bench.session)
    expect(state(bench)).toEqual({ openTurnCalls: [], suggested: [] })
    callTool(bench.session, ToolCallId('call-1'), SUGGEST_TOOL_NAME)
    expect(state(bench)?.openTurnCalls).toEqual(['call-1'])
    endTurn(bench.session)
    expect(state(bench)?.openTurnCalls).toBeNull()
  })

  it('appends native suggest calls to the open turn in log order', async () => {
    const bench = await harness()
    startTurn(bench.session)
    callTool(bench.session, ToolCallId('call-a'), SUGGEST_TOOL_NAME)
    callTool(bench.session, ToolCallId('call-other'), 'read')
    callTool(bench.session, ToolCallId('call-b'), SUGGEST_TOOL_NAME)
    expect(state(bench)?.openTurnCalls).toEqual(['call-a', 'call-b'])
  })

  it('appends PTC suggest dispatches by sub-call id', async () => {
    const bench = await harness()
    startTurn(bench.session)
    startDispatch(bench.session, ToolCallId('root:ptc:0'), SUGGEST_TOOL_NAME)
    startDispatch(bench.session, ToolCallId('root:ptc:1'), 'read')
    expect(state(bench)?.openTurnCalls).toEqual(['root:ptc:0'])
  })

  it('ignores other tools and suggest calls outside an open turn, keeping the state reference', async () => {
    const bench = await harness()
    const initial = state(bench)
    endTurn(bench.session)
    callTool(bench.session, ToolCallId('call-outside'), SUGGEST_TOOL_NAME)
    startDispatch(bench.session, ToolCallId('root:ptc:0'), 'read')
    bench.session.append('step/start', { turn: 1, step: 1 })
    expect(state(bench)).toBe(initial)

    startTurn(bench.session)
    const open = state(bench)
    callTool(bench.session, ToolCallId('call-other'), 'read')
    expect(state(bench)).toBe(open)
  })

  it('records suggested task ids from native results and PTC dispatches', async () => {
    const bench = await harness()
    startTurn(bench.session)
    const nativeCall = ToolCallId('call-native')
    callTool(bench.session, nativeCall, SUGGEST_TOOL_NAME)
    appendResult(bench.session, nativeCall, suggestedMeta(nativeCall))
    const ptcCall = ToolCallId('root:ptc:0')
    startDispatch(bench.session, ptcCall, SUGGEST_TOOL_NAME)
    appendDispatch(bench.session, ptcCall, suggestedMeta(ptcCall))
    expect(state(bench)?.suggested).toEqual([nativeCall, ptcCall])
  })

  it('ignores results and dispatches without suggested meta', async () => {
    const bench = await harness()
    startTurn(bench.session)
    const call = ToolCallId('call-1')
    callTool(bench.session, call, SUGGEST_TOOL_NAME)
    const before = state(bench)

    appendResult(bench.session, call)
    expect(state(bench)).toBe(before)
    appendDispatch(bench.session, call)
    expect(state(bench)).toBe(before)

    appendResult(bench.session, call, { type: 'follow-up-task.dismissed', taskId: call })
    expect(state(bench)).toBe(before)
    for (const field of TEXT_FIELDS) {
      for (const value of [undefined, '', 42] as const) {
        appendResult(bench.session, call, metaWith(field, value))
        expect(state(bench)).toBe(before)
      }
    }
  })

  it('rejects arrays, null, and other non-record values', () => {
    expect(isSuggestedMeta(null)).toBe(false)
    expect(isSuggestedMeta([])).toBe(false)
    expect(isSuggestedMeta('text')).toBe(false)
    expect(isSuggestedMeta(42)).toBe(false)
  })

  it('rejects metadata whose discriminator is not a suggested task', () => {
    expect(isSuggestedMeta({ type: 'follow-up-task.dismissed', taskId: ToolCallId('call-1') })).toBe(false)
  })

  it.each(TEXT_FIELDS)('rejects suggested metadata whose %s is missing, empty, or not a string', (field) => {
    expect(isSuggestedMeta(metaWith(field))).toBe(false)
    expect(isSuggestedMeta(metaWith(field, ''))).toBe(false)
    expect(isSuggestedMeta(metaWith(field, 42))).toBe(false)
  })

  it('accepts complete suggested metadata', () => {
    expect(isSuggestedMeta(suggestedMeta(ToolCallId('call-1')))).toBe(true)
  })

  it('drops the key when the plugin fiber unloads (HMR safety)', async () => {
    const bench = await harness(false)
    startTurn(bench.session)
    expect(state(bench)).toBeUndefined()
    const fiber = await bench.ctx.plugin(FollowUpTasks)
    expect(state(bench)).toEqual({ openTurnCalls: [], suggested: [] })
    await fiber.dispose()
    expect(state(bench)).toBeUndefined()
  })
})
