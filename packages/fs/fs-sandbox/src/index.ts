/**
 * `SandboxedFileSystem`: the sandbox-enforcing implementation of the
 * `@deepseek-ai/dsh-fs` Service Definition. It extends `LocalFileSystem` so all
 * text-storage mechanics — resolve, stat, read/stream, list, the atomic
 * write and the read-match-write edit critical section — are the local
 * implementation's, verbatim; this package adds the per-call POLICY fence on
 * the two mutations, and — when `fenceReads` is enabled — the same containment
 * fence on the content-bearing reads. By DEFAULT reads pass through untouched:
 * every mode permits reading. An operator whose deployment treats the model as
 * untrusted code rather than as a cooperative author turns the read fence on,
 * because the harness tools run in the HARNESS process, where the bash runner's
 * kernel mask (`@deepseek-ai/dsh-sandbox-local`'s `hidePaths`) has no reach.
 *
 * The fence is a policy check in TRUSTED code over a MODEL-CONTROLLED path,
 * NOT a kernel boundary — the operations are the seam's own (open, rename),
 * and only the target path is untrusted, so canonicalize-then-contain is the
 * complete answer to this surface. This is containment, not a security
 * boundary; kernel-grade isolation of untrusted CODE stays `ctx.shell`'s job
 * (`@deepseek-ai/dsh-bash-sandbox`).
 *
 * A canonicalize-then-contain check is only as good as the identity the kernel
 * ACTUALLY opened, so this backend also turns on the local backend's
 * descriptor-level verification (`verifyOpens`): a read opens the canonical
 * target, verifies that the descriptor's reported path IS that target, and serves
 * the bytes from the descriptor; a mutation pins the destination directory by
 * descriptor and stages/publishes through it. A symlink swapped into the path
 * after the containment check therefore fails the operation instead of escaping
 * the fence. That primitive needs `/proc/self/fd`
 * (`dsh-fs-local`'s `FD_PINNING_AVAILABLE`); on a host without it verification is
 * inert and this fence keeps its resolve-then-open window — see the README's
 * "not verified" note.
 *
 * Per-call policy: `read-only` denies every mutation; `workspace-write` allows
 * a mutation only when the target canonicalizes under the policy's workspace
 * root or a platform temp area from the shared `writableRoots` policy;
 * `danger-full-access` delegates unfenced. A denial throws the structured
 * `FS_SANDBOX_DENIED`. With `fenceReads` enabled the CONTENT-bearing reads
 * (`readText`, `streamText`, `readBytes`, `readByteRange`, `listDir`) follow the
 * same per-call policy under `workspace-write` — a confinement, never a grant:
 * `read-only` and `danger-full-access` stay unfenced for reads, so the option
 * can only narrow what was already permitted.
 *
 * @module @deepseek-ai/dsh-fs-sandbox
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LocalFileSystem, DEFAULT_DIFF_BASIS_MAX_BYTES, MAX_DIFF_BASIS_BYTES } from '@deepseek-ai/dsh-fs-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { isPathUnder } from './containment.ts'

/**
 * Plugin config: the local backend's knobs verbatim (`cwd` resolution default
 * and `diffBasisMaxBytes` overwrite-presentation bound), plus the read fence.
 * The sandbox default (mode + `workspace-write` fallback root) is NOT here —
 * `ctx.sandboxPolicy` resolves each calling session for every enforcing
 * capability.
 */
export interface Config extends LocalConfig {
  /**
   * Contain the content-bearing reads to the same roots the `workspace-write`
   * mode already confines WRITES to (the policy's workspace root plus the
   * platform temp areas). Defaults to `false`: reads stay unfenced, which is
   * this backend's historical behaviour and what a cooperative author wants —
   * an agent that can only read its workspace cannot gather context from the
   * rest of the host.
   *
   * Turn it on when the model is untrusted CODE rather than a cooperative
   * author, and the bash runner's kernel mask is not enough: the file tools run
   * in the HARNESS process with the deployment's privileges, where a bwrap
   * `hidePaths` mask cannot reach. The fence is the SAME containment predicate
   * the writes use, so a session can never read what a differently-confined
   * shell could not; `read-only` and `danger-full-access` are unaffected, so
   * enabling it can only narrow reads.
   */
  fenceReads?: boolean
}

