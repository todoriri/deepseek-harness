import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { Config } from '@deepseek-ai/dsh-sandbox-local'
import { bwrapProfileArgs } from '../src/profiles.ts'

/**
 * Keyless backend integration through `confine()` and a real bwrap process. With no rung forced,
 * a passing probe must select the first rung. Tests assert world effects, wrap shape, and that the
 * kernel denial matches the advertised dialect; consumer coverage lives in dsh-bash-sandbox.
 * Skips when bwrap or user namespaces are unavailable. HOME-based workspaces avoid bwrap's
 * ephemeral `/tmp`, so workspace-write actually proves the workspace-root rebind.
 */

const probe = spawnSync('bwrap', [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], { timeout: 5_000, stdio: 'ignore' })
const bwrapUsable = probe.status === 0

const contexts: Context[] = []
const tempDirs: string[] = []
const tempFiles: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  for (const file of tempFiles.splice(0)) rmSync(file, { force: true })
})

async function tempDir(base: string): Promise<string> {
  const dir = await mkdtemp(join(base, 'dsh-bwrap-e2e-'))
  tempDirs.push(dir)
  return dir
}

/** A provider under `config` on a fresh Context; a test comparing profiles mounts one per profile. */
async function provider(config: Config = {}): Promise<LocalSandboxProvider> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSandboxProvider, config)
  return ctx.sandbox as LocalSandboxProvider
}

