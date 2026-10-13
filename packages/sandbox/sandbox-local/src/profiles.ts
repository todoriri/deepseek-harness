/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/**
 * The UNIX-SOCKET hardening every bwrap profile carries.
 *
 * `--ro-bind / /` still hands over every SOCKET on the host, and `--unshare-net` does not
 * close them (it is a network namespace, not a socket namespace). Measured 2026-10-12 on this
 * host inside the profile WITHOUT these args: `docker version` reached the daemon through
 * `/var/run/docker.sock` (and a user in the `docker` group is root-equivalent), and the
 * session bus was visible at `/run/user/<uid>/bus` so `systemd-run --user` could act on the
 * host when `DBUS_SESSION_BUS_ADDRESS` was in the environment. `--tmpfs /run` hides both
 * (`/var/run` is a symlink to `/run`), `--unshare-ipc` closes the IPC namespace,
 * `--new-session` denies the controlling tty (TIOCSTI), and `--cap-drop ALL` removes the
 * capabilities a confined process should never hold.
 */
const BWRAP_SOCKET_HARDENING = ['--tmpfs', '/run', '--unshare-ipc', '--new-session', '--cap-drop', 'ALL']

/**
 * Deployment-level bwrap hardening beyond the file-effect policy. The policy seam expresses file
 * effects only; this is the operator's standing choice for every confined command, carried on the
 * provider rather than per call. Only the bwrap runner (and an operator `runnerCommand`, which
 * asserts bwrap compatibility) can express it; the provider refuses every other rung when a field
 * departs from {@link DEFAULT_BWRAP_HARDENING}.
 */
export interface BwrapHardening {
  /**
   * `none` runs the command in a fresh network namespace holding only its own loopback: no host
   * service, no LAN, no internet. The model transport runs in the harness process, outside the
   * sandbox, so provider access is unaffected.
   */
  network: 'inherit' | 'none'
  /**
   * Canonical absolute directories every confined command sees as an empty read-only directory.
   * The intended entry is the operator's `$HOME`: an unprivileged user namespace changes no
   * ownership, so under `--ro-bind / /` the command otherwise reads `~/.ssh`, `~/.config/gh`, and
   * the harness credential files. The workspace root and `/tmp` stay writable beneath a mask.
   */
  hidePaths: readonly string[]
  /**
   * Canonical absolute paths beneath a {@link hidePaths} entry bound back read-only: the toolchain
   * a command still needs from a masked home (a node prefix, `~/.local/bin`). Which paths survive
   * is the operator's list in cordis.yml, never a constant here, because toolchain locations vary
   * per host; the provider validates the list at load.
   */
  exposeReadOnly: readonly string[]
}

/** The hardening every profile carries without operator configuration: the host network and tree as `--ro-bind / /` presents them. */
export const DEFAULT_BWRAP_HARDENING: BwrapHardening = { network: 'inherit', hidePaths: [], exposeReadOnly: [] }

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @param hardening - the provider's standing hardening; defaults to the host network and tree.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy, hardening: BwrapHardening = DEFAULT_BWRAP_HARDENING): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', ...BWRAP_SOCKET_HARDENING]
  if (hardening.network === 'none') args.push('--unshare-net')
  // Mount order is the mechanism. Each mask starts as a writable tmpfs so bwrap can create the
  // mountpoints beneath it (the exposed paths, then the workspace) and turns read-only LAST;
  // `--remount-ro` is not recursive, so a workspace bound beneath a mask stays writable. Measured
  // 2026-10-13 on this host: a mask remounted before its exposures fails with
  // `bwrap: Can't mkdir <exposed>: Read-only file system`.
  for (const path of hardening.hidePaths) args.push('--tmpfs', path)
  for (const path of hardening.exposeReadOnly) args.push('--ro-bind', path, path)
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  for (const path of hardening.hidePaths) args.push('--remount-ro', path)
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return ['-p', forms.join(' ')]
}
