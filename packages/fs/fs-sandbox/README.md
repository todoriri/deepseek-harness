---
description: "The sandbox-enforcing ctx.fs backend for deployments and maintainers confining model file mutations to a session workspace."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-sandbox

English | [中文](README.zh.md)

## Summary

`dsh-fs-sandbox` confines model file writes and edits according to each session's sandbox mode while preserving the local filesystem's read behavior. In `read-only`, it rejects every mutation; in `workspace-write`, it permits targets only inside the session workspace or a platform temporary root; in `danger-full-access`, it does not restrict mutations. Use it instead of `fs-local` with `ctx.sandboxPolicy` when sessions need workspace-confined file changes. Denied operations return `FS_SANDBOX_DENIED`, which filesystem tools present with the active mode and a same-turn escalation hint.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this backend instead of `fs-local` when the model's file writes and edits must be confined by the session's sandbox mode. Reads stay unconfined by default; set `fenceReads: true` when the model is untrusted code, which contains the reading tools to the same roots. The fence applies per call: the tool layer resolves the calling session's mode and workspace root into the same policy the bash runner receives, so the filesystem and shell families never confine to different roots.

### Minimal composition

Load the shared policy service, then this backend, then the tools; the read-before-edit policy plugin stays optional.

```yaml
- name: '@deepseek-ai/dsh-sandbox-policy'
- name: '@deepseek-ai/dsh-fs-sandbox'
  config:
    cwd: /absolute/path/to/workspace
    # Contain `read`, `read_image`, `list` and search to the workspace + temp
    # roots. Leave it out for a cooperative author that needs host context.
    fenceReads: true
- name: '@deepseek-ai/dsh-tool-fs'
```

Alongside the local backend's knobs (`cwd` resolution default and `diffBasisMaxBytes` overwrite bound), this backend adds `fenceReads`; the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-fs-sandbox) is the exhaustive source.

### How the fence behaves

The effective mode comes from the calling session's override or escalation grant, falling back to the deployment default when neither is in force. `read-only` denies every mutation with the structured `FS_SANDBOX_DENIED`. `workspace-write` allows a mutation only when the target canonicalizes under the workspace root or the platform temp dir (`os.tmpdir()`, which honours `TMPDIR`; the literal `/tmp` is a root exactly when it resolves to the same directory) — the same writable set the Seatbelt profile grants (review.16.10 F2, D134). `danger-full-access` delegates unfenced.

With `fenceReads: true`, the content-bearing reads (`readText`, `streamText`, `readBytes`, `readByteRange`, `listDir`) follow that same policy under `workspace-write`. The option only ever NARROWS: `read-only` and `danger-full-access` keep permitting every read, so enabling it cannot grant access a session did not already have. Metadata reads (`stat`, `lstat`) stay unfenced — they expose existence and size, never content.

### Observable success and failures

Reads, listings, metadata, and read-only watches work exactly as with `fs-local` unless `fenceReads` is set; the mutation fence does not restrict observation. A denied mutation returns an `FS_SANDBOX_DENIED` error carrying the effective mode; through the tools the model sees `[sandbox: file access denied under <mode> mode]` plus the one-approved-wider retry hint, identical to bash's denials. A denied read returns the same shape and no content at all — a denied stream yields no prefix. A session with an approved escalation may retry the same operation at a strictly wider mode for that one call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the sandbox backend and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The fence is a policy check in trusted code over a model-controlled path — not a kernel boundary. The operations are the seam's own (open, rename); only the target path is untrusted, so canonicalize-then-contain is the complete answer to this surface. Kernel-grade isolation of untrusted code stays `ctx.shell`'s job.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `SandboxedFileSystem`: mode fence on `writeText`/`editText`, the optional `fenceReads` fence on `readText`/`streamText`/`readBytes`/`readByteRange`/`listDir`, `sandboxMode` fact |
| [`src/containment.ts`](src/containment.ts) | Ancestor containment check with lexical fast path and identity-based fallback |

### How a mutation is fenced

