/**
 * Host-filesystem implementation of `ctx.fs`. Realpath-derived target identity makes aliases
 * share stale guards, and writes through a symlink update its target without replacing the link.
 * @module @deepseek-ai/dsh-fs-local
 */

import { applyHunks } from '@deepseek-ai/dsh-fs-patch'
import type { PatchHunk } from '@deepseek-ai/dsh-fs-patch'
import { Context } from '@deepseek-ai/cordis'
import { constants as bufferConstants } from 'node:buffer'
import { once } from 'node:events'
import { watch } from 'chokidar'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDeleteOutcome,
  FsMoveOutcome,
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
  expandHomePrefix,
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
  removeFile,
  streamWholeText,
  writeFileAtomic,
} from './fsio.ts'
import type { FsIoInternals, LocalTarget, PathInfo, PinnedDirectory } from './fsio.ts'

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
 * Open `target` through the identity-verified helper and return a view of it
 * whose target key is the descriptor's `/proc/self/fd` alias; the display path is
 * kept for messages. The caller reads through the view and then closes it.
 */
async function pinReadTarget(target: FsTarget, signal?: AbortSignal): Promise<{ target: LocalTarget; close: () => Promise<void> }> {
  const handle = await openVerifiedFile({ displayPath: target.displayPath, targetKey: target.targetKey }, signal)
  return {
    target: { displayPath: target.displayPath, targetKey: FsTargetKey(descriptorPath(handle.fd)) },
    close: () => handle.close(),
  }
}

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
   * resolution fails the open instead of redirecting it. Every mutation pins its
   * target directory the same way (creating missing intermediates relative to the
   * pinned parent): `writeText`, `editText` and `patchText` read their
   * before-content and stage/publish through the descriptor; `deleteFile` reads
   * its before-content and unlinks through it; `moveFile` pins BOTH the source and
   * destination directory, reads the source and destination before-content
   * through them, stages/publishes the destination through the destination
   * descriptor, and unlinks the source through the source descriptor.
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

  /** Run one mutation under the same lock ordering as multi-target operations. */
  private withLock<T>(targetKey: string, op: () => Promise<T>): Promise<T> {
    return this.withLocks([targetKey], op)
  }

  /** Acquire distinct keys in lexical order and release inner locks before outer locks. */
  private withLocks<T>(keys: string[], op: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort()
    const acquire = async (index: number): Promise<T> => {
      const key = ordered[index]
      if (key === undefined) return op()
      const prior = this.locks.get(key) ?? Promise.resolve()
      const run = prior.then(() => acquire(index + 1))
      const tail = run.then(() => undefined, () => undefined)
      this.locks.set(key, tail)
      try {
        return await run
      } finally {
        if (this.locks.get(key) === tail) this.locks.delete(key)
      }
    }
    return acquire(0)
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    const local = await resolveLocalTarget(opts?.cwd ?? this.config.cwd, expandHomePrefix(path))
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
    const info = await probeNoFollow(localDisplayPath(cwd, expandHomePrefix(path)))
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (!info) return undefined
    return { version: info.version, type: info.type, size: info.size }
  }

  /**
   * The descriptor-pinned view of `target` ({@link pinReadTarget}), or `undefined`
   * when descriptor verification is off. Every content operation through the view
   * resolves against what was verified rather than the path.
   */
  private async verifiedReadTarget(
    target: FsTarget,
    signal?: AbortSignal,
  ): Promise<{ target: LocalTarget; close: () => Promise<void> } | undefined> {
    if (!this.descriptorVerified) return undefined
    return pinReadTarget(target, signal)
  }

  /** Pin the target's parent directory, or `undefined` when descriptor verification is off. */
  private async pinnedParent(target: FsTarget, signal?: AbortSignal): Promise<PinnedDirectory | undefined> {
    if (!this.descriptorVerified) return undefined
    return pinDirectory(dirname(target.targetKey), target.displayPath, signal)
  }

  /** The path a mutation must use for one target: through the pinned descriptor when present, else the resolved target key. */
  private pinnedChildPath(target: FsTarget, pinned: PinnedDirectory | undefined): string {
    return pinned ? join(pinned.path, basename(target.targetKey)) : target.targetKey
  }

  /**
   * The before-content basis, read through the verified descriptor when pinning is
   * on. A file deleted after the caller's preflight costs only the optional basis
   * (the verified helper's `FS_NOT_FOUND` becomes `null`); an identity refusal is
   * the swap this closes and fails the operation.
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

  /** Read a file's LF-normalized content through the verified descriptor when pinning is on. */
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

  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    if (!this.descriptorVerified) {
      return Promise.resolve(streamWholeText({ displayPath: target.displayPath, targetKey: target.targetKey }, signal))
    }
    // The verified open runs on the first read, as the path-based stream's open
    // does, so its failures (FS_NOT_FOUND, a refused swap) surface from iteration
    // in both modes. The descriptor stays open until the consumer finishes (or
    // abandons) the stream; `for await` calls `return()`, so the finally runs on
    // an early exit.
    return Promise.resolve((async function* () {
      const pinned = await pinReadTarget(target, signal)
      try {
        yield* streamWholeText(pinned.target, signal)
      } finally {
        await pinned.close()
      }
    })())
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
      const existing = await this.writeTarget(target, expected)

      // Capture an optional contextual-diff basis before the write. The bounded
      // reader checks the opened file itself, so an external replacement after
      // `probe()` cannot turn this best-effort presentation read into an
      // unbounded allocation. Either side at/above the configured limit yields
      // `before: null`; consumers retain their whole-file fallback.
      const diffable = existing !== null
        && Buffer.byteLength(content, 'utf8') < this.config.diffBasisMaxBytes
      const pinned = await this.pinnedParent(target, signal)
      const writePath = this.pinnedChildPath(target, pinned)
      try {
        // The diff basis is read through the SAME verified destination the write
        // uses, so a swapped component can never supply the before-text.
        const before = diffable ? await this.readDiffBasis(target, pinned, signal) : null
        await writeFileAtomic(writePath, content, existing?.mode, signal, this.internals,
          { displayPath: target.displayPath, createIfAbsent: expected?.kind === 'createIfAbsent' })
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

      const pinned = await this.pinnedParent(target, signal)
      const writePath = this.pinnedChildPath(target, pinned)
      try {
        // Read and write through the SAME verified destination: the literal match
        // applies to the pinned file, never to a swapped one.
        const original = await this.readTargetForEdit(target, pinned, signal)
        const edited = applyLiteralEdit(original.content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
        const content = restoreLineEndings(edited.content, original.lineEndings)
        await writeFileAtomic(writePath, content, existing.mode, signal, this.internals, { displayPath: target.displayPath })

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

  override async patchText(
    target: FsTarget, hunks: readonly PatchHunk[], expected?: { version: FsVersion }, signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(target.targetKey, async () => {
      const existing = await this.requireFile(target, expected, 'patch')
      const pinned = await this.pinnedParent(target, signal)
      const writePath = this.pinnedChildPath(target, pinned)
      try {
        // Read and write through the SAME verified destination: the hunks apply
        // to the pinned file, never to a swapped one.
        const original = await this.readTargetForEdit(target, pinned, signal)
        const after = this.patchContent(target, original.content, hunks)
        await writeFileAtomic(writePath, restoreLineEndings(after, original.lineEndings), existing.mode, signal, this.internals,
          { displayPath: target.displayPath })
        return { version: this.versionAfterWrite(await probe(writePath), target), before: original.content, after }
      } finally {
        await pinned?.close()
      }
    })
  }

  override async deleteFile(target: FsTarget, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsDeleteOutcome> {
    return this.withLock(target.targetKey, async () => {
      await this.requireFile(target, expected, 'delete')
      const pinned = await this.pinnedParent(target, signal)
      try {
        // The before-content comes from the verified descriptor, so a target
        // swapped after resolution fails here instead of being unlinked by path.
        const before = await this.readDiffBasis(target, pinned, signal)
        await this.internals.inspectBeforeMutation?.(target)
        if (signal?.aborted) throw new FsError('delete aborted', 'FS_ABORTED')
        await removeFile(this.pinnedChildPath(target, pinned), target.displayPath, this.internals)
        return { before }
      } finally {
        await pinned?.close()
      }
    })
  }

  override async moveFile(
    source: FsTarget, destination: FsTarget, options: Parameters<FileSystem['moveFile']>[2], signal?: AbortSignal,
  ): Promise<FsMoveOutcome> {
    if (source.targetKey === destination.targetKey) {
      throw new FsError(`cannot move "${source.displayPath}" to itself`, 'FS_SAME_TARGET')
    }
    return this.withLocks([source.targetKey, destination.targetKey], async () => {
      const sourceInfo = await this.requireFile(source, options.expectedSource, 'move')
      const existing = await this.writeTarget(destination, options.expectedDestination)
      let sourcePinned: PinnedDirectory | undefined
      let destinationPinned: PinnedDirectory | undefined
      try {
        // Pin the source before reading it; the destination is pinned only after
        // the source content is known, so a failed patch creates no directories.
        sourcePinned = await this.pinnedParent(source, signal)
        const original = await this.readTargetForEdit(source, sourcePinned, signal)
        const after = options.hunks === undefined ? original.content : this.patchContent(source, original.content, options.hunks)
        const content = restoreLineEndings(after, original.lineEndings)
        destinationPinned = await this.pinnedParent(destination, signal)
        const writePath = this.pinnedChildPath(destination, destinationPinned)
        const before = existing && Buffer.byteLength(content, 'utf8') < this.config.diffBasisMaxBytes
          ? await this.readDiffBasis(destination, destinationPinned, signal) : null
        await this.internals.inspectBeforeMutation?.(source)
        if (signal?.aborted) throw new FsError('move aborted', 'FS_ABORTED')
        // After this checkpoint, complete both effects and report them even if cancellation arrives.
        await writeFileAtomic(writePath, content, sourceInfo.mode, undefined, this.internals, {
          displayPath: destination.displayPath,
          createIfAbsent: options.expectedDestination?.kind === 'createIfAbsent',
          existingDestination: existing !== null,
        })
        const outcome: FsWriteOutcome = {
          operation: existing ? 'update' : 'create',
          version: this.versionAfterWrite(await probe(writePath), destination), before, after,
        }
        const sourceBefore = Buffer.byteLength(original.content, 'utf8') < this.config.diffBasisMaxBytes ? original.content : null
        try {
          await removeFile(this.pinnedChildPath(source, sourcePinned), source.displayPath, this.internals)
        } catch (error) {
          // removeFile maps I/O failures; unexpected defects must still reject.
          if (!(error instanceof FsError)) throw error
          return { sourceBefore, destination: outcome, sourceDeleted: false, sourceFailure: { code: error.code, message: error.message } }
        }
        return { sourceBefore, destination: outcome, sourceDeleted: true }
      } finally {
        // Close both pins even when one close fails; the descriptors are independent.
        await Promise.all([destinationPinned?.close(), sourcePinned?.close()])
      }
    })
  }

  private async writeTarget(target: FsTarget, expected?: FsWriteIntent): Promise<PathInfo | null> {
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

    return existing
  }

  private async requireFile(target: FsTarget, expected: { version: FsVersion } | undefined, verb: string): Promise<PathInfo> {
    const existing = await probe(target.targetKey)
    if (!existing) throw new FsError(`cannot ${verb} "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    if (existing.type !== 'file') throw new FsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (expected && existing.version !== expected.version) {
      throw new FsError(`cannot ${verb} "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    return existing
  }

  private patchContent(target: FsTarget, before: string, hunks: readonly PatchHunk[]): string {
    const result = applyHunks(before, hunks)
    if (!result.ok) {
      throw new FsError(`cannot patch "${target.displayPath}": hunk at patch line ${result.failure.hunkLineNumber} (${result.failure.stage}) does not match`, 'FS_PATCH_MISMATCH')
    }
    return result.after
  }

  /* v8 ignore next 5 -- the post-write probe finding the file absent requires a
   * concurrent unlink between rename and stat; fall back to a sentinel version. */
  private versionAfterWrite(after: { version: FsVersion } | null, target: FsTarget): FsVersion {
    if (after) return after.version
    return FsVersion(`missing:${target.targetKey}`)
  }
}

export default LocalFileSystem
