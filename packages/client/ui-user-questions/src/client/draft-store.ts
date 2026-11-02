/**
 * Session-scoped draft state for the generic question composer. The Slot
 * registry owns store instances; this module exports only the factory so a
 * plugin reload cannot reuse a module-global handle.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** One in-progress answer, including an explicit skip. */
export interface QuestionDraftAnswer {
  /** Offered labels currently selected. */
  selected: string[]
  /** Human-authored alternative or additional answer. */
  custom: string
  /** Whether the user explicitly skipped this question. */
  skipped: boolean
}

/** Navigation and answer drafts for one pending request. */
export interface QuestionDraftProgress {
  /** Current question index. */
  index: number
  /** One draft per question, in request order. */
  drafts: QuestionDraftAnswer[]
  /** Local indefinite-wait choice restored with the draft. */
  wait?: 'editing' | 'waiting'
}

interface QuestionDraftState {
  progressByRequest: Record<string, QuestionDraftProgress>
}

type QuestionDraftActions = {
  replace: (draft: QuestionDraftState, requestKey: string, progress: QuestionDraftProgress) => void
  clear: (draft: QuestionDraftState, requestKey: string) => void
  prune: (draft: QuestionDraftState, keep: readonly string[]) => void
}

function parseDraftAnswer(value: unknown): QuestionDraftAnswer | undefined {
  if (typeof value !== 'object' || value === null
    || !('selected' in value) || !('custom' in value) || !('skipped' in value)) return undefined
  const { selected, custom, skipped } = value
  if (!Array.isArray(selected) || typeof custom !== 'string' || typeof skipped !== 'boolean') return undefined
  const labels: unknown[] = selected
  return labels.every((label): label is string => typeof label === 'string') ? { selected: labels, custom, skipped } : undefined
}

/** Admit one request's stored progress; whether it fits the current question batch is the composer's check. */
function parseDraftProgress(value: unknown): QuestionDraftProgress | undefined {
  if (typeof value !== 'object' || value === null || !('index' in value) || !('drafts' in value)) return undefined
  const { index, drafts } = value
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || !Array.isArray(drafts)) return undefined
  const answers = drafts.map(parseDraftAnswer)
  if (!answers.every((answer): answer is QuestionDraftAnswer => answer !== undefined)) return undefined
  if (!('wait' in value)) return { index, drafts: answers }
  const { wait } = value
  return wait === 'editing' || wait === 'waiting' ? { index, drafts: answers, wait } : undefined
}

/** Admit stored drafts, dropping each malformed request's progress and keeping the rest. */
function parseQuestionDraftState(value: unknown): QuestionDraftState | undefined {
  if (typeof value !== 'object' || value === null || !('progressByRequest' in value)) return undefined
  const { progressByRequest } = value
  if (typeof progressByRequest !== 'object' || progressByRequest === null || Array.isArray(progressByRequest)) return undefined
  const admitted: Record<string, QuestionDraftProgress> = {}
  for (const [requestKey, saved] of Object.entries(progressByRequest)) {
    const progress = parseDraftProgress(saved)
    if (progress !== undefined) admitted[requestKey] = progress
  }
  return { progressByRequest: admitted }
}

/**
 * Declare the question composer's Session store. Drafts persist per Session so
 * leaving the Session or restarting the Client does not erase an unfinished answer.
 * @returns a persisted store handle whose instance is owned by the Slot registry.
 */
export function createQuestionDraftStore(): EngineStoreHandle<QuestionDraftState, QuestionDraftActions> {
  return defineStore({
    init: (): QuestionDraftState => ({ progressByRequest: {} }),
    persist: { name: 'dsh.user-questions.drafts.v1', parse: parseQuestionDraftState },
    actions: {
      replace: (draft, requestKey, progress) => {
        draft.progressByRequest[requestKey] = progress
      },
      clear: (draft, requestKey) => {
        draft.progressByRequest = Object.fromEntries(
          Object.entries(draft.progressByRequest).filter(([key]) => key !== requestKey),
        )
      },
      prune: (draft, keep) => {
        const live = new Set(keep)
        draft.progressByRequest = Object.fromEntries(
          Object.entries(draft.progressByRequest).filter(([key]) => live.has(key)),
        )
      },
    },
  })
}
