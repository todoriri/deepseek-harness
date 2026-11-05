/**
 * Tests for the local backend's OPT-IN descriptor pinning (`verifyOpens`): the
 * read opens first and verifies the descriptor's identity against the resolved
 * target before any byte is returned; every mutation pins its target directory
 * by descriptor (a move pins both ends) and reads, stages, publishes or unlinks
 * through it. The swap is performed deterministically — resolve first, then
 * replace a directory or file with a symlink — so these cases measure exactly
 * the window the fence used to lose, not a probabilistic race. The bare
 * `LocalFileSystem` stays path-based: the flag defaults to false and only a
 * backend whose containment check is a resolve-then-open window turns it on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { parsePatch } from '@deepseek-ai/dsh-fs-patch'
import { LocalFileSystem, FD_PINNING_AVAILABLE } from '@deepseek-ai/dsh-fs-local'

/** One update hunk replacing `old` with `new` at the file's first line. */
function hunks(old = 'old', replacement = 'new') {
  const [operation] = parsePatch(`*** Begin Patch\n*** Update File: a\n@@\n-${old}\n+${replacement}\n*** End Patch`)
  if (operation?.kind !== 'update') throw new Error('Expected update')
  return operation.hunks
}

/** The bare backend plus the opt-in the sandboxing subclass turns on. */
class VerifyingFileSystem extends LocalFileSystem {
  constructor(...args: ConstructorParameters<typeof LocalFileSystem>) {
    super(...args)
    this.verifyOpens = true
  }
}

let dir: string
let outside: string
let ctx: Context
let fs: VerifyingFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-fs-pin-'))
  outside = await mkdtemp(join(tmpdir(), 'dsh-fs-pin-out-'))
  ctx = new Context()
  fiber = await ctx.plugin(VerifyingFileSystem, { cwd: dir })
  fs = ctx.fs as VerifyingFileSystem
})
afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('the opt-in boundary', () => {
  it('defaults to path-based opens on the bare backend, and is effective here', async () => {
    const bare = new Context()
    const bareFiber = await bare.plugin(LocalFileSystem, { cwd: dir })
    expect((bare.fs as LocalFileSystem).descriptorVerified).toBe(false)
    await bareFiber.dispose()
    // The opt-in class turns it on; on a host without `/proc/self/fd` the flag is
    // inert, which is the honest platform fact rather than a silent claim.
    expect(fs.descriptorVerified).toBe(FD_PINNING_AVAILABLE)
  })
})

