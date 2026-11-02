/** Per-session Conversation store shared by the shell body and header. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationStoreState, ConversationViewRequest } from './contract/views.ts'
import type { DraftInput, DraftSnapshot } from './contract/draft-editor.ts'
import { parseStoredDraft, resolveDraftInput } from './draft.ts'

const CONVERSATION_STORE_KEY = 'dsh.conversation'

function parseDraftField(stored: object): DraftInput {
  if (!('draft' in stored)) return ''
  return typeof stored.draft === 'string' ? stored.draft : parseStoredDraft(stored.draft) ?? ''
}

function parseViewRequest(value: unknown): ConversationViewRequest | null {
  if (typeof value !== 'object' || value === null || !('view' in value) || !('focus' in value)) return null
  const { view, focus } = value
  return typeof view === 'string' && typeof focus === 'string' ? { view, focus } : null
}

/**
 * Decode one stored record field by field, so a malformed View never
 * discards the saved draft; each malformed field reads as its initial value.
 */
function parseConversationState(value: unknown): ConversationStoreState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return {
    draft: parseDraftField(value),
    view: 'view' in value && typeof value.view === 'string' ? value.view : null,
    viewRequest: 'viewRequest' in value ? parseViewRequest(value.viewRequest) : null,
  }
}

/** Declared write set for the Conversation shell. */
type ConversationActions = {
  setDraft: (draft: ConversationStoreState, text: DraftInput) => void
  setView: (draft: ConversationStoreState, view: string) => void
  openView: (draft: ConversationStoreState, view: string, focus: string) => void
  completeViewRequest: (draft: ConversationStoreState) => void
}

/**
 * Declare per-session draft persistence and View selection.
 * @returns the store handle.
 */
export function createConversationStore(): EngineStoreHandle<ConversationStoreState, ConversationActions> {
  return defineStore({
    init: (): ConversationStoreState => ({ draft: '', view: null, viewRequest: null }),
    persist: { name: CONVERSATION_STORE_KEY, parse: parseConversationState },
    actions: {
      setDraft: (d, text: DraftInput) => { d.draft = text },
      setView: (d, view: string) => { d.view = view },
      openView: (d, view: string, focus: string) => {
        d.view = view
        d.viewRequest = { view, focus }
      },
      completeViewRequest: (d) => { d.viewRequest = null },
    },
  })
}

/** Decode one Session's stored record before its Slot store exists; inaccessible storage and malformed JSON read as absent. */
function readStoredConversation(sessionId: SessionId): ConversationStoreState | undefined {
  if (typeof localStorage === 'undefined') return undefined
  try {
    return parseConversationState(JSON.parse(localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`) ?? 'null'))
  } catch (_error: unknown) {
    // Storage that denies access, or a record that is not JSON, has no usable saved value.
    return undefined
  }
}

/**
 * Read a Session's draft before its input source is published to React.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns saved semantic content, or an empty document when storage is absent or invalid.
 */
export function readConversationDraft(sessionId: SessionId): DraftSnapshot {
  return resolveDraftInput(readStoredConversation(sessionId)?.draft ?? '')
}

/**
 * Read the persisted View preference before the Slot store is materialized.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns the preferred View id, or null when storage has no usable value.
 */
export function readConversationViewPreference(sessionId: SessionId): string | null {
  return readStoredConversation(sessionId)?.view ?? null
}
