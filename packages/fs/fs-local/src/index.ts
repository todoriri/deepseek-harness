/**
 * Host-filesystem implementation of `ctx.fs`. Realpath-derived target identity makes aliases
 * share stale guards, and writes through a symlink update its target without replacing the link.
 * @module @deepseek-ai/dsh-fs-local
 */

import { Context } from '@deepseek-ai/cordis'
import { constants as bufferConstants } from 'node:buffer'
import { once } from 'node:events'
import { watch } from 'chokidar'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import {
  applyLiteralEdit,
  descriptorPath,
  FD_PINNING_AVAILABLE,
  listDirectory,
  localDisplayPath,
  normalizeLineEndings,
  openVerifiedChildFile,
  openVerifiedFile,
  pinDirectory,
  probe,
  probeNoFollow,
  readForEdit,
  readByteWindow,
  readTextForDiff,
  readWholeBytes,
  readWholeText,
  resolveLocalTarget,
  restoreLineEndings,
  streamWholeText,
  writeFileAtomic,
} from './fsio.ts'
import type { FsIoInternals, LocalTarget, PinnedDirectory } from './fsio.ts'

/**
 * Re-exported so a backend that turns the descriptor pinning on (the sandboxing
 * subclass) and the specs that assert the platform fact read the SAME constant
 * the read/mutation paths consult.
 */
export { FD_PINNING_AVAILABLE } from './fsio.ts'

/** Configuration for the local filesystem backend. */
export interface Config {
  /** Base directory for relative paths. Defaults to `process.cwd()`. */
  cwd?: string
  /**
   * Exclusive UTF-8 byte limit on each overwrite-diff side, capped by the
   * runtime's safe allocation/decode maximum. Defaults to 10 MiB.
   */
  diffBasisMaxBytes?: number
}

type ResolvedConfig = Required<Config>
/**
 * Default `diffBasisMaxBytes`. Exported so a backend that EXTENDS this one's
 * config (`@deepseek-ai/dsh-fs-sandbox`, whose schema must add a field without
 * mutating this static) can carry the same bounds instead of restating them.
 */
export const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024
/** Maximum `diffBasisMaxBytes`: the smaller of Node's Buffer and string length limits. */
export const MAX_DIFF_BASIS_BYTES = Math.min(
  bufferConstants.MAX_LENGTH,
  bufferConstants.MAX_STRING_LENGTH,
)

/**
 * The host-filesystem backend. Reads resolve relative paths from {@link Config.cwd}
 * (a resolution default, NOT a containment boundary — see the filesystem
 * capability-seam Agent Note); enforce
 * containment with a stricter backend or a `tools/execute` permission plugin.
 */