Each mutation resolves the per-call policy (`danger-full-access` returns the caller's target untouched; `read-only` throws `FS_SANDBOX_DENIED`), then for `workspace-write` re-canonicalizes the target immediately and requires containment under one of the writable roots derived from the single `writableRoots` function — the same set the Seatbelt profile grants, so the fs fence and the bash runner cannot drift. The fresh target is the one mutated, so a symlink ancestor swapped since the tool resolved it is caught. The mutation then pins the destination directory by DESCRIPTOR (`fs-local`'s `verifyOpens`, which this backend enables): the staging directory, its file and the publication rename all go through `/proc/self/fd/<dirfd>/…`, so a component swapped after this containment check cannot redirect the write either.

### How a read is fenced

Only when `fenceReads` is enabled, and only under `workspace-write`: the guard re-canonicalizes the target through the same `resolve` the mutations use, requires containment under the same `writableRoots` set, and hands THAT fresh target to the inherited read — so a symlink ancestor swapped since the tool resolved the target is caught. That read then opens FIRST and verifies that the path the kernel reports for the descriptor IS the resolved target before any byte is returned, and serves the bytes from that descriptor: a swap landing between the containment check and the open therefore fails instead of escaping. This needs `/proc/self/fd` (Linux; Node exposes no `openat`), and on a host without it the inherited read is path-based again — only the resolve-then-open direction above stands, which the backend reports rather than hides. The check runs before any content is produced, so a denied stream yields nothing rather than a prefix.

### Threat model

On Linux the resolve-to-syscall window is closed by DESCRIPTOR PINNING: a read opens first and verifies the descriptor it opened against the resolved target, and a mutation pins the destination directory, so a symlink a confined worker swaps into the path no longer redirects either operation. Where `/proc/self/fd` is unavailable (Node exposes no `openat`), those primitives are inert and the window remains — the backend reports that platform fact rather than hiding it. A denial is a structured `FsError`, not stderr inference — an in-process fence knows exactly what it refused.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from this backend to the shared policy home and the confinement decisions behind it.

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — exhaustive provider contract, policy events, and error taxonomy.
- [dsh-fs](../fs/README.md) — the `ctx.fs` contract this backend implements.
- [fs-local](../fs-local/README.md) — the local backend this one extends.
- [sandbox-policy](../../sandbox/sandbox-policy/README.md) — the shared per-session policy resolver this backend requires.
- [Process sandbox subsystem](../../../docs/subsystems/sandbox.md) — modes, per-call policy, and fail-closed errors.
- [Cross-family fs sandbox reference](../../sandbox/sandbox-policy/README.md) — the shared mode fence and its escalation choreography.

-----

<a id="model-experience"></a>
## Model Experience

### Filesystem policy and refusals

#### What the model sees

The policy owner contributes capability-neutral `sandbox:policy` context. Indirectly, `dsh-tool-fs` renders this backend's `FS_SANDBOX_DENIED` refusals as the `[sandbox: file access denied under <mode> mode]` marker plus the same-turn escalation hint.

#### Token effect

The current-policy clause adds a small runtime-context message while this backend is mounted; a denial adds the bounded marker and escalation hint to conversation history.

#### KV Cache effect

A standing-policy change appends an owner-rendered superseding runtime-context snapshot after retained history; operation results remain append-only.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the sandbox backend is a poor fit or needs special operational care. They are current package constraints, not a general sandbox comparison or a task backlog.

- **A policy fence, not a kernel boundary** — the check is trusted code over a model-controlled path. On Linux descriptor pinning closes the resolve-to-syscall window for the fence's own operations; on a host without `/proc/self/fd` that window remains, and adversarial host processes are out of scope either way. Kernel-grade isolation of untrusted code stays `ctx.shell`'s.
- **Fence-vs-runner parity is derived from one owner** — the writable set comes from `writableRoots`, shared with the Seatbelt profile; a runner profile that defines its writable set elsewhere would drift.
- **Requires `ctx.sandboxPolicy`** — tools use it to resolve each session policy and the backend uses it for agentless-call fallbacks; the backend does not confine without it composed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
