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
 * restores as no dismissals, and non-string entries are dropped; browser storage keeps the
 * stored text until the next dismiss or restore overwrites it.
 * @returns the store wrapped with the dismissal operations.
 */
export function createDismissalStore(): DismissalStore {
  const store = createSnapshotStore<readonly string[]>([], { persist: { name: 'dsh.follow-up-task.dismissed.v1', parse: parseStoredIds } })
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
 * Admit the dismissed ids stored in browser storage.
 * @param value - the decoded stored value.
 * @returns its string entries, or undefined to keep no dismissals when it is not an array.
 */
function parseStoredIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: readonly unknown[] = value
  return entries.filter(entry => typeof entry === 'string')
}
