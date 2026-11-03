// @vitest-environment jsdom
/**
 * Both follow-up task transcript rows derive their state, summary, and result body from the
 * durable call slice and the owner's disclosure hook.
 */

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { PreparingToolCall, StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { DismissFollowUpTaskRow, SuggestFollowUpTaskRow } from '../src/client/FollowUpTaskRows.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

type RowProps = Parameters<typeof SuggestFollowUpTaskRow>[0]

const SUGGEST = 'suggest_follow_up_task'
const DISMISS = 'dismiss_follow_up_task'

/** The description text of a successful suggestion result. */
const SUGGEST_RESULT = 'Follow-up task call-1 is shown to the user and starts only if they choose to. Continue with the current request.'

/** The result ui-chat builds for a call the turn interrupted (`conversation-nodes/tool.ts`). */
const INTERRUPTED: Partial<ToolResultNode> = {
  content: [],
  isError: true,
  error: { name: 'Interrupted', code: 'interrupted' },
}

/** One dispatched call with the given argument text. */
function running(name: string, argsRaw: string): StartedToolCall {
  return {
    phase: 'start', args: PartialArguments.fromText(argsRaw), callId: 'call-1', name,
    argsRaw, turn: 1, step: 1, time: 2_000, subCalls: [],
  }
}

/** One preparation-stage call. */
function preparing(name: string): PreparingToolCall {
  return {
    phase: 'preparing', args: PartialArguments.EMPTY, callId: 'call-1', name,
    turn: 1, step: 1, time: 1_000, subCalls: [],
  }
}

/** One settled call; its argument view follows the in-window call unless a test overrides it. */
function settled(name: string, argsRaw: string, over: Partial<ToolResultNode> = {}): ToolResultNode {
  const call = over.call === undefined ? { name, argsRaw } : over.call
  return {
    kind: 'tool-result',
    seq: 3,
    time: 3_000,
    callId: 'call-1',
    name: call?.name ?? '',
    args: call === null ? PartialArguments.EMPTY : PartialArguments.fromText(call.argsRaw),
    call,
    callTime: 2_000,
    content: [{ type: 'text', text: SUGGEST_RESULT }],
    isError: false,
    subCalls: [],
    ...over,
  }
}

/**
 * Stub the owner's disclosure hook: a fixed open state plus a recording toggle.
 * @param expanded - the open state the hook reports.
 * @returns the hook stub and its toggle recorder.
 */
function disclosure(expanded = false): { useDisclosure: RowProps['useDisclosure']; toggle: ReturnType<typeof vi.fn> } {
  const toggle = vi.fn()
  return {
    useDisclosure: () => ({ expanded, setExpanded: vi.fn(), toggle }),
    toggle,
  }
}

/**
 * Assemble the full props of one row for a call block.
 * @param block - the tool call stage.
 * @param toolName - wire tool name reported in `data-tool`.
 * @param useDisclosure - the owner's disclosure hook stub.
 * @param inspect - optional call-inspection callback.
 * @param t - the follow-up task translate seat.
 * @returns the row props.
 */
function props(
  block: RowProps['block'],
  toolName: string,
  useDisclosure: RowProps['useDisclosure'] = disclosure().useDisclosure,
  inspect?: () => void,
  t: RowProps['t'] = makeTranslate(en),
): RowProps {
  const owner: ToolCallOwnerProps = {
    callId: block.callId,
    toolName,
    ...('kind' in block
      ? { phase: 'result' as const, block }
      : block.phase === 'preparing' ? { phase: 'preparing' as const, block }
        : { phase: 'start' as const, block }),
    useDisclosure,
    loadImage: vi.fn<RowProps['loadImage']>(),
    openFile: vi.fn(),
    inspect,
  }
  return { ...owner, t } as RowProps
}

/** Both rows with the tool name and title each test asserts. */
const ROWS: ReadonlyArray<{
  readonly Row: (props: RowProps) => ReactNode
  readonly toolName: string
  readonly title: string
}> = [
  { Row: SuggestFollowUpTaskRow, toolName: SUGGEST, title: 'Suggest follow-up task' },
  { Row: DismissFollowUpTaskRow, toolName: DISMISS, title: 'Withdraw follow-up task' },
]

/** The call arguments each tool's rows carry in the shared tests. */
function argsFor(toolName: string): string {
  return toolName === SUGGEST ? '{"title":"Fix the README"}' : '{"taskId":"call-1"}'
}

describe('both rows', () => {
  it.each(ROWS)('$toolName shows preparation without disclosure', ({ Row, toolName, title }) => {
    const useDisclosure = vi.fn(() => { throw new Error('preparing must not subscribe to disclosure') })
    const view = render(<Row {...props(preparing(toolName), toolName, useDisclosure)} />)
    const root = view.container.querySelector(`[data-tool="${toolName}"]`)!
    expect(root.getAttribute('data-state')).toBe('preparing')
    expect(root.querySelector('svg')?.getAttribute('width')).toBe('14')
    expect(view.getByText(title)).toBeTruthy()
    expect(view.getByText('Preparing tool call')).toBeTruthy()
    expect(view.queryByRole('button')).toBeNull()
    expect(view.container.querySelector('pre')).toBeNull()
    expect(useDisclosure).not.toHaveBeenCalled()
  })

  it.each(ROWS)('$toolName shows the hidden Running status while dispatched', ({ Row, toolName }) => {
    const view = render(<Row {...props(running(toolName, argsFor(toolName)), toolName)} />)
    const root = view.container.querySelector(`[data-tool="${toolName}"]`)!
    expect(root.getAttribute('data-state')).toBe('running')
    expect(view.getByText('Running')).toBeTruthy()
    expect(view.queryByRole('button')).toBeNull()
  })

  it.each(ROWS)('$toolName shows a refusal first line in the error tone', ({ Row, toolName, title }) => {
    const refusal = 'Error: At most 3 follow-up tasks can be suggested per turn; keep only the most valuable ones.'
    const view = render(<Row {...props(settled(toolName, argsFor(toolName), {
      content: [{ type: 'text', text: refusal }],
      isError: true,
      error: { name: 'ToolError', code: 'cap-exceeded' },
    }), toolName)} />)
    expect(view.container.querySelector(`[data-tool="${toolName}"]`)?.getAttribute('data-state')).toBe('error')
    expect(view.getByText('Failed')).toBeTruthy()
    expect(view.container.textContent).toBe(`Failed${title}${refusal}`)
  })

  it.each(ROWS)('$toolName shows an interrupted result as the visible Stopped summary', ({ Row, toolName, title }) => {
    const view = render(<Row {...props(settled(toolName, argsFor(toolName), INTERRUPTED), toolName)} />)
    expect(view.container.querySelector(`[data-tool="${toolName}"]`)?.getAttribute('data-state')).toBe('stopped')
    expect(view.getByText('Stopped')).toBeTruthy()
    expect(view.queryByText('Failed')).toBeNull()
    expect(view.container.textContent).toBe(`${title}Stopped`)
  })

  it.each(ROWS)('$toolName expansion follows the owner disclosure hook', ({ Row, toolName }) => {
    const collapsed = disclosure(false)
    const first = render(<Row {...props(settled(toolName, argsFor(toolName)), toolName, collapsed.useDisclosure)} />)
    const row = first.getByRole('button')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(row)
    expect(collapsed.toggle).toHaveBeenCalledOnce()
    expect(first.container.querySelector('pre')).toBeNull()
    first.unmount()
    const opened = render(<Row {...props(settled(toolName, argsFor(toolName)), toolName, disclosure(true).useDisclosure)} />)
    expect(opened.container.querySelector('pre')?.textContent).toBe(SUGGEST_RESULT)
  })

  it.each(ROWS)('$toolName expanded body calls inspect and omits the button without one', ({ Row, toolName }) => {
    const inspect = vi.fn()
    const withInspect = render(
      <Row {...props(settled(toolName, argsFor(toolName)), toolName, disclosure(true).useDisclosure, inspect)} />,
    )
    fireEvent.click(withInspect.getByRole('button', { name: 'Inspect call' }))
    expect(inspect).toHaveBeenCalledOnce()
    withInspect.unmount()
    const withoutInspect = render(<Row {...props(settled(toolName, argsFor(toolName)), toolName, disclosure(true).useDisclosure)} />)
    expect(withoutInspect.queryByRole('button', { name: 'Inspect call' })).toBeNull()
  })

  it.each(ROWS)('$toolName is not expandable without result text', ({ Row, toolName }) => {
    const view = render(
      <Row {...props(settled(toolName, argsFor(toolName), { content: [] }), toolName, disclosure(true).useDisclosure)} />,
    )
    expect(view.container.querySelector('[data-disclosure-row]')?.getAttribute('role')).toBeNull()
    expect(view.queryByRole('button')).toBeNull()
    expect(view.container.querySelector('pre')).toBeNull()
  })

  it.each(ROWS)('$toolName falls back to the title argument when an error has no result text', ({ Row, toolName, title }) => {
    const view = render(
      <Row {...props(settled(toolName, argsFor(toolName), { content: [], isError: true }), toolName, disclosure(true).useDisclosure)} />,
    )
    const fallback = toolName === SUGGEST ? 'Fix the README' : ''
    expect(view.container.textContent).toBe(`Failed${title}${fallback}`)
  })
})

describe('SuggestFollowUpTaskRow summary', () => {
  it('shows the first line of the trimmed title argument in running and ok rows', () => {
    const raw = '{"title":"  Fix the README\\nsecond line "}'
    const runningView = render(<SuggestFollowUpTaskRow {...props(running(SUGGEST, raw), SUGGEST)} />)
    expect(runningView.container.textContent).toContain('Fix the README')
    expect(runningView.container.textContent).not.toContain('second line')
    runningView.unmount()
    const okView = render(<SuggestFollowUpTaskRow {...props(settled(SUGGEST, raw), SUGGEST)} />)
    expect(okView.container.textContent).toBe('Suggest follow-up taskFix the README')
  })

  it.each(['{}', '{"title":3}'])('shows only its title without a string title argument (%s)', (argsRaw) => {
    const view = render(<SuggestFollowUpTaskRow {...props(settled(SUGGEST, argsRaw), SUGGEST)} />)
    expect(view.container.textContent).toBe('Suggest follow-up task')
  })

  it('shows only its title when the call left the loaded window', () => {
    const view = render(<SuggestFollowUpTaskRow {...props(settled(SUGGEST, '{"title":"Fix the README"}', { call: null }), SUGGEST)} />)
    expect(view.container.textContent).toBe('Suggest follow-up task')
  })

  it('shows a multi-line refusal first line while collapsed and the whole text while expanded', () => {
    const refusal = 'Error: At most 3 follow-up tasks can be suggested per turn; keep only the most valuable ones.\nDo not retry.'
    const block = settled(SUGGEST, '{"title":"Fix the README"}', {
      content: [{ type: 'text', text: refusal }],
      isError: true,
      error: { name: 'ToolError', code: 'cap-exceeded' },
    })
    const collapsed = render(<SuggestFollowUpTaskRow {...props(block, SUGGEST)} />)
    expect(collapsed.container.textContent).toBe('FailedSuggest follow-up taskError: At most 3 follow-up tasks can be suggested per turn; keep only the most valuable ones.')
    expect(collapsed.container.textContent).not.toContain('Do not retry.')
    collapsed.unmount()
    const expanded = render(<SuggestFollowUpTaskRow {...props(block, SUGGEST, disclosure(true).useDisclosure)} />)
    expect(expanded.container.querySelector('pre')?.textContent).toBe(refusal)
  })

  it('shows a structured name and code when a failed result has no content', () => {
    const block = settled(SUGGEST, '{"title":"Fix the README"}', {
      content: [], isError: true, error: { name: 'ToolError', code: 'missing' },
    })
    const view = render(<SuggestFollowUpTaskRow {...props(block, SUGGEST, disclosure(true).useDisclosure)} />)
    expect(view.container.textContent).toBe('FailedSuggest follow-up taskToolError: missingToolError: missing')
    expect(view.container.querySelector('pre')?.textContent).toBe('ToolError: missing')
  })

  it('shows non-text result content as indented JSON in the body', () => {
    const content = { type: 'reasoning' as const, text: 'structured note' }
    const view = render(
      <SuggestFollowUpTaskRow {...props(settled(SUGGEST, '{"title":"Fix the README"}', { content: [content] }), SUGGEST, disclosure(true).useDisclosure)} />,
    )
    expect(view.container.querySelector('pre')?.textContent).toBe(JSON.stringify(content, null, 2))
  })
})

describe('DismissFollowUpTaskRow summary', () => {
  it('shows only the withdraw title with no separator and no task id', () => {
    const view = render(<DismissFollowUpTaskRow {...props(settled(DISMISS, '{"taskId":"call-1"}'), DISMISS)} />)
    expect(view.container.textContent).toBe('Withdraw follow-up task')
    expect(view.container.querySelector('[data-shimmer-decoration]')).toBeNull()
    expect(view.container.textContent).not.toContain('call-1')
  })
})

describe('locale', () => {
  it('renders both rows and a stopped summary in Chinese', () => {
    const t = makeTranslate(zh)
    const suggest = render(<SuggestFollowUpTaskRow {...props(settled(SUGGEST, '{"title":"Fix the README"}'), SUGGEST, disclosure().useDisclosure, undefined, t)} />)
    expect(suggest.container.textContent).toBe('建议后续任务Fix the README')
    suggest.unmount()
    const dismiss = render(<DismissFollowUpTaskRow {...props(settled(DISMISS, '{"taskId":"call-1"}'), DISMISS, disclosure().useDisclosure, undefined, t)} />)
    expect(dismiss.container.textContent).toBe('撤回后续任务')
    dismiss.unmount()
    const stopped = render(
      <SuggestFollowUpTaskRow {...props(
        settled(SUGGEST, '{"title":"Fix the README"}', INTERRUPTED),
        SUGGEST, disclosure().useDisclosure, undefined, t,
      )} />,
    )
    expect(stopped.getByText('已停止')).toBeTruthy()
  })
})
