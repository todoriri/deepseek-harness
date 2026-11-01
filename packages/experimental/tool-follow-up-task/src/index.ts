/**
 * Model-facing `suggest_follow_up_task` and `dismiss_follow_up_task` tools.
 * A suggestion reserves a Session identity and records a card the user may
 * start later; nothing runs until the user starts it.
 * @module @deepseek-ai/dsh-experimental-tool-follow-up-task
 */

import type { Context } from '@deepseek-ai/cordis'

export type * from './contract.ts'

/** Cordis plugin name. */
export const name = 'tool-follow-up-task'
/** Services required to register the follow-up task tools. */
export const inject = ['tools']

/**
 * Register the follow-up task tools in the mounting scope.
 * @param _ctx - tool registry scope.
 */
export function apply(_ctx: Context): void {
  // FIXME(U1-U3): register the followUpTasks projection and both tools; see tmp/follow-up-tasks/units/U1-U3.
}
