/** Existing browser-local navigation records, independent from live frame state. */
import type { BrowserAddressFailure, BrowserTarget } from './url.ts'

/** One retained address. */
export type BrowserHistoryEntry = BrowserTarget

/** Observability recorded for a controlled navigation. */
export type BrowserNavigationStatus =
  | { readonly status: 'empty' }
  | { readonly status: 'loading'; readonly revision: number }
  | { readonly status: 'known'; readonly revision: number }
  | { readonly status: 'unknown'; readonly revision: number }

/** Address refusal carried by existing browser-local records. */
export type BrowserFailure = { readonly kind: 'address'; readonly reason: BrowserAddressFailure }

/** Serializable record; providers retain the history they can restore. */
export interface BrowserTabState {
  readonly entries: readonly BrowserHistoryEntry[]
  readonly index: number
  readonly request: { readonly revision: number; readonly target: BrowserTarget } | undefined
  readonly navigation: BrowserNavigationStatus
  readonly failure: BrowserFailure | undefined
}

const NAVIGATION_STATUSES = ['loading', 'known', 'unknown'] as const
const ADDRESS_FAILURES: readonly BrowserAddressFailure[] = ['empty', 'invalid', 'protocol', 'credentials', 'application-origin']

/** Admit one stored address with an allowed protocol kind; restoring it still re-validates the URL. */
function parseTarget(value: unknown): BrowserTarget | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value) || !('url' in value) || !('title' in value)) return undefined
  const { kind, url, title } = value
  if (typeof url !== 'string' || typeof title !== 'string') return undefined
  return kind === 'https' || kind === 'http' ? { kind, url, title } : undefined
}

function parseNavigation(value: unknown): BrowserNavigationStatus | undefined {
  if (typeof value !== 'object' || value === null || !('status' in value)) return undefined
  if (value.status === 'empty') return { status: 'empty' }
  if (!('revision' in value) || typeof value.revision !== 'number') return undefined
  const { revision } = value
  const status = NAVIGATION_STATUSES.find(candidate => candidate === value.status)
  return status === undefined ? undefined : { status, revision }
}

function parseRequest(value: unknown): BrowserTabState['request'] {
  if (typeof value !== 'object' || value === null || !('revision' in value) || !('target' in value)) return undefined
  const target = parseTarget(value.target)
  return typeof value.revision === 'number' && target !== undefined ? { revision: value.revision, target } : undefined
}

function parseFailure(value: unknown): BrowserFailure | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'address' || !('reason' in value)) return undefined
  const reason = ADDRESS_FAILURES.find(candidate => candidate === value.reason)
  return reason === undefined ? undefined : { kind: 'address', reason }
}

/**
 * Admit one stored tab record. JSON omits the undefined `request` and
 * `failure`; present ones must be well formed, and `index` must select an
 * entry or be -1.
 * @param value - one decoded tab record from browser storage.
 * @returns the record, or undefined when any field is malformed.
 */
export function parseBrowserTabState(value: unknown): BrowserTabState | undefined {
  if (typeof value !== 'object' || value === null
    || !('entries' in value) || !('index' in value) || !('navigation' in value)) return undefined
  const { entries, index } = value
  if (!Array.isArray(entries) || typeof index !== 'number' || !Number.isInteger(index)
    || index < -1 || index >= entries.length) return undefined
  const targets = entries.map(parseTarget)
  const navigation = parseNavigation(value.navigation)
  const request = 'request' in value ? parseRequest(value.request) : undefined
  const failure = 'failure' in value ? parseFailure(value.failure) : undefined
  if (!targets.every((target): target is BrowserTarget => target !== undefined) || navigation === undefined
    || ('request' in value && request === undefined) || ('failure' in value && failure === undefined)) return undefined
  return { entries: targets, index, request, navigation, failure }
}

/**
 * Read the selected address from a saved navigation record.
 * @param state - saved navigation.
 * @returns its last selected address, if any.
 */
export function currentBrowserTarget(state: BrowserTabState | undefined): BrowserTarget | undefined {
  return state === undefined || state.index < 0 ? undefined : state.entries[state.index]
}

/**
 * Checkpoint an observed address without serializing native history.
 * @param target - current address.
 * @param revision - navigation generation.
 * @returns an address-only checkpoint.
 */
export function browserAddressCheckpoint(target: BrowserTarget, revision: number): BrowserTabState {
  return { entries: [target], index: 0, request: { target, revision },
    navigation: { status: 'known', revision }, failure: undefined }
}