describe.runIf(FD_PINNING_AVAILABLE)('descriptor-verified reads', () => {
  it('refuses a swap that replaces an ANCESTOR with a symlink after the target was resolved', async () => {
    await mkdir(join(dir, 'd'))
    await writeFile(join(dir, 'd', 'f'), 'DECOY\n')
    await writeFile(join(outside, 'f'), 'SECRET\n')
    const target = await fs.resolve(join(dir, 'd', 'f'))
    // The window the fence used to lose: the resolved key is inside, and the
    // directory component is a symlink before the open happens.
    await rename(join(dir, 'd'), join(dir, 'd-real'))
    await symlink(outside, join(dir, 'd'))
    await expect(fs.readText(target)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('refuses a swap that replaces the FINAL component with a symlink after resolution', async () => {
    await writeFile(join(dir, 'f'), 'DECOY\n')
    await writeFile(join(outside, 'g'), 'SECRET\n')
    const target = await fs.resolve(join(dir, 'f'))
    await rm(join(dir, 'f'))
    await symlink(join(outside, 'g'), join(dir, 'f'))
    await expect(fs.readText(target)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('serves every read method from the verified descriptor on a stable path', async () => {
    const path = join(dir, 'stable.txt')
    await writeFile(path, 'stable\n')
    const target = await fs.resolve(path)
    expect(await fs.readText(target)).toBe('stable\n')
    const stream = await fs.streamText(target)
    const chunks: string[] = []
    for await (const chunk of stream) chunks.push(String(chunk))
    expect(chunks.join('')).toBe('stable\n')
    expect(Buffer.from(await fs.readBytes(target, undefined, 64)).toString()).toBe('stable\n')
    expect(Buffer.from(await fs.readByteRange(target, { offset: 0, length: 6 })).toString()).toBe('stable')
    expect((await fs.listDir(await fs.resolve(dir))).map(entry => entry.name)).toContain('stable.txt')
  })

  it('reports a target removed after resolution as not found, from the stream’s first read', async () => {
    const path = join(dir, 'gone.txt')
    await writeFile(path, 'soon gone\n')
    const target = await fs.resolve(path)
    await rm(path)
    await expect(fs.readText(target)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    // Like the path-based stream, the verified stream opens on its first read.
    const stream = await fs.streamText(target)
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })
})

describe.runIf(FD_PINNING_AVAILABLE)('dir-fd-pinned writes', () => {
  it('refuses a write whose destination directory became a symlink after resolution, and lands nothing outside', async () => {
    await mkdir(join(dir, 'd'))
    // `w` does not exist yet: the resolved key is dir/d/w.
    const target = await fs.resolve(join(dir, 'd', 'w'))
    await rename(join(dir, 'd'), join(dir, 'd-real'))
    await symlink(outside, join(dir, 'd'))
    await expect(fs.writeText(target, 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(outside, 'w'))).toBe(false)
    expect(existsSync(join(dir, 'd-real', 'w'))).toBe(false)
  })

  it('refuses a write whose destination ANCESTOR became a symlink after resolution, and lands nothing outside', async () => {
    await mkdir(join(dir, 'a', 'b'), { recursive: true })
    await mkdir(join(outside, 'b'))
    const target = await fs.resolve(join(dir, 'a', 'b', 'w'))
    // `O_NOFOLLOW` guards only the final component; the descriptor's identity
    // check is what catches the redirected ancestor.
    await rename(join(dir, 'a'), join(dir, 'a-real'))
    await symlink(outside, join(dir, 'a'))
    await expect(fs.writeText(target, 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(outside, 'b', 'w'))).toBe(false)
  })

  it('overwrites through the pinned destination and reads the diff basis from the verified file', async () => {
    const path = join(dir, 'over.txt')
    await writeFile(path, 'before\n')
    const outcome = await fs.writeText(await fs.resolve(path), 'after\n')
    expect(outcome).toMatchObject({ operation: 'update', before: 'before\n', after: 'after\n' })
    expect(await readFile(path, 'utf8')).toBe('after\n')
  })

  it('creates missing intermediate directories through the pinned parent and publishes in place', async () => {
    const target = await fs.resolve(join(dir, 'a', 'b', 'c.txt'))
    await fs.writeText(target, 'nested\n', { kind: 'createIfAbsent' })
    expect(await readFile(join(dir, 'a', 'b', 'c.txt'), 'utf8')).toBe('nested\n')
  })

  it('edits through the pinned destination on a stable path', async () => {
    const path = join(dir, 'edit.txt')
    await writeFile(path, 'original\n')
    const outcome = await fs.editText(await fs.resolve(path), { oldString: 'original', newString: 'changed', replaceAll: false })
    expect(outcome.after).toBe('changed\n')
    expect(await readFile(path, 'utf8')).toBe('changed\n')
  })

  it('refuses an overwrite whose existing file became a symlink to an outside file after resolution', async () => {
    const path = join(dir, 'over.txt')
    await writeFile(path, 'DECOY\n')
    await writeFile(join(outside, 'o.txt'), 'SECRET\n')
    const target = await fs.resolve(path)
    // The preflight still sees a file (metadata is deliberately unfenced); the
    // diff basis is the content read, and it must not come from the swapped target.
    await rm(path)
    await symlink(join(outside, 'o.txt'), path)
    await expect(fs.writeText(target, 'next\n')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(join(outside, 'o.txt'), 'utf8')).toBe('SECRET\n')
  })

  it('refuses an edit whose file became a symlink to an outside file after resolution', async () => {
    const path = join(dir, 'e.txt')
    await writeFile(path, 'DECOY\n')
    await writeFile(join(outside, 'target.txt'), 'SECRET\n')
    const target = await fs.resolve(path)
    await rm(path)
    await symlink(join(outside, 'target.txt'), path)
    await expect(fs.editText(target, { oldString: 'DECOY', newString: 'x', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(join(outside, 'target.txt'), 'utf8')).toBe('SECRET\n')
  })
})

describe.runIf(FD_PINNING_AVAILABLE)('dir-fd-pinned patches and deletions', () => {
  it('patches through the pinned destination on a stable path', async () => {
    const path = join(dir, 'patch.txt')
    await writeFile(path, 'old\ntail\n')
    const outcome = await fs.patchText(await fs.resolve(path), hunks())
    expect(outcome).toMatchObject({ before: 'old\ntail\n', after: 'new\ntail\n' })
    expect(await readFile(path, 'utf8')).toBe('new\ntail\n')
  })

  it('refuses a patch whose file became a symlink to an outside file after resolution', async () => {
    const path = join(dir, 'patch.txt')
    await writeFile(path, 'DECOY\n')
    await writeFile(join(outside, 'p.txt'), 'SECRET\n')
    const target = await fs.resolve(path)
    // The preflight still sees a file (metadata is deliberately unfenced); the
    // before-content read is the content read, and it must not come from the swap.
    await rm(path)
    await symlink(join(outside, 'p.txt'), path)
    await expect(fs.patchText(target, hunks('DECOY'))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(join(outside, 'p.txt'), 'utf8')).toBe('SECRET\n')
  })

  it('refuses a patch whose destination directory became a symlink after resolution, landing nothing outside', async () => {
    await mkdir(join(dir, 'd'))
    await writeFile(join(dir, 'd', 'f'), 'old\n')
    await writeFile(join(outside, 'f'), 'SECRET\n')
    const target = await fs.resolve(join(dir, 'd', 'f'))
    await rename(join(dir, 'd'), join(dir, 'd-real'))
    await symlink(outside, join(dir, 'd'))
    await expect(fs.patchText(target, hunks())).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(join(dir, 'd-real', 'f'), 'utf8')).toBe('old\n')
    expect(await readFile(join(outside, 'f'), 'utf8')).toBe('SECRET\n')
  })

  it('deletes through the pinned directory on a stable path', async () => {
    const path = join(dir, 'del.txt')
    await writeFile(path, 'gone\n')
    expect(await fs.deleteFile(await fs.resolve(path))).toEqual({ before: 'gone\n' })
    expect(existsSync(path)).toBe(false)
  })

  it('refuses a delete whose file became a symlink to an outside file after resolution', async () => {
    const path = join(dir, 'del.txt')
    await writeFile(path, 'DECOY\n')
    await writeFile(join(outside, 'keep.txt'), 'SECRET\n')
    const target = await fs.resolve(path)
    await rm(path)
    await symlink(join(outside, 'keep.txt'), path)
    await expect(fs.deleteFile(target)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('SECRET\n')
  })

  it('refuses a delete whose directory became a symlink after resolution, removing nothing outside', async () => {
    await mkdir(join(dir, 'd'))
    await writeFile(join(dir, 'd', 'f'), 'DECOY\n')
    await writeFile(join(outside, 'f'), 'SECRET\n')
    const target = await fs.resolve(join(dir, 'd', 'f'))
    await rename(join(dir, 'd'), join(dir, 'd-real'))
    await symlink(outside, join(dir, 'd'))
    await expect(fs.deleteFile(target)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(join(dir, 'd-real', 'f'), 'utf8')).toBe('DECOY\n')
    expect(await readFile(join(outside, 'f'), 'utf8')).toBe('SECRET\n')
  })
})

describe.runIf(FD_PINNING_AVAILABLE)('dir-fd-pinned moves', () => {
  it('moves through the pinned source and destination directories on a stable path', async () => {
    const source = join(dir, 'from.txt')
    await writeFile(source, 'moving\n')
    const destination = join(dir, 'to.txt')
    const outcome = await fs.moveFile(await fs.resolve(source), await fs.resolve(destination), {})
    expect(outcome).toMatchObject({ sourceDeleted: true, destination: { operation: 'create', before: null, after: 'moving\n' } })
    expect(await readFile(destination, 'utf8')).toBe('moving\n')
    expect(existsSync(source)).toBe(false)
  })

  it('creates missing destination directories through the pinned parent and moves the source', async () => {
    const source = join(dir, 'from.txt')
    await writeFile(source, 'nested\n')
    const destination = join(dir, 'a', 'b', 'to.txt')
    await fs.moveFile(await fs.resolve(source), await fs.resolve(destination), {})
    expect(await readFile(destination, 'utf8')).toBe('nested\n')
    expect(existsSync(source)).toBe(false)
  })

  it('refuses a move whose source became a symlink to an outside file after resolution', async () => {
    const source = join(dir, 'src.txt')
    await writeFile(source, 'DECOY\n')
    await writeFile(join(outside, 's.txt'), 'SECRET\n')
    const target = await fs.resolve(source)
    await rm(source)
    await symlink(join(outside, 's.txt'), source)
    const destination = await fs.resolve(join(dir, 'dst.txt'))
    await expect(fs.moveFile(target, destination, {})).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(destination.targetKey)).toBe(false)
    expect(await readFile(join(outside, 's.txt'), 'utf8')).toBe('SECRET\n')
  })

  it('refuses a move whose destination directory became a symlink after resolution and leaves the source', async () => {
    await mkdir(join(dir, 'dest-dir'))
    const source = join(dir, 'src.txt')
    await writeFile(source, 'keep\n')
    const destination = await fs.resolve(join(dir, 'dest-dir', 'dst.txt'))
    await rename(join(dir, 'dest-dir'), join(dir, 'dest-dir-real'))
    await symlink(outside, join(dir, 'dest-dir'))
    await expect(fs.moveFile(await fs.resolve(source), destination, {})).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(source, 'utf8')).toBe('keep\n')
    expect(existsSync(join(dir, 'dest-dir-real', 'dst.txt'))).toBe(false)
    expect(existsSync(join(outside, 'dst.txt'))).toBe(false)
  })

  it('refuses a move whose existing destination became a symlink to an outside file after resolution', async () => {
    const source = join(dir, 'src.txt')
    await writeFile(source, 'keep\n')
    const destinationPath = join(dir, 'dst.txt')
    await writeFile(destinationPath, 'DECOY\n')
    await writeFile(join(outside, 'd.txt'), 'SECRET\n')
    const destination = await fs.resolve(destinationPath)
    await rm(destinationPath)
    await symlink(join(outside, 'd.txt'), destinationPath)
    await expect(fs.moveFile(await fs.resolve(source), destination, {})).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(source, 'utf8')).toBe('keep\n')
    expect(await readFile(join(outside, 'd.txt'), 'utf8')).toBe('SECRET\n')
  })
})
