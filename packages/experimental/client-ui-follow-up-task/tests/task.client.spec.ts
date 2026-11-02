/**
 * `followUpTaskMetaOf` reads suggested and dismissed presentation records from
 * logged native and PTC tool results, rejecting malformed durable metadata.
 */

import { describe, expect, it } from 'vitest'
import { followUpTaskMetaOf } from '../src/client/task.ts'

const SUGGESTED_FIELDS = ['taskId', 'sessionId', 'title', 'summary', 'prompt'] as const

/** One complete suggested record. */
function suggestedRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'follow-up-task.suggested',
    taskId: 'call-1',
    sessionId: 'session-1',
    title: 'Title',
    summary: 'Summary.',
    prompt: 'Prompt.',
    ...overrides,
  }
}

/** One complete dismissed record. */
function dismissedRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'follow-up-task.dismissed', taskId: 'call-1', ...overrides }
}

/** Copy one record without the named field. */
function without(record: Record<string, unknown>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== field))
}

/** One durable event carrying arbitrary data. */
function event(type: string, data: unknown): { readonly type: string; readonly data: unknown } {
  return { type, data }
}

describe('followUpTaskMetaOf', () => {
  it('reads suggested and dismissed records from tool/result and tool/ptc-dispatch', () => {
    const suggested = suggestedRecord()
    const dismissed = dismissedRecord()
    expect(followUpTaskMetaOf(event('tool/result', { meta: suggested }))).toEqual(suggested)
    expect(followUpTaskMetaOf(event('tool/result', { meta: dismissed }))).toEqual(dismissed)
    expect(followUpTaskMetaOf(event('tool/ptc-dispatch', { meta: suggested }))).toEqual(suggested)
    expect(followUpTaskMetaOf(event('tool/ptc-dispatch', { meta: dismissed }))).toEqual(dismissed)
  })

  it.each([
    ['an unrelated event type', event('turn/start', { meta: suggestedRecord() })],
    ['missing meta', event('tool/result', { turn: 1, step: 1 })],
    ['array data', event('tool/result', [])],
    ['null data', event('tool/result', null)],
    ['array meta', event('tool/result', { meta: [] })],
    ['null meta', event('tool/result', { meta: null })],
    ['string meta', event('tool/result', { meta: 'meta' })],
    ['missing meta type', event('tool/result', { meta: {} })],
    ['unknown meta type', event('tool/result', { meta: { type: 'other' } })],
  ])('returns undefined for %s', (_label, value) => {
    expect(followUpTaskMetaOf(value)).toBeUndefined()
  })

  it.each(SUGGESTED_FIELDS.flatMap(field => [
    { label: `${field} missing`, meta: without(suggestedRecord(), field) },
    { label: `${field} empty`, meta: suggestedRecord({ [field]: '' }) },
    { label: `${field} non-string`, meta: suggestedRecord({ [field]: 42 }) },
  ]))('returns undefined when suggested $label', ({ meta }) => {
    expect(followUpTaskMetaOf(event('tool/result', { meta }))).toBeUndefined()
  })

  it.each([
    { label: 'missing', meta: without(dismissedRecord(), 'taskId') },
    { label: 'empty', meta: dismissedRecord({ taskId: '' }) },
    { label: 'non-string', meta: dismissedRecord({ taskId: 42 }) },
  ])('returns undefined when dismissed taskId is $label', ({ meta }) => {
    expect(followUpTaskMetaOf(event('tool/result', { meta }))).toBeUndefined()
  })
})
