/** Explicit source Web layer for the follow-up task card scenario. */
import { fileURLToPath } from 'node:url'
import type { LaunchOptions } from './scaffold.ts'

/** The experimental tool and card packages installed as this scenario's Web layer. */
export const FOLLOW_UP_TASK_FIXTURE = {
  extraOverlayPath: fileURLToPath(new URL('../../../packages/experimental/tool-follow-up-task/cordis.patch.yml', import.meta.url)),
  extraInstallAnchors: [
    fileURLToPath(new URL('../../../packages/experimental/tool-follow-up-task/package.json', import.meta.url)),
    fileURLToPath(new URL('../../../packages/experimental/client-ui-follow-up-task/package.json', import.meta.url)),
  ],
} satisfies Pick<LaunchOptions, 'extraOverlayPath' | 'extraInstallAnchors'>
