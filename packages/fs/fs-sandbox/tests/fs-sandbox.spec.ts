/**
 * Tests for the sandbox-enforcing filesystem backend: the per-call policy fence
 * on write/edit (read-only denies, workspace-write contains, danger-full-access
 * passes through), reads passing through by default, the optional read fence
 * (`fenceReads` contains the content-bearing reads to the same roots the writes
 * use, and only ever narrows), the capability fact, and the containment matrix —
 * `..` traversal, absolute paths outside, and symlink escapes (a symlinked
 * directory inside the workspace pointing out, and a new file created under one).
 * The fence is exercised on a real filesystem: a denied write leaves no file on
 * disk, and a denied read returns no content.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from '../../../../scripts/snapshot-workspace-parent.ts'

let base: string
let workspace: string
let outside: string
let ctx: Context
let fs: SandboxedFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

async function boot(mode: SandboxMode, options: { fenceReads?: boolean } = {}): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  fiber = await ctx.plugin(SandboxedFileSystem, { cwd: workspace, ...options })
  fs = ctx.fs as SandboxedFileSystem
}

beforeEach(async ({ onTestFinished }) => {
  // Both siblings must be outside automatic temp grants for containment denials to be meaningful.
  const directory = await mkdtemp(join(outsideTempWorkspaceParent(), '.dsh-fssbx-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  base = directory
  assertWorkspaceOutsideTemp(base)
  workspace = join(base, 'ws')
  outside = join(base, 'out')
  await mkdir(workspace)
  await mkdir(outside)
})
afterEach(async () => {
  await fiber?.dispose()
})

/** Resolve a path through the backend and return its target. */
function target(path: string): Promise<FsTarget> {
  return fs.resolve(path)
}

describe('the capability fact', () => {
  it('reports the deployment default mode (what the tool layer advertises against)', async () => {
    await boot('workspace-write')
    expect(fs.sandboxMode).toBe('workspace-write')
  })
})

