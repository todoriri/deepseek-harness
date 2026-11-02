import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { browserAddressCheckpoint } from '../src/client/browser/BrowserPersistence.ts'
import { BrowserNavigation } from '../src/client/browser/BrowserNavigation.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'

const TAB = 'browser-tab' as TabId
const KEY = 'dsh.sidebar-browser.v1'
const TARGET = { kind: 'https', url: 'https://example.test/', title: 'example.test' } as const

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Create a root-scope store over storage holding `stored` as JSON. */
function restore(stored: unknown) {
  const backing = new Map([[KEY, JSON.stringify(stored)]])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value) },
    removeItem: (key: string) => { backing.delete(key) },
  })
  return createBrowserStore().create().getSnapshot()
}

describe('Browser persistence store', () => {
  it('replaces snapshots and forgets only the closed tab', () => {
    const store = createBrowserStore().create()
    const first = new BrowserNavigation()
    first.navigate({ kind: 'https', url: 'https://example.test/', title: 'example.test' })
    store.actions.replace(TAB, first.snapshot)
    const other = 'other-tab' as TabId
    store.actions.replace(other, BrowserNavigation.empty())
    expect(BrowserNavigation.current(store.getSnapshot().byTab[TAB])?.url).toBe('https://example.test/')
    store.actions.forget(TAB)
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
    expect(store.getSnapshot().byTab[other]).toBeDefined()
  })

  it('restores well-formed tabs and drops each malformed tab record', () => {
    const checkpoint = browserAddressCheckpoint(TARGET, 3)
    const valid = {
      empty: BrowserNavigation.empty(),
      checkpoint,
      http: browserAddressCheckpoint({ kind: 'http', url: 'http://example.test/', title: 'example.test' }, 1),
      refused: { ...BrowserNavigation.empty(), failure: { kind: 'address', reason: 'protocol' } },
      loading: { ...checkpoint, navigation: { status: 'loading', revision: 4 } },
    }
    const malformed: Record<string, unknown> = {
      null: null,
      noEntries: { index: -1, navigation: { status: 'empty' } },
      noIndex: { entries: [], navigation: { status: 'empty' } },
      noNavigation: { entries: [], index: -1 },
      entriesObject: { ...checkpoint, entries: {} },
      indexText: { ...checkpoint, index: '0' },
      indexFraction: { ...checkpoint, index: 0.5 },
      indexBelow: { ...checkpoint, index: -2 },
      indexPast: { ...checkpoint, index: 1 },
      entryNull: { ...checkpoint, entries: [null] },
      entryFields: { ...checkpoint, entries: [{ kind: 'https' }] },
      entryUrl: { ...checkpoint, entries: [{ ...TARGET, url: 1 }] },
      entryKind: { ...checkpoint, entries: [{ ...TARGET, kind: 'ftp' }] },
      navigationNull: { ...checkpoint, navigation: null },
      navigationRevision: { ...checkpoint, navigation: { status: 'known' } },
      navigationRevisionText: { ...checkpoint, navigation: { status: 'known', revision: '3' } },
      navigationStatus: { ...checkpoint, navigation: { status: 'paused', revision: 3 } },
      requestNull: { ...checkpoint, request: null },
      requestTarget: { ...checkpoint, request: { revision: 3 } },
      requestRevision: { ...checkpoint, request: { revision: '3', target: TARGET } },
      requestEntry: { ...checkpoint, request: { revision: 3, target: { ...TARGET, kind: 'file' } } },
      failureNull: { ...checkpoint, failure: null },
      failureKind: { ...checkpoint, failure: { kind: 'network', reason: 'empty' } },
      failureReasonMissing: { ...checkpoint, failure: { kind: 'address' } },
      failureReason: { ...checkpoint, failure: { kind: 'address', reason: 'timeout' } },
    }

    expect(restore({ byTab: { ...valid, ...malformed } })).toEqual({ byTab: valid })
  })

  it.each([null, 'tabs', {}, { byTab: null }, { byTab: [] }])('starts without tabs when storage holds %j', (stored) => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(restore(stored)).toEqual({ byTab: {} })
    expect(report).toHaveBeenCalledWith(`snapshot store '${KEY}' kept its initial state: the persisted value is invalid`)
  })
})
