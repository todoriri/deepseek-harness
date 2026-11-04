/**
 * Fault-injected cases for the local backend's descriptor pinning (`verifyOpens`):
 * the branches a concurrent writer reaches between two syscalls of one operation
 * (a pinned directory moved before its child is opened, an intermediate directory
 * created by another writer between the walk and `mkdir`) and kernel refusals
 * other than the not-found and symlink codes. `node:fs/promises` delegates to the
 * real implementation unless a case installs a fault, so every other syscall of
 * the operation runs for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir as realMkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem, FD_PINNING_AVAILABLE } from '@deepseek-ai/dsh-fs-local'

const faults = vi.hoisted(() => ({
  /** Return an error to fail the `open` of this path before it reaches the kernel. */
  open: undefined as ((path: string) => Error | undefined) | undefined,
  /** Rewrite the target a `readlink` reports. */
  readlink: undefined as ((link: string) => string) | undefined,
  /** Replace `mkdir` of this path; `create` performs the real call. */
  mkdir: undefined as ((path: string, create: () => Promise<unknown>) => Promise<unknown>) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const error = faults.open?.(String(args[0]))
      if (error) throw error
      return actual.open(...args)
    },
    readlink: async (...args: Parameters<typeof actual.readlink>) => {
      const link = await actual.readlink(...args)
      return typeof link === 'string' && faults.readlink ? faults.readlink(link) : link
    },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const create = () => actual.mkdir(...args)
      return faults.mkdir ? faults.mkdir(String(args[0]), create) : create()
    },
  }
})

