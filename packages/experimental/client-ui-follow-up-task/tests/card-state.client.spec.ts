/** `followUpTaskCardState` applies the card-state table, first match wins. */

import { describe, expect, it } from 'vitest'
import { followUpTaskCardState } from '../src/client/card-state.ts'
import type { FollowUpTaskCardInputs } from '../src/client/card-state.ts'

/**
 * Inputs with no Session row, no withdrawal, no local dismissal, and no archive entry.
 * @param overrides - inputs to replace.
 * @returns the complete inputs.
 */
function inputs(overrides: Partial<FollowUpTaskCardInputs> = {}): FollowUpTaskCardInputs {
  return { withdrawn: false, dismissedByUser: false, session: undefined, archived: false, ...overrides }
}

describe('followUpTaskCardState', () => {
  it('reports started when a non-blank Session exists under the reserved id', () => {
    expect(followUpTaskCardState(inputs({ session: { blank: false } }))).toBe('started')
  })

  it('reports drafted when a blank Session exists under the reserved id', () => {
    expect(followUpTaskCardState(inputs({ session: { blank: true } }))).toBe('drafted')
  })

  it('reports withdrawn when the agent withdrew the suggestion', () => {
    expect(followUpTaskCardState(inputs({ withdrawn: true }))).toBe('withdrawn')
  })

  it('reports dismissed when the user dismissed it in this browser', () => {
    expect(followUpTaskCardState(inputs({ dismissedByUser: true }))).toBe('dismissed')
  })

  it('reports available when nothing applies', () => {
    expect(followUpTaskCardState(inputs())).toBe('available')
  })

  it('prefers started over withdrawal and dismissal', () => {
    expect(followUpTaskCardState(inputs({
      session: { blank: false }, withdrawn: true, dismissedByUser: true,
    }))).toBe('started')
  })

  it('prefers drafted over withdrawal', () => {
    expect(followUpTaskCardState(inputs({ session: { blank: true }, withdrawn: true }))).toBe('drafted')
  })

  it('prefers withdrawal over dismissal', () => {
    expect(followUpTaskCardState(inputs({ withdrawn: true, dismissedByUser: true }))).toBe('withdrawn')
  })

  it('counts an archived id as started without a Session row', () => {
    expect(followUpTaskCardState(inputs({ archived: true }))).toBe('started')
  })
})