export class LocalFileSystem extends FileSystem {
  override async watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    signal.throwIfAborted()
    const path = resolve(this.processPath(target))
    const directory = (await this.stat(target, signal))?.type === 'directory'
    signal.throwIfAborted()
    const root = directory ? path : dirname(path)
    const watcher = watch(root, {
      ignoreInitial: true, depth: 0,
      ignored: entry => !directory && resolve(entry) !== root && resolve(entry) !== path,
    })
    watcher.on('all', (_event, entry) => {
      if (directory || resolve(entry) === path) changed()
    })
    watcher.on('error', (error) => { changed(error instanceof Error ? error : new Error(String(error))) })
    try {
      await once(watcher, 'ready', { signal })
      return () => watcher.close()
    } catch (error) {
      await watcher.close()
      throw error
    }
  }

  static Config: z<Config> = z.object({
    cwd: z.string().default(process.cwd()),
    diffBasisMaxBytes: z.number().default(DEFAULT_DIFF_BASIS_MAX_BYTES),
  })

  /** Validated config (schemastery applied the defaults before construction). */
  readonly config: ResolvedConfig
  /** Test hook forwarded to fsio for atomic-publication boundaries. */
  internals: FsIoInternals = {}
  /**
   * Descriptor-level verification of the content-bearing opens, OFF by default.
   *
   * When on, a read opens the resolved canonical target, verifies that the path the
   * kernel reports for the descriptor IS that canonical path, and serves the bytes
   * from the descriptor — so a symlink swapped into the path after the caller's
   * resolution fails the open instead of redirecting it. A mutation pins the
   * destination directory the same way (creating missing intermediates relative to
   * the pinned parent) and stages, publishes and cleans up through the descriptor.
   * The bare backend keeps its historical check-then-open behaviour; a backend
   * that fences MODEL-CONTROLLED paths (`@deepseek-ai/dsh-fs-sandbox`, whose
   * containment check is exactly a resolve-then-open window) turns it on. It needs
   * `/proc/self/fd` ({@link FD_PINNING_AVAILABLE}); where that is missing the flag
   * is inert rather than a silent claim of verification.
   */
  protected verifyOpens = false
  /** Whether descriptor verification is actually in force on this host (see {@link verifyOpens}). */
  get descriptorVerified(): boolean {
    return this.verifyOpens && FD_PINNING_AVAILABLE
  }
  /** Per-targetKey tail promise: serializes mutating ops so the read→guard→write
   * window can't interleave, making concurrent writes/edits deterministically
   * ordered (one wins, the rest see the new version and reject as stale). */
  private locks = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = config as ResolvedConfig
    if (!Number.isSafeInteger(resolved.diffBasisMaxBytes)
      || resolved.diffBasisMaxBytes <= 0
      || resolved.diffBasisMaxBytes > MAX_DIFF_BASIS_BYTES) {
      throw new Error(`fs-local: diffBasisMaxBytes must be a positive safe integer no greater than ${MAX_DIFF_BASIS_BYTES}`)
    }
    this.config = resolved
  }

  /** Run `op` with exclusive access to `targetKey` (FIFO per key). */
  private async withLock<T>(targetKey: string, op: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(op, op)
    // Keep the chain alive but swallow this op's result/throw for the *next* waiter.
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) {
        this.locks.delete(targetKey)
      }
    }
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    const local = await resolveLocalTarget(opts?.cwd ?? this.config.cwd, path)
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    return { targetKey: local.targetKey, displayPath: local.displayPath }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    return isAbsolute(hostPath) ? resolve(hostPath) : undefined
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const path = relative(this.processPath(parent), this.processPath(child))
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    const info = await probe(target.targetKey)
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    if (!info) return undefined
    return { version: info.version, type: info.type, size: info.size }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const cwd = opts?.cwd ?? this.config.cwd
    const info = await probeNoFollow(localDisplayPath(cwd, path))
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (!info) return undefined
    return { version: info.version, type: info.type, size: info.size }
  }

  /**
   * Open `target` and return a descriptor-pinned view of it, or `undefined` when
   * descriptor verification is off. The display path is kept for messages; the
   * target key becomes the descriptor's `/proc/self/fd` alias, so every content
   * operation resolves against what was verified rather than the path.
   */
  private async verifiedReadTarget(
    target: FsTarget,
    signal?: AbortSignal,
  ): Promise<{ target: LocalTarget; close: () => Promise<void> } | undefined> {
    if (!this.descriptorVerified) return undefined
    const handle = await openVerifiedFile({ displayPath: target.displayPath, targetKey: target.targetKey }, signal)
    return {
      target: { displayPath: target.displayPath, targetKey: FsTargetKey(descriptorPath(handle.fd)) },
      close: () => handle.close(),
    }
  }

  /** Pin the mutation's destination directory, or `undefined` when descriptor verification is off. */
  private async pinnedDestination(target: FsTarget, signal?: AbortSignal): Promise<PinnedDirectory | undefined> {
    if (!this.descriptorVerified) return undefined
    return pinDirectory(dirname(target.targetKey), target.displayPath, signal)
  }

  /** The path a mutation must use: through the pinned descriptor when present, else the resolved target key. */
  private destinationPath(target: FsTarget, pinned: PinnedDirectory | undefined): string {
    return pinned ? join(pinned.path, basename(target.targetKey)) : target.targetKey
  }

  /**
   * The overwrite diff basis, read through the verified descriptor when pinning is
   * on. A file deleted after the caller's preflight costs only the optional basis
   * (the verified helper's `FS_NOT_FOUND` becomes `null`); an identity refusal is
   * the swap this closes and fails the write.
   */
  private async readDiffBasis(target: FsTarget, pinned: PinnedDirectory | undefined, signal?: AbortSignal): Promise<string | null> {
    if (!pinned) return readTextForDiff(target.targetKey, this.config.diffBasisMaxBytes, signal)
    let handle: Awaited<ReturnType<typeof openVerifiedChildFile>>
    try {
      handle = await openVerifiedChildFile(pinned, basename(target.targetKey), target.displayPath, 'read', signal)
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'FS_NOT_FOUND') return null
      throw error
    }
    try {
      return await readTextForDiff(descriptorPath(handle.fd), this.config.diffBasisMaxBytes, signal)
    } finally {
      await handle.close()
    }
  }

  /** Read a file for editing through the verified descriptor when pinning is on. */
  private async readTargetForEdit(target: FsTarget, pinned: PinnedDirectory | undefined, signal?: AbortSignal) {
    if (!pinned) return readForEdit(target.targetKey, target.displayPath, signal)
    const handle = await openVerifiedChildFile(pinned, basename(target.targetKey), target.displayPath, 'edit', signal)
    try {
      return await readForEdit(descriptorPath(handle.fd), target.displayPath, signal)
    } finally {
      await handle.close()
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const pinned = await this.verifiedReadTarget(target, signal)
    if (!pinned) return readWholeText({ displayPath: target.displayPath, targetKey: target.targetKey }, signal)
    try {
      return await readWholeText(pinned.target, signal)
    } finally {
      await pinned.close()
    }
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const pinned = await this.verifiedReadTarget(target, signal)
    if (!pinned) return Promise.resolve(streamWholeText({ displayPath: target.displayPath, targetKey: target.targetKey }, signal))
    const inner = streamWholeText(pinned.target, signal)
    // The verified descriptor stays open until the consumer finishes (or abandons)
    // the stream; `for await` calls `return()`, so the finally runs on an early exit.
    return (async function* () {
      try {
        yield* inner
      } finally {
        await pinned.close()
      }
    })()
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const pinned = await this.verifiedReadTarget(target, signal)
    if (!pinned) return readWholeBytes({ displayPath: target.displayPath, targetKey: target.targetKey }, signal, maxBytes, this.internals)
    try {
      return await readWholeBytes(pinned.target, signal, maxBytes, this.internals)
    } finally {
      await pinned.close()
    }
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const pinned = await this.verifiedReadTarget(target, signal)
    if (!pinned) return readByteWindow({ displayPath: target.displayPath, targetKey: target.targetKey }, range, signal)
    try {
      return await readByteWindow(pinned.target, range, signal)
    } finally {
      await pinned.close()
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const pinned = await this.verifiedReadTarget(target, signal)
    const entries = pinned
      ? await (async () => {
        try {
          return await listDirectory(pinned.target, signal)
        } finally {
          await pinned.close()
        }
      })()
      : await listDirectory({ displayPath: target.displayPath, targetKey: target.targetKey }, signal)
    return entries.map(entry => ({
      name: entry.name,
      type: entry.type,
      target: { targetKey: entry.target.targetKey, displayPath: entry.target.displayPath },
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      ...(entry.size !== undefined ? { size: entry.size } : {}),
    }))
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(target.targetKey, async () => {
      const existing = await probe(target.targetKey)
      if (existing && existing.type !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }

      if (expected?.kind === 'replaceIfVersion') {
        // Stale guard: the file must still exist at the version the owner observed.
        if (!existing) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        if (existing.version !== expected.version) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected?.kind === 'createIfAbsent' && existing) {
        // createIfAbsent onto an existing file: a blind overwrite — require a read first.
        throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }
      // No expectation means an unconditional but still atomic write.

      // Capture an optional contextual-diff basis before the write. The bounded
      // reader checks the opened file itself, so an external replacement after
      // `probe()` cannot turn this best-effort presentation read into an
      // unbounded allocation. Either side at/above the configured limit yields
      // `before: null`; consumers retain their whole-file fallback.
      const diffable = existing !== null
        && Buffer.byteLength(content, 'utf8') < this.config.diffBasisMaxBytes
      const pinned = await this.pinnedDestination(target, signal)
      const writePath = this.destinationPath(target, pinned)
      try {
        // The diff basis is read through the SAME verified destination the write
        // uses, so a swapped component can never supply the before-text.
        const before = diffable ? await this.readDiffBasis(target, pinned, signal) : null
        await writeFileAtomic(
          writePath,
          content,
          existing?.mode,
          signal,
          this.internals,
          expected?.kind === 'createIfAbsent' ? { displayPath: target.displayPath } : undefined,
        )
        const after = await probe(writePath)
        return {
          operation: existing ? 'update' : 'create',
          version: this.versionAfterWrite(after, target),
          before,
          // LF-normalized to share the diff basis with `before` (also LF): a CRLF
          // overwrite must not read as every line changed. Line-ending restoration
          // is a storage detail the applied-hunk diff ignores.
          after: normalizeLineEndings(content),
        }
      } finally {
        await pinned?.close()
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(target.targetKey, async () => {
      const existing = await probe(target.targetKey)
      // Stale guard before literal matching: an edit based on an old read reports
      // FS_STALE_VERSION, not FS_EDIT_NOT_FOUND/FS_AMBIGUOUS_EDIT against newer content.
      // Missing targets use the same stale code on guarded and unconditional edit paths.
      if (!existing) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      if (existing.type !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      // expected === undefined: unconditional edit of the current content — no
      // version guard. Still inside the per-target lock, so the read→match→write
      // window is serialized and atomic.
      if (expected && existing.version !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }

      const pinned = await this.pinnedDestination(target, signal)
      const writePath = this.destinationPath(target, pinned)
      try {
        // Read and write through the SAME verified destination: the literal match
        // applies to the pinned file, never to a swapped one.
        const original = await this.readTargetForEdit(target, pinned, signal)
        const edited = applyLiteralEdit(original.content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
        const content = restoreLineEndings(edited.content, original.lineEndings)
        await writeFileAtomic(writePath, content, existing.mode, signal, this.internals)

        const after = await probe(writePath)
        return {
          version: this.versionAfterWrite(after, target),
          // The LF-normalized before/after text (the applied-hunk diff basis);
          // line-ending restoration is a storage detail the diff ignores.
          before: original.content,
          after: edited.content,
        }
      } finally {
        await pinned?.close()
      }
    })
  }

  /* v8 ignore next 5 -- the post-write probe finding the file absent requires a
   * concurrent unlink between rename and stat; fall back to a sentinel version. */
  private versionAfterWrite(after: { version: FsVersion } | null, target: FsTarget): FsVersion {
    if (after) return after.version
    return FsVersion(`missing:${target.targetKey}`)
  }
}

export default LocalFileSystem
