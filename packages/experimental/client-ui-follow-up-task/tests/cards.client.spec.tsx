// @vitest-environment jsdom
/** `FollowUpTaskCards` renders one card per suggestion in the state its Session, archive, and dismissal inputs select. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FollowUpTaskSuggestedMeta } from '@deepseek-ai/dsh-experimental-tool-follow-up-task/contract'
import type { FollowUpTaskNodeState } from '../src/client/definition.ts'
import { FollowUpTaskCards } from '../src/client/FollowUpTaskCards.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

type CardsProps = Parameters<typeof FollowUpTaskCards>[0]

/** Render inputs a test may replace. */
interface SetupOptions {
  readonly tasks?: readonly FollowUpTaskNodeState[]
  readonly sessionList?: SessionListState
  readonly workspaceList?: WorkspaceSnapshot
  readonly dismissals?: readonly string[]
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
    sessionId: SessionId('session-1'),
    title: 'Fix the stale README example',
    summary: 'The README example is out of date.',
    prompt: 'Update the README example and verify the rendered page.',
    ...overrides,
  }
}

/**
 * One card node state.
 * @param task - the suggestion the card renders.
 * @param withdrawn - whether a later dismissal record withdrew it.
 * @returns the node state.
 */
function taskNode(task: FollowUpTaskSuggestedMeta, withdrawn = false): FollowUpTaskNodeState {
  return { task, withdrawn }
}

/**
 * One Session list row.
 * @param id - the row's reserved id.
 * @param blank - whether the Session has no submitted input.
 * @returns the summary row.
 */
function sessionSummary(id: SessionId, blank: boolean): SessionSummary {
  return { id, displayTitle: id, running: false, retainedBy: {}, blank, updatedAt: 0 }
}

/**
 * Build a Session list snapshot over the given rows.
 * @param rows - Session summary rows.
 * @returns the list state.
 */
function sessionList(rows: readonly SessionSummary[] = []): SessionListState {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, row])),
    phase: 'ready',
    projectionsBySession: {},
  }
}

/**
 * Build a Workspace list snapshot with the given archive set.
 * @param archivedSessionIds - archived reserved ids.
 * @returns the Workspace snapshot.
 */
function workspaceList(archivedSessionIds: readonly SessionId[] = []): WorkspaceSnapshot {
  return { items: [], archivedSessionIds, pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }
}

/**
 * Stub selector hook over a fixed snapshot.
 * @param value - snapshot the hook reads.
 * @returns the typed selector hook.
 */
function selectorHook<T>(value: T): SnapshotSelectorHook<T> {
  return <S,>(select: (state: T) => S): S => select(value)
}

/**
 * Stub keyed hook for this turn's tasks.
 * @param tasks - task list, or undefined for an unavailable source.
 * @returns the typed keyed selector hook.
 */
function tasksHook(tasks: readonly FollowUpTaskNodeState[] | undefined): CardsProps['useTasks'] {
  function useTasks(key: string): readonly FollowUpTaskNodeState[] | undefined
  function useTasks<Selected>(
    key: string,
    select: (value: readonly FollowUpTaskNodeState[] | undefined) => Selected,
    equal?: (left: Selected, right: Selected) => boolean,
  ): Selected
  function useTasks(_key: string, select?: (value: readonly FollowUpTaskNodeState[] | undefined) => unknown): unknown {
    return select === undefined ? tasks : select(tasks)
  }
  return useTasks
}

/**
 * Assemble full card props with static hooks and recording callbacks.
 * @param options - task list and the three hook snapshots.
 * @returns the props plus the four callbacks.
 */
function setup(options: SetupOptions = {}) {
  const start = vi.fn()
  const open = vi.fn()
  const dismiss = vi.fn()
  const restore = vi.fn()
  const props = {
    turn: { turn: 1 } as TurnLocation,
    useTasks: tasksHook(options.tasks ?? []),
    useSessionList: selectorHook(options.sessionList ?? sessionList()),
    useWorkspaceList: selectorHook(options.workspaceList ?? workspaceList()),
    useDismissals: selectorHook(options.dismissals ?? []),
    start,
    open,
    dismiss,
    restore,
    t: makeTranslate(en, commonEn),
  } as CardsProps
  return { props, start, open, dismiss, restore }
}

