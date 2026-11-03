/** Transcript rows for the follow-up task suggestion and withdrawal tools. */

import type { ReactNode } from 'react'
import { DisclosureRow, IconNewChatOutlineRegular, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolArgs, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import css from './FollowUpTaskRows.module.css'

/** Props of both transcript rows: the keyed toolview payload and the follow-up task copy. */
export type FollowUpTaskRowProps = ToolCallViewProps & PropsLocale<'followUpTask'>

/** Which follow-up task tool the internal row renders. */
type RowVariant = 'suggest' | 'dismiss'

/** Public props plus the variant that selects the row's title and summary. */
type InternalRowProps = FollowUpTaskRowProps & { readonly variant: RowVariant }

/** Lifecycle of a started row, derived from its durable call slice. */
type RowState = 'running' | 'ok' | 'error' | 'stopped'

/* v8 ignore next -- Non-expandable rows never invoke DisclosureRow's required toggle callback. */
const noop = (): void => undefined

/**
 * First physical line of a summary or failure text.
 * @param text - the text whose first line to read.
 * @returns the text up to its first newline, or the whole text.
 */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/**
 * The suggestion's trimmed `title` argument, reduced to its first line.
 * A dismiss row carries no summary.
 * @param variant - which tool's row renders.
 * @param args - lazy argument view of the call.
 * @returns the first title line, or the empty string when the argument is absent or not a string.
 */
function baseSummary(variant: RowVariant, args: ToolArgs): string {
  if (variant === 'dismiss') return ''
  const title = args.text('title')?.trim()
  return title === undefined ? '' : firstLine(title)
}

/** Flatten durable result blocks under the generic Tool-row text contract.
 *  Keep aligned with ui-tool's models/tool-call-model.ts `resultText`. */
function resultText(node: ToolResultNode): string {
  const parts: string[] = []
  for (const block of node.content) {
    parts.push(block.type === 'text' ? block.text : JSON.stringify(block, null, 2))
  }
  if (parts.length === 0 && node.error !== undefined) {
    parts.push(`${node.error.name}: ${node.error.code}`)
  }
  return parts.join('\n')
}

/** Visually hidden state copy for the color-only running sweep and error tone. */
function stateStatus(state: RowState, t: InternalRowProps['t']): string | null {
  switch (state) {
    case 'running': return t('row.running')
    case 'error': return t('row.failed')
    default: return null
  }
}

/**
 * Render the `suggest_follow_up_task` call as a summary line and its result disclosure.
 * @param props - keyed toolview payload and the `followUpTask` copy.
 * @returns the transcript row.
 */
export function SuggestFollowUpTaskRow(props: FollowUpTaskRowProps): ReactNode {
  return <FollowUpTaskRow {...props} variant="suggest" />
}

/**
 * Render the `dismiss_follow_up_task` call as a summary line and its result disclosure.
 * @param props - keyed toolview payload and the `followUpTask` copy.
 * @returns the transcript row.
 */
export function DismissFollowUpTaskRow(props: FollowUpTaskRowProps): ReactNode {
  return <FollowUpTaskRow {...props} variant="dismiss" />
}

/**
 * Dispatch to the stage-specific row.
 * @param props - keyed toolview payload, copy, and row variant.
 * @returns the preparing or started row.
 */
function FollowUpTaskRow(props: InternalRowProps): ReactNode {
  return props.phase === 'preparing' ? <PreparingFollowUpTaskRow {...props} /> : <StartedFollowUpTaskRow {...props} />
}

/**
 * Render preparation before the call's arguments are available.
 * @param props - preparing call, copy, and row variant.
 * @returns the non-disclosable preparing row.
 */
function PreparingFollowUpTaskRow({ variant, toolName, t }: Extract<InternalRowProps, { phase: 'preparing' }>): ReactNode {
  return (
    <div className={css.root} data-tool={toolName} data-state="preparing">
      <span className={css.visuallyHidden}>{t('row.preparing')}</span>
      <DisclosureRow
        icon={<IconNewChatOutlineRegular size={14} />}
        title={t(variant === 'suggest' ? 'row.suggestTitle' : 'row.dismissTitle')}
        open={false}
        expandable={false}
        onToggle={noop}
        running
        titleClassName={css.title}
      />
    </div>
  )
}

/**
 * Render a dispatched or settled call with its owner-controlled disclosure.
 * @param props - running or settled call, owner callbacks, copy, and row variant.
 * @returns the started row.
 */
function StartedFollowUpTaskRow({
  variant, toolName, block, inspect, t, useDisclosure,
}: Exclude<InternalRowProps, { phase: 'preparing' }>): ReactNode {
  const { expanded, toggle } = useDisclosure()
  const settled = 'kind' in block
  const state: RowState = !settled ? 'running'
    : block.error?.code === 'interrupted' ? 'stopped'
      : block.isError ? 'error' : 'ok'
  const output = settled ? resultText(block) : ''
  const base = baseSummary(variant, block.args)
  const summary = state === 'error'
    ? (output === '' ? base : firstLine(output))
    : state === 'stopped' ? t('row.stopped') : base
  const expandable = state !== 'running' && output !== ''
  const open = expanded && expandable
  const status = stateStatus(state, t)
  return (
    <div className={css.root} data-tool={toolName} data-state={state}>
      {status !== null && <span className={css.visuallyHidden}>{status}</span>}
      <DisclosureRow
        icon={<IconNewChatOutlineRegular size={14} />}
        title={t(variant === 'suggest' ? 'row.suggestTitle' : 'row.dismissTitle')}
        running={state === 'running'}
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={toggle}
        titleClassName={css.title}
        collapsedContent={summary === '' ? null : (
          <>
            <span className={css.separator} data-shimmer-decoration aria-hidden />
            <span className={css.summary}><TextShimmer>{summary}</TextShimmer></span>
          </>
        )}
      >
        <div className={css.body}>
          <pre className={css.output}>{output}</pre>
          {inspect !== undefined && (
            <button type="button" className={css.inspect} onClick={inspect}>{t('row.inspect')}</button>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}
