/**
 * Model-facing `suggest_follow_up_task` and `dismiss_follow_up_task` tools.
 * A suggestion reserves a Session identity and records a card the user may
 * start later; nothing runs until the user starts it.
 * @module @deepseek-ai/dsh-experimental-tool-follow-up-task
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: resolves the required ctx.sessionProjections service declaration.
import type {} from '@deepseek-ai/dsh-session-projection'
import { followUpTasksProjection } from './projection.ts'

export type * from './contract.ts'

/** Cordis plugin name. */
export const name = 'tool-follow-up-task'
/** Services required to register the follow-up task tools. */
export const inject = ['tools', 'sessionProjections']

/**
 * Register the follow-up task tools in the mounting scope.
 * @param ctx - tool and session-projection registry scope.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(followUpTasksProjection)
  // FIXME(U2-U3): register both tools; see tmp/follow-up-tasks/units/U2-U3.
}
