/** One turn-tail card per follow-up task suggestion, with its local dismissal state. */

import { useState, type ReactNode } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FollowUpTaskSuggestedMeta } from '@deepseek-ai/dsh-experimental-tool-follow-up-task/contract'
import { followUpTaskCardState } from './card-state.ts'
import type { FollowUpTaskNodeState } from './definition.ts'
import css from './FollowUpTaskCards.module.css'

/** Injected face of the follow-up task cards. */
export interface FollowUpTaskCardsInjected {
  keyedHooks: {
    /** This turn's follow-up tasks, in suggestion order. */
    tasks: (turn: string) => ObservableSnapshot<readonly FollowUpTaskNodeState[]>
  }
  hooks: {
    /** Session list, for the reserved ids' rows. */
    sessionList: HostObservable<SessionListState>
    /** Workspace list; the card reads `archivedSessionIds` through a selector. */
    workspaceList: HostObservable<WorkspaceSnapshot>
    /** Browser-local dismissed reserved ids. */
    dismissals: HostObservable<readonly string[]>
  }
  /** Start the task in a new Session under its reserved id, or reopen the blank draft already there. */
  start: (task: FollowUpTaskSuggestedMeta) => void
  /** Open the started Session under the reserved id. */
  open: (sessionId: SessionId) => void
  /** Hide the task in this browser. */
  dismiss: (sessionId: SessionId) => void
  /** Undo this browser's dismissal of the task. */
  restore: (sessionId: SessionId) => void
}

/** Props of the turn-tail follow-up task cards. */
type FollowUpTaskCardsProps = PropsRuntime<'conversation.chat.turnTail'>
  & InjectFace<FollowUpTaskCardsInjected>
  & PropsLocale<'followUpTask'>

/** Props of one card: the node state and the parent's hooks, actions, and copy. */
type FollowUpTaskCardProps = {
  readonly node: FollowUpTaskNodeState
} & Pick<FollowUpTaskCardsProps, 'useSessionList' | 'useWorkspaceList' | 'useDismissals' | 'start' | 'open' | 'dismiss' | 'restore' | 't'>

/**
 * Render this turn's follow-up task cards in suggestion order.
 * @param props - Turn identity, keyed task data, selector hooks, actions, and copy.
 * @returns the cards, or null for a turn without tasks.
 */
export function FollowUpTaskCards({
  turn, useTasks, useSessionList, useWorkspaceList, useDismissals, start, open, dismiss, restore, t,
}: FollowUpTaskCardsProps): ReactNode {
  const tasks = useTasks(String(turn.turn))
  if (tasks === undefined || tasks.length === 0) return null
  return (
    <div className={css.cards} data-follow-up-task-cards>
      {tasks.map(node => (
        <FollowUpTaskCard
          key={node.task.taskId}
          node={node}
          useSessionList={useSessionList}
          useWorkspaceList={useWorkspaceList}
          useDismissals={useDismissals}
          start={start}
          open={open}
          dismiss={dismiss}
          restore={restore}
          t={t}
        />
      ))}
    </div>
  )
}

/**
 * Render one follow-up task card in the state derived from its Session row, archive entry, and dismissals.
 * @param props - Node state, selector hooks, actions, and copy.
 * @returns the card for its current state.
 */
function FollowUpTaskCard({
  node, useSessionList, useWorkspaceList, useDismissals, start, open, dismiss, restore, t,
}: FollowUpTaskCardProps): ReactNode {
  const { task, withdrawn } = node
  const session = useSessionList(list => list.byId[task.sessionId])
  const archived = useWorkspaceList(workspace => workspace.archivedSessionIds.includes(task.sessionId))
  const dismissedByUser = useDismissals(ids => ids.includes(task.sessionId))
  const state = followUpTaskCardState({ withdrawn, dismissedByUser, session, archived })
  const [promptShown, setPromptShown] = useState(false)
  if (state === 'withdrawn' || state === 'dismissed') {
    return (
      <div className={css.compact} data-follow-up-task-card={task.taskId} data-state={state}>
        <span className={css.compactLabel}>
          {t(state === 'withdrawn' ? 'card.withdrawn' : 'card.dismissed')}
        </span>
        <span className={css.compactTitle}>{task.title}</span>
        {state === 'dismissed' && (
          <button type="button" className={css.action} onClick={() => { restore(task.sessionId) }}>
            {t('card.restore')}
          </button>
        )}
      </div>
    )
  }
  return (
    <div className={css.card} data-follow-up-task-card={task.taskId} data-state={state}>
      <span className={css.label}>{t('card.label')}</span>
      <span className={css.title}>{task.title}</span>
      {state === 'available' && (
        <>
          <span className={css.summary}>{task.summary}</span>
          <div className={css.actions}>
            <button
              type="button"
              className={css.action}
              aria-label={t('card.startNamed', { title: task.title })}
              onClick={() => { start(task) }}
            >
              {t('card.start')}
            </button>
            <button type="button" className={css.action} onClick={() => { dismiss(task.sessionId) }}>
              {t('card.dismiss')}
            </button>
            <button type="button" className={css.disclosure} aria-expanded={promptShown}
              onClick={() => { setPromptShown(!promptShown) }}>
              {t(promptShown ? 'card.hidePrompt' : 'card.showPrompt')}
            </button>
          </div>
          {promptShown && <p className={css.prompt}>{task.prompt}</p>}
        </>
      )}
      {state === 'drafted' && (
        <div className={css.actions}>
          <button type="button" className={css.action} onClick={() => { start(task) }}>
            {t('card.openDraft')}
          </button>
        </div>
      )}
      {state === 'started' && (
        <div className={css.actions}>
          <button type="button" className={css.action} onClick={() => { open(task.sessionId) }}>
            {t('card.open')}
          </button>
        </div>
      )}
    </div>
  )
}
