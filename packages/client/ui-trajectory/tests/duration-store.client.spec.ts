// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTrajectoryDurationStore } from '../src/client/duration-store.ts'

const key = 'dsh.trajectory.duration'
let original: string | null

beforeEach(() => {
  original = localStorage.getItem(key)
  localStorage.removeItem(key)
})

afterEach(() => {
  if (original === null) localStorage.removeItem(key)
  else localStorage.setItem(key, original)
})

it('restores the last duration choice when the view is recreated', () => {
  createTrajectoryDurationStore().set(true)
  expect(createTrajectoryDurationStore().getSnapshot()).toBe(true)
})

it.each(['null', '"true"', '1', '[]'])('starts in relative time when the stored preference %s is not a boolean', (stored) => {
  localStorage.setItem(key, stored)
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(createTrajectoryDurationStore().getSnapshot()).toBe(false)
    expect(report).toHaveBeenCalledOnce()
  } finally { report.mockRestore() }
})
