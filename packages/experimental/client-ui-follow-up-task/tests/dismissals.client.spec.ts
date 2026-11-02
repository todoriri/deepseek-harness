// @vitest-environment jsdom
/** `createDismissalStore` keeps the most recent dismissed Session ids in localStorage. */

import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDismissalStore } from '../src/client/dismissals.ts'

const STORAGE_KEY = 'dsh.follow-up-task.dismissed.v1'

/**
 * One reserved Session id.
 * @param id - raw id text.
 * @returns the branded id.
 */
function sessionId(id: string): SessionId {
  return SessionId(id)
}

afterEach(() => {
  localStorage.clear()
})

describe('createDismissalStore', () => {
  it('dismisses a Session id and restores it', () => {
    const store = createDismissalStore()
    const id = sessionId('session-one')
    expect(store.getSnapshot()).not.toContain(id)
    store.dismiss(id)
    expect(store.getSnapshot()).toContain(id)
    store.restore(id)
    expect(store.getSnapshot()).not.toContain(id)
  })

  it('moves a re-dismissed id to the front without duplicating it', () => {
    const store = createDismissalStore()
    const first = sessionId('session-one')
    const second = sessionId('session-two')
    store.dismiss(first)
    store.dismiss(second)
    store.dismiss(first)
    expect(store.getSnapshot()).toEqual(['session-one', 'session-two'])
  })

  it('keeps only the 200 most recent ids', () => {
    const store = createDismissalStore()
    for (let index = 0; index <= 200; index += 1) store.dismiss(sessionId(`session-${index}`))
    expect(store.getSnapshot()).toHaveLength(200)
    expect(store.getSnapshot()[0]).toBe('session-200')
    expect(store.getSnapshot()).not.toContain('session-0')
  })

  it('notifies subscribers on every dismissal change', () => {
    const store = createDismissalStore()
    const seen: (readonly string[])[] = []
    store.subscribe(() => { seen.push(store.getSnapshot()) })
    store.dismiss(sessionId('session-one'))
    store.restore(sessionId('session-one'))
    expect(seen).toEqual([['session-one'], []])
  })

  it('persists the ids to localStorage and reads them back in a new store', () => {
    const first = createDismissalStore()
    first.dismiss(sessionId('session-one'))
    first.dismiss(sessionId('session-two'))
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(stored).toEqual(['session-two', 'session-one'])
    const second = createDismissalStore()
    expect(second.getSnapshot()).toEqual(['session-two', 'session-one'])
  })

  it.each([
    ['a string', '"session-one"'],
    ['an object', '{"session-one":true}'],
  ])('restores %s stored under the key as no dismissals', (_kind, raw) => {
    localStorage.setItem(STORAGE_KEY, raw)
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = createDismissalStore()
      expect(store.getSnapshot()).toEqual([])
      expect(report).toHaveBeenCalledOnce()
      store.dismiss(sessionId('session-two'))
      expect(store.getSnapshot()).toEqual(['session-two'])
    } finally { report.mockRestore() }
  })

  it('drops non-string entries from the stored ids', () => {
    localStorage.setItem(STORAGE_KEY, '["session-one", 7, null, {"id": "session-two"}]')
    const store = createDismissalStore()
    expect(store.getSnapshot()).toEqual(['session-one'])
  })
})
