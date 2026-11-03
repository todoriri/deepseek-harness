/**
 * Web cards for logged follow-up task suggestions: start, open, or dismiss each one. The plugin
 * also registers both tools' transcript rows.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the Session and Workspace Controller service merges (ctx.sessions, ctx.workspaces).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation Context merge (ctx.uiConversation).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the Chat target's Conversation view snapshot row.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the keyed tool.call.toolview slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// Type-only: pulls the ui-workspace Context merge (ctx.uiWorkspace).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { createDismissalStore } from './dismissals.ts'
import { followUpTaskDefinition } from './definition.ts'
import { FollowUpTaskCards, type FollowUpTaskCardsInjected } from './FollowUpTaskCards.tsx'
import { DismissFollowUpTaskRow, SuggestFollowUpTaskRow } from './FollowUpTaskRows.tsx'
import { en, zh } from './locales.ts'

/** Client services the cards consume. */
export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'uiConversation', 'uiWorkspace']

/** Dictionary namespace owned by this plugin. */
const NS = 'followUpTask'

/** Registration id of the turn-tail cards. */
const ID = '@deepseek-ai/dsh-experimental-client-ui-follow-up-task'

/**
 * Register the follow-up task dictionaries, the Conversation definition, the turn-tail cards, and
 * both tools' transcript rows.
 *
 * Every Session's cards share one browser-local dismissal store for the plugin's lifetime. A
 * Session's face reads each turn's tasks from that Session's Chat target. Start opens the task in
 * the Workspace that holds the source Session, or in `startSession`'s fallback Workspace when none does.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'follow-up-task: dictionaries')
  ctx.effect(() => ctx.uiConversation.events.register(followUpTaskDefinition), 'follow-up-task: conversation definition')
  const dismissals = createDismissalStore()
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: ID,
    locale: NS,
    inject: (sessionId: SessionId): FollowUpTaskCardsInjected => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) throw new Error(`follow-up-task: unknown session "${sessionId}"`)
      const chat = ctx.uiConversation.binding(binding).target('chat')
      return {
        keyedHooks: {
          tasks: (turn) => {
            const snapshot = chat.getSnapshot()
            if (snapshot === undefined) throw new Error('follow-up-task: Chat target is unavailable')
            return snapshot.nodes.turnDataSource(Number(turn), 'follow-up-task')
          },
        },
        hooks: {
          sessionList: ctx.sessions.list,
          workspaceList: ctx.workspaces.list,
          dismissals,
        },
        start: (task) => {
          const workspaceId = ctx.workspaces.list.getSnapshot().items
            .find(item => item.sessionIds.includes(sessionId))?.workspaceId
          ctx.uiWorkspace.startSession(workspaceId, {
            sessionId: task.sessionId,
            prompt: task.prompt,
            whenDraftExists: 'keep',
          })
        },
        open: (id) => { ctx.uiWorkspace.openSession(id) },
        dismiss: (id) => { dismissals.dismiss(id) },
        restore: (id) => { dismissals.restore(id) },
      }
    },
  }, FollowUpTaskCards))
  ctx.slots.inject('tool.call.toolview', function* () {
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'suggest_follow_up_task', locale: NS }, SuggestFollowUpTaskRow)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'dismiss_follow_up_task', locale: NS }, DismissFollowUpTaskRow)
  })
}