/** The bare backend plus the opt-in the sandboxing subclass turns on. */
class VerifyingFileSystem extends LocalFileSystem {
  constructor(...args: ConstructorParameters<typeof LocalFileSystem>) {
    super(...args)
    this.verifyOpens = true
  }
}

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: injected refusal`), { code })
}

/** Whether `path` names `name` through a pinned directory's `/proc/self/fd` alias. */
function throughDescriptor(path: string, name: string): boolean {
  return path.startsWith('/proc/self/fd/') && path.endsWith(`/${name}`)
}

let dir: string
let ctx: Context
let fs: VerifyingFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-fs-pin-fault-'))
  ctx = new Context()
  fiber = await ctx.plugin(VerifyingFileSystem, { cwd: dir })
  fs = ctx.fs as VerifyingFileSystem
})
afterEach(async () => {
  faults.open = undefined
  faults.readlink = undefined
  faults.mkdir = undefined
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

describe.runIf(FD_PINNING_AVAILABLE)('verified file opens under injected faults', () => {
  it('surfaces a read open refusal other than not-found or a symlink unchanged', async () => {
    const path = join(dir, 'locked.txt')
    await writeFile(path, 'content\n')
    const target = await fs.resolve(path)
    faults.open = at => at === target.targetKey ? errno('EACCES') : undefined
    await expect(fs.readText(target)).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('drops only the diff basis when the overwritten file disappears after the preflight', async () => {
    const path = join(dir, 'over.txt')
    await writeFile(path, 'before\n')
    faults.open = at => throughDescriptor(at, 'over.txt') ? errno('ENOENT') : undefined
    const outcome = await fs.writeText(await fs.resolve(path), 'after\n')
    expect(outcome).toMatchObject({ operation: 'update', before: null, after: 'after\n' })
    expect(await readFile(path, 'utf8')).toBe('after\n')
  })

  it('surfaces an edit open refusal other than not-found or a symlink unchanged', async () => {
    const path = join(dir, 'edit.txt')
    await writeFile(path, 'original\n')
    faults.open = at => throughDescriptor(at, 'edit.txt') ? errno('EACCES') : undefined
    await expect(fs.editText(await fs.resolve(path), { oldString: 'original', newString: 'x', replaceAll: false }))
      .rejects.toMatchObject({ code: 'EACCES' })
  })

  it('refuses an edit whose opened file is not the pinned directory’s child', async () => {
    const path = join(dir, 'moved.txt')
    await writeFile(path, 'original\n')
    // The pinned directory moved between the pin and the child open, so the
    // descriptor names the file at a path the containment check never saw.
    faults.readlink = link => link.endsWith('/moved.txt') ? '/elsewhere/moved.txt' : link
    await expect(fs.editText(await fs.resolve(path), { oldString: 'original', newString: 'x', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('original\n')
  })
})

describe.runIf(FD_PINNING_AVAILABLE)('intermediate directory creation under injected faults', () => {
  it('surfaces a mkdir refusal and creates nothing', async () => {
    faults.mkdir = (at, create) => throughDescriptor(at, 'denied') ? Promise.reject(errno('EACCES')) : create()
    await expect(fs.writeText(await fs.resolve(join(dir, 'denied', 'f.txt')), 'x', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'EACCES' })
    expect(existsSync(join(dir, 'denied'))).toBe(false)
  })

  it('continues through a directory another writer created between the walk and mkdir', async () => {
    faults.mkdir = async (at, create) => {
      if (!throughDescriptor(at, 'raced')) return create()
      await realMkdir(join(dir, 'raced'))
      throw errno('EEXIST')
    }
    await fs.writeText(await fs.resolve(join(dir, 'raced', 'f.txt')), 'raced\n', { kind: 'createIfAbsent' })
    expect(await readFile(join(dir, 'raced', 'f.txt'), 'utf8')).toBe('raced\n')
  })

  it('surfaces a created directory’s open refusal other than a symlink unchanged', async () => {
    faults.open = at => throughDescriptor(at, 'unreadable') ? errno('EACCES') : undefined
    await expect(fs.writeText(await fs.resolve(join(dir, 'unreadable', 'f.txt')), 'x', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'EACCES' })
  })

  it('refuses a created directory whose descriptor is not the expected child', async () => {
    faults.readlink = link => link.endsWith('/swapped') ? '/elsewhere/swapped' : link
    await expect(fs.writeText(await fs.resolve(join(dir, 'swapped', 'f.txt')), 'x', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(dir, 'swapped', 'f.txt'))).toBe(false)
  })
})

describe.runIf(FD_PINNING_AVAILABLE)('pinned patch, delete and move opens under injected faults', () => {
  const PATCH = [{ lineNumber: 3, oldLines: ['old'], newLines: ['new'], isEndOfFile: false }]

  it('surfaces a patch open refusal other than not-found or a symlink unchanged', async () => {
    const path = join(dir, 'patch.txt')
    await writeFile(path, 'old\n')
    faults.open = at => throughDescriptor(at, 'patch.txt') ? errno('EACCES') : undefined
    await expect(fs.patchText(await fs.resolve(path), PATCH)).rejects.toMatchObject({ code: 'EACCES' })
    expect(await readFile(path, 'utf8')).toBe('old\n')
  })

  it('refuses a patch whose opened file is not the pinned directory’s child', async () => {
    const path = join(dir, 'moved.txt')
    await writeFile(path, 'old\n')
    faults.readlink = link => link.endsWith('/moved.txt') ? '/elsewhere/moved.txt' : link
    await expect(fs.patchText(await fs.resolve(path), PATCH)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('old\n')
  })

  it('surfaces a delete before-content open refusal unchanged and keeps the file', async () => {
    const path = join(dir, 'del.txt')
    await writeFile(path, 'old\n')
    faults.open = at => throughDescriptor(at, 'del.txt') ? errno('EACCES') : undefined
    await expect(fs.deleteFile(await fs.resolve(path))).rejects.toMatchObject({ code: 'EACCES' })
    expect(await readFile(path, 'utf8')).toBe('old\n')
  })

  it('refuses a delete whose opened file is not the pinned directory’s child', async () => {
    const path = join(dir, 'doomed.txt')
    await writeFile(path, 'old\n')
    faults.readlink = link => link.endsWith('/doomed.txt') ? '/elsewhere/doomed.txt' : link
    await expect(fs.deleteFile(await fs.resolve(path))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('old\n')
  })

  it('drops the delete basis when the verified open reports the target missing', async () => {
    const path = join(dir, 'basis.txt')
    await writeFile(path, 'old\n')
    faults.open = at => throughDescriptor(at, 'basis.txt') ? errno('ENOENT') : undefined
    expect(await fs.deleteFile(await fs.resolve(path))).toEqual({ before: null })
    expect(existsSync(path)).toBe(false)
  })

  it('surfaces a move source open refusal unchanged and leaves both files', async () => {
    const source = join(dir, 'src.txt')
    await writeFile(source, 'old\n')
    const destination = join(dir, 'dst.txt')
    await writeFile(destination, 'previous\n')
    faults.open = at => throughDescriptor(at, 'src.txt') ? errno('EACCES') : undefined
    await expect(fs.moveFile(await fs.resolve(source), await fs.resolve(destination), {}))
      .rejects.toMatchObject({ code: 'EACCES' })
    expect(await readFile(source, 'utf8')).toBe('old\n')
    expect(await readFile(destination, 'utf8')).toBe('previous\n')
  })

  it('refuses a move whose opened source is not the pinned directory’s child', async () => {
    const source = join(dir, 'moving.txt')
    await writeFile(source, 'old\n')
    const destination = join(dir, 'dst.txt')
    faults.readlink = link => link.endsWith('/moving.txt') ? '/elsewhere/moving.txt' : link
    await expect(fs.moveFile(await fs.resolve(source), await fs.resolve(destination), {}))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(source, 'utf8')).toBe('old\n')
    expect(existsSync(destination)).toBe(false)
  })

  it('surfaces a move destination before-content open refusal unchanged', async () => {
    const source = join(dir, 'src.txt')
    await writeFile(source, 'old\n')
    const destination = join(dir, 'dst.txt')
    await writeFile(destination, 'previous\n')
    faults.open = at => throughDescriptor(at, 'dst.txt') ? errno('EACCES') : undefined
    await expect(fs.moveFile(await fs.resolve(source), await fs.resolve(destination), {}))
      .rejects.toMatchObject({ code: 'EACCES' })
    expect(await readFile(source, 'utf8')).toBe('old\n')
    expect(await readFile(destination, 'utf8')).toBe('previous\n')
  })

  it('refuses a move whose destination directory descriptor is not the expected directory', async () => {
    await realMkdir(join(dir, 'dest-dir'))
    const source = join(dir, 'src.txt')
    await writeFile(source, 'old\n')
    const destination = join(dir, 'dest-dir', 'dst.txt')
    faults.readlink = link => link === join(dir, 'dest-dir') ? '/elsewhere/dest-dir' : link
    await expect(fs.moveFile(await fs.resolve(source), await fs.resolve(destination), {}))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(source, 'utf8')).toBe('old\n')
    expect(existsSync(join(dir, 'dest-dir', 'dst.txt'))).toBe(false)
  })
})
