/**
 * The Host half of the follow-up task package is an intentional no-op: the package exists for its
 * browser-discovered client half, and this entry point only satisfies the Cordis plugin contract
 * for compositions that load it without a browser.
 */

import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('follow-up task host apply', () => {
  it('is an intentional no-op', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
