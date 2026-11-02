// @vitest-environment jsdom
/**
 * The follow-up task browser half on real SlotRegistry, ConversationEventRegistry, and
 * LocaleRuntime instances: `apply` installs the dictionaries, the Conversation definition, and one
 * turn-tail card registration; the injected face reads this Turn's tasks from the Chat target,
 * starts the reserved Session in the source Session's Workspace, opens it, and dismisses or
 * restores the card in the browser-local store; teardown removes every registration (HMR safety).
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { EMPTY_CHAT_SNAPSHOT, type ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { ConversationEventRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FollowUpTaskSuggestedMeta } from '@deepseek-ai/dsh-experimental-tool-follow-up-task/contract'
import { FollowUpTaskCards, type FollowUpTaskCardsInjected } from '../src/client/FollowUpTaskCards.tsx'
import { apply, inject } from '../src/client/index.ts'

const SOURCE = SessionId('session-source')
const SOURCE_WORKSPACE = 'workspace-source' as WorkspaceId

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  localStorage.clear()
})

/**
 * One Session list row.
 * @param id - the row's Session id.
 * @returns the summary row.
 */
function sessionSummary(id: SessionId): SessionSummary {
  return { id, displayTitle: id, running: false, retainedBy: {}, blank: true, updatedAt: 0 }
}

/**
 * One Workspace row accounting the given Sessions.
 * @param workspaceId - the row's Workspace identity.
 * @param sessionIds - Sessions accounted to the Workspace.
 * @returns the Workspace row.
 */
function workspace(workspaceId: WorkspaceId, sessionIds: readonly SessionId[]): WorkspaceView {
  return {
    workspaceId,
    path: `/w/${workspaceId}`,
    title: workspaceId,
    sessionIds,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/**
 * One complete suggested task.
 * @param overrides - fields to replace.
 * @returns the suggested record.
 */
function suggested(overrides: Partial<FollowUpTaskSuggestedMeta> = {}): FollowUpTaskSuggestedMeta {
  return {
    type: 'follow-up-task.suggested',
    taskId: ToolCallId('call-1'),
    sessionId: SessionId('session-reserved'),
    title: 'Fix the stale README example',
    summary: 'The README example is out of date.',
    prompt: 'Update the README example and verify the rendered page.',
    ...overrides,
  }
}

/**
 * Boot the browser half over real registries and recording fakes for the four consumed services.
 * @param workspaces - Workspace rows the source Session may belong to.
 * @returns the context, registries, and recording fakes.
 */
async function bench(workspaces: readonly WorkspaceView[] = []) {
  const ctx = new Context()
  contexts.push(ctx)
  const events = new ConversationEventRegistry(ctx)
  const chat = createSnapshotStore<ChatSnapshot | undefined>(EMPTY_CHAT_SNAPSHOT)
  const sessions = createSnapshotStore<SessionListState>({
    ids: [SOURCE],
    byId: { [SOURCE]: sessionSummary(SOURCE) },
    phase: 'ready',
    projectionsBySession: {},
  })
  const workspaceList = createSnapshotStore<WorkspaceSnapshot>({
    items: workspaces,
    archivedSessionIds: [],
    pinnedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
  })
  const startSession = vi.fn()
  const openSession = vi.fn()
  ctx.provide('uiConversation', { events, binding: () => ({ target: () => chat }) })
  ctx.provide('sessions', {
    list: sessions,
    binding: (sessionId: SessionId) => sessionId === SOURCE ? {} : undefined,
  })
  ctx.provide('workspaces', { list: workspaceList })
  ctx.provide('uiWorkspace', { startSession, openSession })
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'conversation.chat.turnTail': { kind: 'list', scope: 'session' } },
  } as never, () => null)
  return {
    ctx,
    events,
    chat,
    sessions,
    workspaceList,
    startSession,
    openSession,
    slots: ctx.get('slots') as SlotRegistry,
  }
}

/**
 * Resolve the injected face of the single turn-tail registration.
 * @param slots - the booted slot registry.
 * @param sessionId - Session whose Conversation the cards render in.
 * @returns the cards' business face.
 */