describe('read-only', () => {
  beforeEach(() => boot('read-only'))

  it('denies write, leaving no file on disk', async () => {
    const path = join(workspace, 'denied.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('denies edit of an existing file (the content is unchanged)', async () => {
    const path = join(workspace, 'file.txt')
    await writeFile(path, 'original')
    await expect(fs.editText(await target(path), { oldString: 'original', newString: 'changed', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('original')
  })

  it('allows reads (every mode permits reading)', async () => {
    const path = join(workspace, 'readable.txt')
    await writeFile(path, 'hello')
    expect(await fs.readText(await target(path))).toBe('hello')
  })
})

describe('workspace-write containment', () => {
  beforeEach(() => boot('workspace-write'))

  it('a write under the workspace lands', async () => {
    const path = join(workspace, 'nested', 'ok.txt')
    const outcome = await fs.writeText(await target(path), 'inside')
    expect(outcome.operation).toBe('create')
    expect(await readFile(path, 'utf8')).toBe('inside')
  })

  it('a write to the platform temp area lands (parity with the bash runner grant)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fssbx-tmp-'))
    try {
      const path = join(dir, 'temp.txt')
      await fs.writeText(await target(path), 'temp')
      expect(await readFile(path, 'utf8')).toBe('temp')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('an absolute path outside the workspace is denied, no file created', async () => {
    const path = join(outside, 'escape.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('a `..` traversal out of the workspace is denied', async () => {
    const path = join(workspace, '..', 'sibling-escape.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(workspace, '..', 'sibling-escape.txt'))).toBe(false)
  })

  it('a symlinked directory inside the workspace pointing OUT is denied (canonicalized before containment)', async () => {
    // workspace/link -> outside ; writing workspace/link/f.txt would land in outside/f.txt.
    await symlink(outside, join(workspace, 'link'))
    const path = join(workspace, 'link', 'f.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(outside, 'f.txt'))).toBe(false)
  })

  it('a NEW file created under a symlinked-out directory is denied (deepest-ancestor realpath)', async () => {
    await symlink(outside, join(workspace, 'link'))
    const path = join(workspace, 'link', 'newdir', 'deep.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(outside, 'newdir'))).toBe(false)
  })

  it('an edit outside the workspace is denied; the original is untouched', async () => {
    const path = join(outside, 'file.txt')
    await writeFile(path, 'original')
    await expect(fs.editText(await target(path), { oldString: 'original', newString: 'x', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('original')
  })

  it('an edit inside the workspace lands', async () => {
    const path = join(workspace, 'edit.txt')
    await writeFile(path, 'original')
    const outcome = await fs.editText(await target(path), { oldString: 'original', newString: 'changed', replaceAll: false })
    expect(outcome.after).toBe('changed')
    expect(await readFile(path, 'utf8')).toBe('changed')
  })

  it('mutates the freshly checked identity, not a stale outside targetKey (TOCTOU direction)', async () => {
    // A target whose displayPath is inside the workspace but whose targetKey is
    // a STALE outside path — as if an ancestor symlink pointed out at the tool's
    // resolve() and was swapped in before the write. The fence re-resolves
    // displayPath (now inside) AND delegates with that fresh target, so the byte
    // lands inside and the stale outside path is never written.
    const insidePath = join(workspace, 'landed.txt')
    const staleTarget: FsTarget = { displayPath: insidePath, targetKey: FsTargetKey(join(outside, 'escaped.txt')) }
    await fs.writeText(staleTarget, 'inside')
    expect(await readFile(insidePath, 'utf8')).toBe('inside')
    expect(existsSync(join(outside, 'escaped.txt'))).toBe(false)
  })

  it('the workspace root itself passes the fence (path equal to a writable root), failing only on file type', async () => {
    // isUnder's path-equals-root branch: the fence allows the root, and the
    // write then fails because the root is a directory, not a regular file.
    await expect(fs.writeText(await target(workspace), 'x')).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })
})

describe('workspace-write with the filesystem root as the workspace (a root ending in the path separator)', () => {
  it('grants writes anywhere on that volume', async () => {
    // A degenerate but valid config: the filesystem root containing the target.
    // It exercises the separator-suffixed-root branch on POSIX and Windows.
    const rootCtx = new Context()
    await rootCtx.plugin(SessionProjectionRegistry)
    await rootCtx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: parse(base).root })
    const rootFiber = await rootCtx.plugin(SandboxedFileSystem, { cwd: workspace })
    const rootFs = rootCtx.fs as SandboxedFileSystem
    try {
      const path = join(base, 'anywhere.txt') // outside temp — allowed only via the filesystem root
      await rootFs.writeText(await rootFs.resolve(path), 'anywhere')
      expect(await readFile(path, 'utf8')).toBe('anywhere')
    } finally {
      await rootFiber.dispose()
    }
  })
})

describe('the read fence (fenceReads)', () => {
  describe('default: off', () => {
    beforeEach(() => boot('workspace-write'))

    it('reads a file outside the workspace — the historical behaviour, and the reason the option exists', async () => {
      const path = join(outside, 'secret.txt')
      await writeFile(path, 'operator-secret')
      expect(await fs.readText(await target(path))).toBe('operator-secret')
    })
  })

  describe('workspace-write with fenceReads: true', () => {
    beforeEach(() => boot('workspace-write', { fenceReads: true }))

    it('reads a file inside the workspace', async () => {
      const path = join(workspace, 'readable.txt')
      await writeFile(path, 'hello')
      expect(await fs.readText(await target(path))).toBe('hello')
    })

    it('reads in the platform temp area (parity with the write grant)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-fssbx-read-'))
      try {
        const path = join(dir, 'temp.txt')
        await writeFile(path, 'temp')
        expect(await fs.readText(await target(path))).toBe('temp')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('denies an absolute path outside the workspace (the operator credential the bash mask cannot cover)', async () => {
      const path = join(outside, 'secret.txt')
      await writeFile(path, 'operator-secret')
      await expect(fs.readText(await target(path))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    })

    it('denies streamText, readBytes, readByteRange and listDir outside the workspace', async () => {
      const path = join(outside, 'secret.txt')
      await writeFile(path, 'operator-secret')
      // Awaited one at a time: passing `[fs.readText(...)]` to `Promise.all` would
      // leave the later rejections unhandled and vitest would flag the run.
      await expect(fs.readText(await target(path))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(fs.streamText(await target(path))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(fs.readBytes(await target(path), undefined, 1024)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(fs.readByteRange(await target(path), { offset: 0, length: 4 })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(fs.listDir(await target(outside))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    })

    it('denies a read through a symlinked directory inside the workspace pointing OUT (canonicalized)', async () => {
      // workspace/link -> outside ; reading workspace/link/f.txt would read outside/f.txt.
      await symlink(outside, join(workspace, 'link'))
      const path = join(workspace, 'link', 'f.txt')
      await writeFile(join(outside, 'f.txt'), 'escaped')
      await expect(fs.readText(await target(path))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    })

    it('denies a read whose stale targetKey points outside while its displayPath is inside', async () => {
      // The TOCTOU direction: a target resolved while an ancestor pointed out, whose
      // displayPath now reads inside. The fence re-resolves displayPath and reads THAT,
      // so the stale outside identity is never opened.
      const insidePath = join(workspace, 'landed.txt')
      await writeFile(insidePath, 'inside')
      await writeFile(join(outside, 'escaped.txt'), 'outside')
      const staleTarget: FsTarget = { displayPath: insidePath, targetKey: FsTargetKey(join(outside, 'escaped.txt')) }
      expect(await fs.readText(staleTarget)).toBe('inside')
    })

    it('leaves metadata reads unfenced (stat reveals existence, never content)', async () => {
      const path = join(outside, 'secret.txt')
      await writeFile(path, 'operator-secret')
      expect((await fs.stat(await target(path)))?.type).toBe('file')
    })
  })

  describe('read-only with fenceReads: true', () => {
    beforeEach(() => boot('read-only', { fenceReads: true }))

    it('still permits every read — the fence NARROWS workspace-write, it never grants', async () => {
      const path = join(outside, 'secret.txt')
      await writeFile(path, 'operator-secret')
      expect(await fs.readText(await target(path))).toBe('operator-secret')
    })
  })
})

describe('danger-full-access', () => {
  beforeEach(() => boot('danger-full-access'))

  it('writes anywhere, unfenced', async () => {
    const path = join(outside, 'free.txt')
    await fs.writeText(await target(path), 'free')
    expect(await readFile(path, 'utf8')).toBe('free')
  })
})

describe('the per-call policy override (escalation)', () => {
  it('a workspace-write stamp on a read-only default lets a contained write land for that call only', async () => {
    await boot('read-only')
    const path = join(workspace, 'escalated.txt')
    // Default read-only would deny; the per-call workspace-write policy allows it (contained).
    await fs.writeText(await target(path), 'granted', undefined, undefined, { mode: 'workspace-write', workspaceRoot: workspace })
    expect(await readFile(path, 'utf8')).toBe('granted')
    // A neighboring plain call still runs under the read-only default.
    await expect(fs.writeText(await target(join(workspace, 'plain.txt')), 'x'))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('a danger-full-access stamp bypasses the fence for that call', async () => {
    await boot('read-only')
    const path = join(outside, 'granted-full.txt')
    await fs.writeText(await target(path), 'full', undefined, undefined, { mode: 'danger-full-access', workspaceRoot: workspace })
    expect(await readFile(path, 'utf8')).toBe('full')
  })
})

describe('registration and HMR safety', () => {
  it('registers as ctx.fs and unregisters cleanly from a child fiber', async () => {
    await boot('workspace-write')
    expect(ctx.fs).toBeInstanceOf(SandboxedFileSystem)
    await fiber.dispose()
    expect(ctx.get('fs')).toBeUndefined()
    // Re-mount below the disposed one to prove no lingering registration.
    fiber = await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
    expect(ctx.fs).toBeInstanceOf(SandboxedFileSystem)
  })
})

describe('descriptor verification (review.16.10 F1, D132)', () => {
  beforeEach(() => boot('workspace-write', { fenceReads: true }))

  it('reports the descriptor fact (Linux has /proc/self/fd; elsewhere the fence stays path-based)', () => {
    expect(fs.descriptorVerified).toBe(process.platform === 'linux')
  })

  it.runIf(process.platform === 'linux')('refuses a read whose directory component became a symlink AFTER the target was resolved, returning no outside content', async () => {
    await writeFile(join(outside, 'secret.txt'), 'operator-secret')
    await mkdir(join(workspace, 'd'))
    await writeFile(join(workspace, 'd', 'f'), 'decoy')
    // Resolve while `d` is real, then swap it for a symlink: the resolve-to-open
    // window this closes. The fence re-resolves first, so the refusal may come
    // from the containment check OR the descriptor identity — either way no
    // outside byte is returned.
    const stale = await target(join(workspace, 'd', 'f'))
    await rename(join(workspace, 'd'), join(workspace, 'd-real'))
    await symlink(outside, join(workspace, 'd'))
    await expect(fs.readText(stale)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it.runIf(process.platform === 'linux')('refuses a write whose destination directory became a symlink AFTER resolve, creating nothing outside', async () => {
    await mkdir(join(workspace, 'd'))
    const stale = await target(join(workspace, 'd', 'w.txt'))
    await rename(join(workspace, 'd'), join(workspace, 'd-real'))
    await symlink(outside, join(workspace, 'd'))
    await expect(fs.writeText(stale, 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(outside, 'w.txt'))).toBe(false)
  })
})

describe('FsError identity', () => {
  it('the denial is a structured FsError distinct from a host permission error', async () => {
    await boot('read-only')
    const error = await fs.writeText(await target(join(workspace, 'x.txt')), 'x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FsError)
    expect((error as FsError).code).toBe('FS_SANDBOX_DENIED')
  })
})
