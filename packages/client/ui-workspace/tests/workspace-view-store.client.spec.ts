/** Workspace viewing-store rehydration from browser storage. */
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceViewStore } from '../src/client/stores.ts'

const KEY = 'dsh.workspace.view.v5'
const SAVED = {
  groupBy: 'flat',
  orderBy: 'manual',
  groupExpansion: { alpha: false },
  sessionOrderByAccount: { alpha: ['second', 'first'] },
}
const INITIAL = createWorkspaceViewStore().spec.init()

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function restore(stored: unknown) {
  const backing = new Map([[KEY, JSON.stringify(stored)]])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value) },
    removeItem: (key: string) => { backing.delete(key) },
  })
  return createWorkspaceViewStore().create().getSnapshot()
}

function without(key: keyof typeof SAVED): Partial<typeof SAVED> {
  return Object.fromEntries(Object.entries(SAVED).filter(([name]) => name !== key))
}

it('restores saved viewing state, with or without the archived filter, and drops obsolete fields', () => {
  expect(restore({ ...SAVED, archivedFilter: 'only', sessionUpdatedAtByAccount: { alpha: { first: 10 } } }))
    .toEqual({ ...SAVED, archivedFilter: 'only' })
  const legacy = restore(SAVED)
  expect(legacy).toEqual(SAVED)
  expect(legacy).not.toHaveProperty('archivedFilter')
})

it.each([
  ['null', null],
  ['a string', 'flat'],
  ['no groupBy', without('groupBy')],
  ['no orderBy', without('orderBy')],
  ['no groupExpansion', without('groupExpansion')],
  ['no sessionOrderByAccount', without('sessionOrderByAccount')],
  ['an unknown groupBy', { ...SAVED, groupBy: 'tree' }],
  ['an unknown orderBy', { ...SAVED, orderBy: 'recent' }],
  ['a null groupExpansion', { ...SAVED, groupExpansion: null }],
  ['an array groupExpansion', { ...SAVED, groupExpansion: [true] }],
  ['a non-boolean expansion', { ...SAVED, groupExpansion: { alpha: 'yes' } }],
  ['a non-array order', { ...SAVED, sessionOrderByAccount: { alpha: 'first' } }],
  ['a non-string order member', { ...SAVED, sessionOrderByAccount: { alpha: [1] } }],
  ['an unknown archived filter', { ...SAVED, archivedFilter: 'all' }],
])('starts from the default view when storage holds %s', (_label, stored) => {
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})

  expect(restore(stored)).toEqual(INITIAL)
  expect(report).toHaveBeenCalledWith(`snapshot store '${KEY}' kept its initial state: the persisted value is invalid`)
})