function faceOf(
  slots: SlotRegistry,
  sessionId: SessionId = SOURCE,
): FollowUpTaskCardsInjected {
  const entry = slots.entries('conversation.chat.turnTail')[0]
  if (entry === undefined) throw new Error('no turn-tail registration')
  const resolve = entry.inject as (id: SessionId) => FollowUpTaskCardsInjected & Record<string, unknown>
  return resolve(sessionId)
}

describe('follow-up task browser apply', () => {
  it('registers the dictionaries, the Conversation definition, and one turn-tail registration, and removes all three on disposal', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.ctx.locale.bind('followUpTask')('card.label')).toBe('Follow-up task')
    expect(b.events.entries().map(definition => definition.kind)).toEqual(['follow-up-task'])
    const cards = b.slots.entries('conversation.chat.turnTail')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.component).toBe(FollowUpTaskCards)
    await fiber.dispose()
    expect(b.ctx.locale.bind('followUpTask')('card.label')).toBe('card.label')
    expect(b.events.entries()).toEqual([])
    expect(b.slots.entries('conversation.chat.turnTail')).toEqual([])
  })

  it('reads the turn data source of the rendered Session for the follow-up task kind', async () => {
    const b = await bench()
    const turnDataSource = vi.fn()
    b.chat.set({
      ...EMPTY_CHAT_SNAPSHOT,
      nodes: {
        ...EMPTY_CHAT_SNAPSHOT.nodes,
        turnDataSource: (turn, kind) => {
          turnDataSource(turn, kind)
          return EMPTY_CHAT_SNAPSHOT.nodes.turnDataSource(turn, kind)
        },
      },
    })
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = faceOf(b.slots)
    expect(face.keyedHooks.tasks('7').getSnapshot()).toEqual([])
    expect(turnDataSource).toHaveBeenCalledExactlyOnceWith(7, 'follow-up-task')
    // The card observes the controllers' own sources, not a copy.
    expect(face.hooks.sessionList).toBe(b.sessions)
    expect(face.hooks.workspaceList).toBe(b.workspaceList)
  })

  it('throws a clear error for an unknown Session', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(() => faceOf(b.slots, SessionId('session-unknown'))).toThrow('follow-up-task: unknown session "session-unknown"')
  })

  it('throws when the Chat target is unavailable', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = faceOf(b.slots)
    b.chat.set(undefined)
    expect(() => face.keyedHooks.tasks('7')).toThrow('follow-up-task: Chat target is unavailable')
  })

  it('starts the task in the source Session Workspace under the reserved Session id with its prompt', async () => {
    const b = await bench([
      workspace('workspace-other' as WorkspaceId, [SessionId('session-other')]),
      workspace(SOURCE_WORKSPACE, [SOURCE]),
    ])
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const task = suggested()
    faceOf(b.slots).start(task)
    expect(b.startSession).toHaveBeenCalledExactlyOnceWith(SOURCE_WORKSPACE, {
      sessionId: task.sessionId,
      prompt: task.prompt,
      whenDraftExists: 'keep',
    })
  })

  it('starts the task without a Workspace when the source Session belongs to none', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const task = suggested()
    faceOf(b.slots).start(task)
    expect(b.startSession).toHaveBeenCalledExactlyOnceWith(undefined, {
      sessionId: task.sessionId,
      prompt: task.prompt,
      whenDraftExists: 'keep',
    })
  })

  it('shares one dismissal store across every face it injects', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const first = faceOf(b.slots)
    const second = faceOf(b.slots)
    const task = suggested()
    first.dismiss(task.sessionId)
    expect(second.hooks.dismissals.getSnapshot()).toEqual([task.sessionId])
  })

  it('opens the reserved Session and dismisses and restores it in the browser-local store', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const task = suggested()
    const face = faceOf(b.slots)
    const dismissals = face.hooks.dismissals
    expect(dismissals.getSnapshot()).toEqual([])
    face.open(task.sessionId)
    expect(b.openSession).toHaveBeenCalledExactlyOnceWith(task.sessionId)
    face.dismiss(task.sessionId)
    expect(dismissals.getSnapshot()).toEqual([task.sessionId])
    face.restore(task.sessionId)
    expect(dismissals.getSnapshot()).toEqual([])
  })
})