/**
 * Sandbox-enforcing filesystem backend. Registers as `ctx.fs` (loading it
 * INSTEAD OF `dsh-fs-local`, together with a `ctx.sandboxPolicy`, is the whole
 * swap — the model-facing tools are untouched). Its configured default mode is
 * the capability fact exposed by {@link sandboxMode}; `dsh-tool-fs` resolves
 * each session's mode and cwd into a policy for every mutation, while an
 * approved escalation may stamp a strictly wider mode for one call.
 */
export class SandboxedFileSystem extends LocalFileSystem {
  static inject = ['sandboxPolicy']

  /**
   * Config extending the local knobs with {@link Config.fenceReads}. The local
   * fields keep fs-local's OWN bounds (imported, not restated), so the two
   * schemas cannot drift; `set` would mutate fs-local's static in place, so this
   * builds a fresh schema instead.
   */
  static override Config: z<Config> = z.object({
    cwd: z.string().default(process.cwd()),
    diffBasisMaxBytes: z.number()
      .default(DEFAULT_DIFF_BASIS_MAX_BYTES)
      .max(MAX_DIFF_BASIS_BYTES),
    fenceReads: z.boolean().default(false),
  })

  private readonly defaultMode: SandboxMode
  /** {@link Config.fenceReads} as resolved: whether reads are contained like writes. */
  private readonly fenceReads: boolean
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.defaultMode = ctx.sandboxPolicy.defaultMode
    this.fenceReads = config.fenceReads === true
    // The containment check is a resolve-then-open window over a path a model can
    // swap; verify the descriptor the kernel opened, in every mode. It is a
    // NARROWING, never a grant: a stable permitted path is unaffected, and only an
    // operation whose opened identity differs from the resolved one is refused.
    this.verifyOpens = true
  }

  /** The deployment default mode — the capability fact the tool layer reads to advertise escalation. */
  override get sandboxMode(): SandboxMode {
    return this.defaultMode
  }

  /**
   * Fence the write by the per-call policy, then delegate to the inherited
   * atomic write. See {@link checkedTarget}.
   * @param target - the resolved target to write.
   * @param content - the full new file content.
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the write outcome from the inherited backend.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal)
  }

  /**
   * Fence the edit by the per-call policy, then delegate to the inherited
   * atomic edit. See {@link checkedTarget}.
   * @param target - the resolved target to edit.
   * @param edit - the literal search/replace request.
   * @param expected - the version guard; omit for an unconditional edit.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the edit outcome from the inherited backend.
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal)
  }

  /**
   * Fence the read by the per-call policy when {@link Config.fenceReads} is on,
   * then delegate to the inherited read. See {@link checkedRead}.
   * @param target - the resolved target to read.
   * @param signal - aborts the read.
   * @returns the file's full text.
   */
  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return super.readText(await this.checkedRead(target), signal)
  }

  /**
   * Fence the streamed read by the per-call policy when {@link Config.fenceReads}
   * is on, then delegate. See {@link checkedRead}. The fence runs BEFORE any
   * chunk is produced, so a denied stream yields no content at all rather than a
   * prefix followed by a refusal.
   * @param target - the resolved target to stream.
   * @param signal - aborts the read.
   * @returns the inherited text stream.
   */
  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return super.streamText(await this.checkedRead(target), signal)
  }

  /**
   * Fence the byte read by the per-call policy when {@link Config.fenceReads} is
   * on, then delegate. See {@link checkedRead}.
   * @param target - the resolved target to read.
   * @param signal - aborts the read.
   * @param maxBytes - the caller's byte cap.
   * @returns the file's bytes.
   */
  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return super.readBytes(await this.checkedRead(target), signal, maxBytes)
  }

  /**
   * Fence the ranged read by the per-call policy when {@link Config.fenceReads}
   * is on, then delegate. See {@link checkedRead}.
   * @param target - the resolved target to read.
   * @param range - the byte window to return.
   * @param signal - aborts the read.
   * @returns the requested byte window.
   */
  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    return super.readByteRange(await this.checkedRead(target), range, signal)
  }

  /**
   * Fence the directory listing by the per-call policy when
   * {@link Config.fenceReads} is on, then delegate. See {@link checkedRead}:
   * listing a denied directory reveals its entry names, which is a read of the
   * directory, so it is fenced with the contents.
   * @param target - the resolved directory to list.
   * @param signal - aborts the listing.
   * @returns the directory's entries.
   */
  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return super.listDir(await this.checkedRead(target), signal)
  }

  /**
   * Enforce the per-call policy against a READ when {@link Config.fenceReads} is
   * on, and return the exact target the read must use. Off by default, and even
   * when on it can only NARROW: `read-only` and `danger-full-access` permit every
   * read, and only `workspace-write` contains — to the same `writableRoots`
   * allow-list the mutations use, so the file tools and the shell never confine
   * to different roots.
   *
   * The check re-canonicalizes the target NOW (`resolve` realpaths the deepest
   * existing ancestor, so a symlink swapped since the tool resolved the target is
   * seen) and hands the fresh target to the inherited read. That read then opens
   * first and verifies the descriptor it opened against this same canonical target
   * before any byte is returned (the local backend's `verifyOpens`, enabled in this
   * class), so on a host with `/proc/self/fd` the identity checked IS the one read.
   * Where that primitive is unavailable the inherited read is path-based again and
   * only the resolve-then-open direction above remains — the same anti-TOCTOU
   * direction as {@link checkedTarget}. Metadata reads (`stat`, `lstat`) are
   * deliberately NOT fenced: they expose existence and size, never content.
   */
  private async checkedRead(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsTarget> {
    if (!this.fenceReads) return target
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    // A confinement, not a grant: only the containing mode is narrowed.
    if (policy.mode !== 'workspace-write') return target
    const fresh = await this.resolve(target.displayPath)
    let contained = false
    for (const root of writableRoots(policy)) {
      if (await isPathUnder(fresh.targetKey, root)) {
        contained = true
        break
      }
    }
    if (!contained) {
      throw new FsError(`cannot read "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
    return fresh
  }

  /**
   * Enforce the per-call policy against `target` and return the EXACT target the
   * mutation must use, so the checked identity is the mutated one (no
   * check-here-write-there TOCTOU). `read-only` denies; `workspace-write`
   * re-canonicalizes NOW (`resolve` realpaths the deepest existing ancestor,
   * reflecting a concurrently swapped symlink), requires containment under a
   * writable root, and returns THAT fresh target; `danger-full-access` returns
   * the caller's target unfenced. The mutation then pins the destination directory
   * by descriptor (`verifyOpens`) and stages/publishes through it, so a component
   * swapped after this check cannot redirect the write either. Throws the
   * structured `FS_SANDBOX_DENIED` on refusal — the tool layer maps it to the
   * model-facing `[sandbox: …]` marker and the escalation hint.
   */
  private async checkedTarget(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const { mode } = policy
    if (mode === 'danger-full-access') return target
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    // workspace-write: containment on the FRESH canonical path (catches a
    // symlink ancestor swapped since the tool resolved this target), and the
    // mutation delegates with THIS fresh target — never the stale one.
    const fresh = await this.resolve(target.displayPath)
    let contained = false
    for (const root of writableRoots(policy)) {
      if (await isPathUnder(fresh.targetKey, root)) {
        contained = true
        break
      }
    }
    if (!contained) {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
    return fresh
  }
}

export default SandboxedFileSystem