describe('FollowUpTaskCards', () => {
  it('renders nothing for a turn without tasks', () => {
    const { props } = setup()
    const empty = render(<FollowUpTaskCards {...props} />)
    expect(empty.container.innerHTML).toBe('')
    empty.unmount()
    const absent = render(<FollowUpTaskCards {...{ ...props, useTasks: tasksHook(undefined) }} />)
    expect(absent.container.innerHTML).toBe('')
  })

  it('shows an available task with Start and Dismiss actions', () => {
    const task = suggested()
    const { props, start, dismiss } = setup({ tasks: [taskNode(task)] })
    render(<FollowUpTaskCards {...props} />)
    expect(screen.getByText(task.title)).toBeTruthy()
    expect(screen.getByText(task.summary)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: `Start follow-up task: ${task.title}` }))
    expect(start).toHaveBeenCalledWith(task)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(dismiss).toHaveBeenCalledWith(task.sessionId)
  })

  it('shows and hides the prompt through the disclosure toggle', () => {
    const task = suggested()
    const { props } = setup({ tasks: [taskNode(task)] })
    render(<FollowUpTaskCards {...props} />)
    expect(screen.queryByText(task.prompt)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show prompt' }))
    expect(screen.getByText(task.prompt)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Hide prompt' }))
    expect(screen.queryByText(task.prompt)).toBeNull()
  })

  it('shows a drafted task with Open draft in place of Start', () => {
    const task = suggested()
    const { props, start, open } = setup({
      tasks: [taskNode(task)],
      sessionList: sessionList([sessionSummary(task.sessionId, true)]),
    })
    render(<FollowUpTaskCards {...props} />)
    expect(screen.queryByText(task.summary)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open draft' }))
    expect(start).toHaveBeenCalledWith(task)
    expect(open).not.toHaveBeenCalled()
  })

  it('shows a started task with Open session', () => {
    const task = suggested()
    const { props, start, open } = setup({
      tasks: [taskNode(task)],
      sessionList: sessionList([sessionSummary(task.sessionId, false)]),
    })
    render(<FollowUpTaskCards {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }))
    expect(open).toHaveBeenCalledWith(task.sessionId)
    expect(start).not.toHaveBeenCalled()
  })

  it('shows an archived task with Open session when it has no Session row', () => {
    const task = suggested()
    const { props, start, open } = setup({ tasks: [taskNode(task)], workspaceList: workspaceList([task.sessionId]) })
    render(<FollowUpTaskCards {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }))
    expect(open).toHaveBeenCalledWith(task.sessionId)
    expect(start).not.toHaveBeenCalled()
  })

  it('shows a dismissed task with Restore', () => {
    const task = suggested()
    const { props, restore } = setup({ tasks: [taskNode(task)], dismissals: [task.sessionId] })
    render(<FollowUpTaskCards {...props} />)
    expect(screen.getByText('Dismissed')).toBeTruthy()
    expect(screen.getByText(task.title)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(restore).toHaveBeenCalledWith(task.sessionId)
  })

  it('shows a withdrawn task without actions', () => {
    const task = suggested()
    const { props } = setup({ tasks: [taskNode(task, true)] })
    render(<FollowUpTaskCards {...props} />)
    expect(screen.getByText('Withdrawn by the agent')).toBeTruthy()
    expect(screen.getByText(task.title)).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('renders several tasks in suggestion order', () => {
    const first = suggested({ taskId: ToolCallId('call-1'), title: 'First task' })
    const second = suggested({ taskId: ToolCallId('call-2'), title: 'Second task' })
    const { props } = setup({ tasks: [taskNode(first), taskNode(second, true)] })
    const view = render(<FollowUpTaskCards {...props} />)
    const cards = [...view.container.querySelectorAll('[data-follow-up-task-card]')]
    expect(cards.map(card => card.getAttribute('data-follow-up-task-card'))).toEqual([first.taskId, second.taskId])
    expect(cards.map(card => card.getAttribute('data-state'))).toEqual(['available', 'withdrawn'])
  })

  it('names Start after the task in the English locale', () => {
    const task = suggested({ title: 'Fix the stale README example' })
    const { props } = setup({ tasks: [taskNode(task)] })
    render(<FollowUpTaskCards {...props} />)
    expect(screen.getByRole('button', { name: 'Start follow-up task: Fix the stale README example' })).toBeTruthy()
    expect(screen.getByText('Start')).toBeTruthy()
  })
})
