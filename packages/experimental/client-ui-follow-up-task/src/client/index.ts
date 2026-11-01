/** Web cards for logged follow-up task suggestions: start, open, or dismiss each one. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** Client services the cards consume. */
export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'uiConversation', 'uiWorkspace']

/**
 * Register the follow-up task Conversation definition and turn-tail cards.
 * @param _ctx - client root context.
 */
export function apply(_ctx: ClientContext): void {
  // FIXME(U9): register the locale, definition, dismissal store, and turn-tail cards; see tmp/follow-up-tasks/units/U9.
}
