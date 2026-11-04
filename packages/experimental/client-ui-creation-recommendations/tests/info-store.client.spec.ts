// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { createCreationInfoStore } from '../src/client/info-store.ts'

afterEach(() => { localStorage.clear() })

it('keeps the first notice visible until acknowledged and remembers that across plugin reloads', () => {
  const first = createCreationInfoStore()
  expect(first.getSnapshot()).toBe(false)
  first.set(true)
  expect(createCreationInfoStore().getSnapshot()).toBe(true)
})

it('keeps the notice visible when the stored acknowledgement is not a boolean', () => {
  localStorage.setItem('dsh.creation-recommendations.info-dismissed', JSON.stringify('yes'))
  expect(createCreationInfoStore().getSnapshot()).toBe(false)
})