/** A host TCP listener on an ephemeral loopback port that counts the connections it accepts. */
async function hostListener(): Promise<{ port: number; accepted: () => number; close: () => Promise<void> }> {
  let accepted = 0
  const server = createServer((socket) => {
    accepted += 1
    socket.destroy()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('listener has no TCP address')
  return {
    port: address.port,
    accepted: () => accepted,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}

/** Confine a shell command under `policy` and run it for real; returns the spawn result and the wrap's facts. */
async function runConfined(sandbox: LocalSandboxProvider, command: string, policy: SandboxPolicy) {
  const confined = await sandbox.confine(['bash', '-c', command], policy)
  const result = spawnSync(confined.argv[0] as string, confined.argv.slice(1), { timeout: 30_000, encoding: 'utf8' })
  return { result, confined }
}

describe.skipIf(!bwrapUsable)('sandbox-local: real bwrap confinement', () => {
  it('the passing probe selects the bwrap rung naturally — first in the ladder, full enforcement, EROFS dialect', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const confined = await sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: workdir })
    expect(confined.argv[0]).toBe('bwrap')
    expect(confined.enforcement).toBe('full')
    expect(confined.denialSignatures).toEqual(['read-only file system'])
  })

  it('read-only denies a write — the file must NOT exist, and the kernel speaks the advertised dialect', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result } = await runConfined(sandbox, `echo hi > ${workdir}/denied.txt`, { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).not.toBe(0)
    // The wrap's denialSignatures must be what the kernel actually prints.
    expect(result.stderr.toLowerCase()).toContain('read-only file system')
    expect(existsSync(join(workdir, 'denied.txt'))).toBe(false)
  })

  it('read-only keeps the tree readable/executable and the fresh /dev/null writable', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result } = await runConfined(sandbox, 'ls / > /dev/null && echo dev-ok', { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('dev-ok\n')
  })

  it.each(['read-only', 'workspace-write'] as const)(
    '%s runs in a private PID namespace and blocks writes through procfs root magic links',
    async (mode) => {
      const workdir = await tempDir(homedir())
      const outside = await tempDir(homedir())
      const target = join(outside, 'escaped.txt')
      const sandbox = await provider()
      // Compare PID-namespace identity, not PID numbers: numeric /proc entries
      // recur inside a private namespace, and the /proc/1/root write below is
      // denied even in a shared namespace (host init is root-owned), so this
      // comparison is the assertion that fails when --unshare-pid is lost.
      const hostPidNamespace = readlinkSync('/proc/self/ns/pid')
      const visibility = await runConfined(sandbox, 'readlink /proc/self/ns/pid', { mode, workspaceRoot: workdir })
      expect(visibility.result.status).toBe(0)
      expect(visibility.result.stdout.trim()).not.toBe('')
      expect(visibility.result.stdout.trim()).not.toBe(hostPidNamespace)

      const escape = await runConfined(
        sandbox,
        `printf escaped > /proc/1/root${target}`,
        { mode, workspaceRoot: workdir },
      )
      expect(escape.result.status).not.toBe(0)
      expect(existsSync(target)).toBe(false)
    },
  )

  it('hides the host UNIX SOCKETS — the docker daemon and the session bus are not reachable', async () => {
    // review.12.10 (D85): `--ro-bind / /` still hands over every SOCKET, and `--unshare-net`
    // does not close them. Measured 2026-10-12 inside the profile WITHOUT `--tmpfs /run`:
    // `docker version` reached the daemon (29.8.1) and `/run/user/<uid>/bus` was visible, so
    // `systemd-run --user` could act on the host when DBUS_SESSION_BUS_ADDRESS was inherited.
    const workdir = await tempDir(homedir())
    const sandbox = await provider()
    const sockets = await runConfined(
      sandbox,
      'for s in /run/user/$(id -u)/bus /var/run/docker.sock; do [ -S "$s" ] && printf "VISIBLE:%s\\n" "$s"; done; echo done',
      { mode: 'workspace-write', workspaceRoot: workdir },
    )
    expect(sockets.result.status).toBe(0)
    expect(sockets.result.stdout).not.toContain('VISIBLE:')
    // The daemon probe is the escape that matters: a user in the `docker` group is
    // root-equivalent, so reaching the socket is reaching the host filesystem.
    const docker = await runConfined(sandbox, 'docker version >/dev/null 2>&1; echo rc=$?', { mode: 'workspace-write', workspaceRoot: workdir })
    expect(docker.result.stdout.trim()).toBe('rc=1')
    const bus = await runConfined(sandbox, 'systemd-run --user --quiet -- true >/dev/null 2>&1; echo rc=$?', { mode: 'workspace-write', workspaceRoot: workdir })
    expect(bus.result.stdout.trim()).toBe('rc=1')
  })

  it('network "none" closes the host network: the listener the default profile reaches is unreachable', async () => {
    // review.12.10-late finding 2: `--ro-bind / /` plus the host network namespace let a confined
    // command POST whatever it can read. Measured 2026-10-12 on this host inside the default
    // workspace-write profile: a TCP connect to a host listener was accepted. The control run
    // reproduces that acceptance, so the hardened run's refusal is attributable to the profile.
    const workdir = await tempDir(homedir())
    const listener = await hostListener()
    try {
      const connect = `exec 3<>/dev/tcp/127.0.0.1/${listener.port}`
      const open = await runConfined(await provider(), connect, { mode: 'workspace-write', workspaceRoot: workdir })
      expect(open.result.status, open.result.stderr).toBe(0)
      await vi.waitFor(() => { expect(listener.accepted()).toBe(1) })

      const closed = await runConfined(await provider({ network: 'none' }), connect, { mode: 'workspace-write', workspaceRoot: workdir })
      expect(closed.confined.argv).toContain('--unshare-net')
      expect(closed.result.status).not.toBe(0)
      expect(closed.result.stderr.toLowerCase()).toContain('connection refused')
      expect(listener.accepted()).toBe(1)
    } finally {
      await listener.close()
    }
  })

  it('hidePaths masks a home directory: readable on the host and under the default profile, empty and read-only inside, the workspace beneath it still writable', async () => {
    // review.12.10-late finding 2: an unprivileged user namespace changes no ownership, so
    // `--ro-bind / /` hands the command every file the operator can read. Measured 2026-10-12 on
    // this host inside the default workspace-write profile: 10 files under ~/.ssh, 1006 under
    // ~/.dsh, ~/.config/gh/hosts.yml readable. The control run reproduces that read.
    const home = await tempDir(homedir())
    const workdir = await tempDir(home)
    const secret = join(home, 'secret.txt')
    writeFileSync(secret, 'operator-secret')
    expect(readFileSync(secret, 'utf8')).toBe('operator-secret')
    const control = await runConfined(await provider(), `cat ${secret}`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(control.result.stdout).toBe('operator-secret')

    const masked = await runConfined(
      await provider({ hidePaths: [home] }),
      `cat ${secret} 2>/dev/null; echo read-rc=$?; ls -A ${home}; printf x > ${home}/new.txt; echo write-rc=$?; printf ok > ${workdir}/inside.txt && echo ws-ok`,
      { mode: 'workspace-write', workspaceRoot: workdir },
    )
    expect(masked.result.stdout).toContain('read-rc=1')
    expect(masked.result.stdout).not.toContain('secret.txt')
    expect(masked.result.stdout).toContain('write-rc=1')
    expect(masked.result.stderr.toLowerCase()).toContain('read-only file system')
    expect(masked.result.stdout).toContain('ws-ok')
    expect(readFileSync(join(workdir, 'inside.txt'), 'utf8')).toBe('ok')
    expect(existsSync(join(home, 'new.txt'))).toBe(false)
  })

  it('exposeReadOnly binds a toolchain path back into a masked directory, read-only', async () => {
    const home = await tempDir(homedir())
    const workdir = await tempDir(homedir())
    mkdirSync(join(home, 'keep'))
    writeFileSync(join(home, 'keep', 'tool.txt'), 'tool')
    writeFileSync(join(home, 'secret.txt'), 'secret')
    const sandbox = await provider({ hidePaths: [home], exposeReadOnly: [join(home, 'keep')] })
    const { result } = await runConfined(
      sandbox,
      `cat ${home}/keep/tool.txt; cat ${home}/secret.txt 2>/dev/null; echo read-rc=$?; printf x > ${home}/keep/new.txt 2>/dev/null; echo write-rc=$?`,
      { mode: 'workspace-write', workspaceRoot: workdir },
    )
    expect(result.stdout).toBe('toolread-rc=1\nwrite-rc=1\n')
    expect(existsSync(join(home, 'keep', 'new.txt'))).toBe(false)
  })

  it('read-only mode keeps a mask read-only too: hiding a directory adds no writable sink', async () => {
    const home = await tempDir(homedir())
    const workdir = await tempDir(homedir())
    const sandbox = await provider({ hidePaths: [home] })
    const { result } = await runConfined(sandbox, `printf x > ${home}/new.txt`, { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain('read-only file system')
    expect(existsSync(join(home, 'new.txt'))).toBe(false)
  })

  it('the production configuration: real $HOME masked, the network closed, node still runs from its re-exposed prefix', async () => {
    // process.execPath is symlink-resolved; its prefix is exposed only when it lives under HOME
    // (the operator case measured 2026-10-13: ~/.hermes/node), otherwise node is visible anyway.
    const home = homedir()
    const nodePrefix = dirname(dirname(process.execPath))
    const exposeReadOnly = nodePrefix.startsWith(`${home}/`) ? [nodePrefix] : []
    const workdir = await tempDir(homedir())
    const marker = join(home, `dsh-bwrap-e2e-home-marker-${process.pid}.txt`)
    tempFiles.push(marker)
    writeFileSync(marker, 'marker')
    const sandbox = await provider({ network: 'none', hidePaths: [home], exposeReadOnly })
    const { result, confined } = await runConfined(
      sandbox,
      `${process.execPath} -e "process.stdout.write(process.version)"; echo; cat ${marker} 2>/dev/null; echo read-rc=$?`,
      { mode: 'workspace-write', workspaceRoot: workdir },
    )
    expect(confined.argv).toEqual(expect.arrayContaining(['--unshare-net', '--tmpfs', home, '--remount-ro']))
    expect(result.stdout, result.stderr).toBe(`${process.version}\nread-rc=1\n`)
  })

  it('keeps descendants observable and controllable inside the private PID namespace', async () => {
    const workdir = await tempDir(homedir())
    const sandbox = await provider()
    const { result } = await runConfined(
      sandbox,
      'sleep 30 & child=$!; kill -0 "$child" && kill "$child"; wait "$child"; status=$?; test "$status" -ge 128',
      { mode: 'read-only', workspaceRoot: workdir },
    )
    expect(result.status).toBe(0)
  })

  it('workspace-write lands a write inside the workspace root and still denies one beside it', async () => {
    const workdir = await tempDir(homedir())
    const outside = await tempDir(homedir())
    const sandbox = await provider()

    const inside = await runConfined(sandbox, `printf bwrap-ok > ${workdir}/allowed.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(inside.result.status).toBe(0)
    expect(readFileSync(join(workdir, 'allowed.txt'), 'utf8')).toBe('bwrap-ok')

    const denied = await runConfined(sandbox, `echo hi > ${outside}/denied.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(denied.result.status).not.toBe(0)
    expect(existsSync(join(outside, 'denied.txt'))).toBe(false)
  })

  it('workspace-write mounts an EPHEMERAL /tmp: the write succeeds inside, the host /tmp stays untouched', async () => {
    // The documented bwrap-profile difference: Landlock and Seatbelt grant
    // the HOST temp areas, bwrap swaps in a fresh tmpfs that dies with the
    // process — the strongest of the three temp semantics.
    const workdir = await tempDir(homedir())
    const target = `/tmp/dsh-bwrap-e2e-ephemeral-${process.pid}.txt`
    tempFiles.push(target)
    const sandbox = await provider()
    const { result } = await runConfined(sandbox, `printf tmp-ok > ${target} && cat ${target}`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('tmp-ok')
    expect(existsSync(target)).toBe(false)
  })
})
