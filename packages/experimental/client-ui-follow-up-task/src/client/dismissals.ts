/** Browser-local dismissal state for follow-up task cards, keyed by reserved Session id. */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Maximum number of dismissed ids kept in browser storage; a dismissal past it drops the oldest.
 * This bounds the persisted array and is not a deployment setting.
 */
const DISMISSAL_LIMIT = 200

/** Browser-local dismissed Session ids, most recently dismissed first. */
export interface DismissalStore extends ObservableSnapshot<readonly string[]> {
  /**
   * Move one id to the front of the dismissed ids, dropping the oldest past the storage limit.
   * @param sessionId - reserved Session id of the task the user dismissed.
   */
  dismiss(sessionId: SessionId): void
  /**
   * Remove one id from the dismissed ids.
   * @param sessionId - reserved Session id of the task the user restored.
   */
  restore(sessionId: SessionId): void
}

/**
 * Create the persisted browser-local dismissal store. A stored value that is not an array
 * restores as no dismissals, and non-string entries are dropped.
 * @returns the store wrapped with the dismissal operations.
 */
export function createDismissalStore(): DismissalStore {
  const store = createSnapshotStore<readonly string[]>([], { persist: { name: 'dsh.follow-up-task.dismissed.v1' } })
  // createSnapshotStore rehydrates localStorage without validation; repair the value before any reader sees it.
  const restored: unknown = store.getSnapshot()
  const ids = storedIds(restored)
  if (!Array.isArray(restored) || ids.length !== restored.length) store.set(ids)
  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: listener => store.subscribe(listener),
    dismiss: (sessionId) => {
      const others = store.getSnapshot().filter(id => id !== sessionId)
      store.set([sessionId, ...others].slice(0, DISMISSAL_LIMIT))
    },
    restore: (sessionId) => {
      store.set(store.getSnapshot().filter(id => id !== sessionId))
    },
  }
}

/**
 * Read the dismissed ids from a value rehydrated from browser storage.
 * @param value - the rehydrated value.
 * @returns its string entries, or none when it is not an array.
 */
function storedIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const entries: readonly unknown[] = value
  return entries.filter(entry => typeof entry === 'string')
}
