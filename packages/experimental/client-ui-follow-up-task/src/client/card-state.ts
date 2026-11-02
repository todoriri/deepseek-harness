/** Card state of one follow-up task suggestion, from its withdrawal, this browser's dismissals, and the Session and archive lists. */

/** What one follow-up task card shows and offers. */
export type FollowUpTaskCardState = 'started' | 'drafted' | 'withdrawn' | 'dismissed' | 'available'

/** Inputs observed by the card for one follow-up task suggestion. */
export interface FollowUpTaskCardInputs {
  /** Whether the agent withdrew the suggestion with a later dismissal record. */
  readonly withdrawn: boolean
  /** Whether this browser holds a local dismissal for the suggestion. */
  readonly dismissedByUser: boolean
  /** The listed Session under the reserved id, if any. */
  readonly session: { readonly blank: boolean } | undefined
  /** Whether the reserved id is among the Workspace's archived Session ids. */
  readonly archived: boolean
}

/**
 * Derive the card state for one suggestion; the first matching row wins.
 * @param inputs - withdrawal, local dismissal, Session row, and archive facts.
 * @returns the card state to render.
 */
export function followUpTaskCardState(inputs: FollowUpTaskCardInputs): FollowUpTaskCardState {
  if (inputs.archived || (inputs.session !== undefined && !inputs.session.blank)) return 'started'
  if (inputs.session !== undefined) return 'drafted'
  if (inputs.withdrawn) return 'withdrawn'
  if (inputs.dismissedByUser) return 'dismissed'
  return 'available'
}
