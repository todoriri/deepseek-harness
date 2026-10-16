---
description: "Local per-platform sandbox backends for users and maintainers choosing, configuring, or debugging process confinement on Linux, macOS, or Windows."
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-local

English | [中文](README.zh.md)

## Summary

`dsh-sandbox-local` confines commands and their descendants on Linux, macOS, and Windows while sharing the host kernel and filesystem. It chooses a supported platform runner automatically and fails with `SANDBOX_UNAVAILABLE` when none is usable, so commands never silently run without confinement. Each execution reports `full` or `partial` enforcement plus denial and runner-failure signatures, allowing callers to distinguish an unavailable or broken sandbox from a policy denial. Choose it for host-local bash or pwsh execution; use a container or remote executor when the process needs an isolated environment.

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

Mount this provider behind `ctx.sandbox` and a confined executor, and every command the executor spawns runs confined under the policy you resolve. The shipped [base bundle](../../bundle/base/cordis.patch.yml) owns the default policy and executor wiring.

### When to choose it

Choose it when commands must run confined on the host: it is the default backend for Linux, macOS, and Windows compositions that mount `ctx.sandbox`. Choose a different mechanism when the process must run in an isolated environment — a container or remote executor replaces whole capabilities, and this provider shares the host kernel and filesystem.

### Minimal configuration

Load the sandbox service and mount the provider; the defaults below are the selection policy.

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
```

| Field | Default | Meaning |
|---|---|---|
| `runnerCommand` | `[]` | Custom runner argv; bwrap-compatible profile arguments are appended, full enforcement is asserted, and built-in selection and probes are skipped |
| `runnerFailureSignatures` | `[]` | Case-insensitive stderr substrings identifying the custom runner's own failure dialect; required with `runnerCommand` |
| `probeTimeoutMs` | `5,000` | Timeout for each functional probe of a competing runner candidate |
| `network` | `inherit` | Network reach of every confined command; `none` gives each a fresh network namespace holding only its own loopback (bwrap only) |
| `hidePaths` | `[]` | Absolute host directories every confined command sees as an empty read-only directory, the operator's `$HOME` being the intended entry (bwrap only) |
| `exposeReadOnly` | `[]` | Absolute paths beneath a `hidePaths` entry bound back read-only, such as a node prefix under a masked home; requires `hidePaths` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-sandbox-local) is the exhaustive source for every accepted field and its JSDoc.

### Confined execution and enforcement

With the provider mounted, a command runs under the mode you resolve per call. Enforcement is a reported fact, not a promise: `full` means the backend governs every promised file effect, while `partial` means it governs only a subset — the Windows ACL rung (hard-link, unconfined-read, and AppContainer-ACL boundaries) and older Landlock ABIs are the current partial cases, so a consumer that requires an absolute boundary can reject or surface them. Denied file effects surface through the backend's denial dialect, and a runner that fails before executing the command reports a structured runner-failure signature.

### Network hardening

`network: none` runs every confined command in a fresh network namespace holding only its own loopback: no host service, no LAN, no internet. The model transport runs in the harness process, outside the sandbox, so provider access is unaffected; inside confined commands it stops `pnpm install`, `git fetch`, `curl`, and loopback connections to host services. Choose it for an autonomous agent whose shell must be assumed hostile: readable credentials and an open network are the exfiltration pair. Only the bwrap runner and a bwrap-compatible `runnerCommand` apply it. When selection lands on Landlock, Seatbelt, or the Windows ACL runner, `confine()` fails closed with `SANDBOX_UNAVAILABLE` naming that runner rather than running with the network open.

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
  config:
    network: none
```

### Host-path hardening

`--ro-bind / /` hands a confined command every file the operator can read: an unprivileged user namespace changes no ownership, so `~/.ssh`, `~/.config/gh`, and the harness credential files are readable by default. `hidePaths` replaces each listed directory with an empty read-only directory; `exposeReadOnly` binds the toolchain a command still needs back into it, read-only. The workspace root and `/tmp` stay writable beneath a masked directory. Which paths survive is the operator's list, because toolchain locations vary per host: a symlink's target must be listed too, every path must exist at load, and an exposure beneath no mask is refused as a misconfiguration. The same bwrap-only refusal as `network` applies.

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
  config:
    network: none
    hidePaths: ['/home/operator']
    exposeReadOnly: ['/home/operator/.local/share/node', '/home/operator/.local/bin']
```

### Failures and recovery

An unsupported platform or an unusable runner fails closed: `confine()` rejects with `SANDBOX_UNAVAILABLE` and names the runner options for the platform, and the consumer surfaces that error rather than running the command unconfined. A runner that starts but refuses its profile is identified by its fatal stderr signature and exit code, so a broken sandbox is not mistaken for a denied command. The `runnerCommand` override is an operator assertion: it skips functional probes and assumes the configured runner implements the bwrap-compatible profile honestly.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains runner selection, the per-platform profiles, and the failure dialects; the observable behavior is fully covered in [Use this package](#use-this-package).

### Runner selection

Selection is by platform first, probes second: each platform has a runner chain (`linux`: `bwrap` then Landlock; `darwin`: Seatbelt; `win32`: the ACL restricted-token runner). A sole candidate is selected without a probe; competing candidates are functionally probed once in chain order, and the first usable verdict is cached for the provider's lifetime. A platform with no chain, or a chain where every probe fails, is unavailable and fails closed at `confine()`.

### Platform profiles

The bwrap profile combines a read-only host root, a fresh `/dev`, and `/proc` from a private PID namespace — commands manage their descendants but cannot see host processes, so procfs magic links cannot bypass the mounts; `workspace-write` adds an ephemeral `/tmp`, rewrites `TMPDIR` to that mount (`--setenv TMPDIR /tmp`, so a host `TMPDIR` naming a directory the sandbox cannot see is never inherited by confined code — review.16.10 F2, D134), and adds a writable workspace bind. The [historical private-PID note](../../../.agents/notes/archived/bug-fix/2026-08-06-bwrap-private-pid-namespace.md) records the boundary. `network: none` appends `--unshare-net` after the socket hardening, and the bwrap probe runs the hardened profile, so a host whose bwrap refuses the flag reads unusable instead of failing every command. Each `hidePaths` entry starts as a writable tmpfs so bwrap can create the mountpoints beneath it, the `exposeReadOnly` binds and the workspace bind, and is remounted read-only last; the remount is not recursive, so the workspace beneath a mask stays writable.

The `@deepseek-ai/node-addon-system/landlock-run` API supplies the platform launcher, functional probe, and grant vocabulary; this provider maps mode to grants only, keeping path resolution and probe parsing with the versioned binary.

The Seatbelt profile is allow-default with `(deny file-write*)` plus write allow-lists derived from the shared `writableRoots` helper, so exactly the mode's promised file effects are governed; every root is canonicalized because Seatbelt matches resolved paths (`/tmp` IS `/private/tmp`).

The Windows rung keeps one deterministic write SID and standing ACE per workspace, while every live session/workspace pair gets a random private temp directory with a distinct SID and revocable ACE — sessions sharing a workspace share its intended write authority without inheriting one another's temp authority. A fresh provider always chooses a new temp path and SID, so crash residue cannot block or authorize a resumed session. The rung reports `partial` enforcement because NTFS hard links alias one file object across paths, reads stay unconfined, and a tree another AppContainer tool has ACL'd with a package SID is unreadable to the Low-integrity child.

With the built-in Windows runner and a skill registry, this provider registers the [ACL diagnosis skill](../sandbox-windows-acl/README.md#failures-and-recovery). An operator-supplied `runnerCommand` does not register it; provider disposal removes the skill and its extracted resources.

When the built ACL runner is absent, source launch pins the `tsx/esm/api` loader and TypeScript path mapping to this installation. The command's working directory and ambient `TSX_TSCONFIG_PATH` cannot select the runner's source dependencies.

### Denial and runner-failure dialects

Each runner's kernel speaks its own denial dialect, carried on every wrap as `denialSignatures`, and `runnerFailureRules` give each runner's fatal signature, so consumers classify a runner refusal before checking denial signatures. The exact strings and exit codes live in [`src/index.ts`](src/index.ts).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: runner chain selection, functional probes, per-call wrap, ACL grant lifecycle |
| [`src/profiles.ts`](src/profiles.ts) | Per-platform profile builders: bwrap mounts, Landlock grants, Seatbelt SBPL |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Start with the subsystem reference for the shared vocabulary, then the seam contract, the consumers, and the win32 rung.

- [Process sandbox subsystem](../../../docs/subsystems/sandbox.md) — modes, per-call policy, and classification dialects.
- [Sandbox seam package](../sandbox/README.md) — the service contract this provider implements.
- [Bash sandbox executor](../../shell/bash-sandbox/README.md) — the confined bash consumer.
- [Windows ACL restricted-token rung](../sandbox-windows-acl/README.md) — the win32 backend this provider mounts.
- [The historical subprocess sandbox decision](../../../.agents/notes/archived/feature/2026-07-06-sandbox.md) — capability boundary and runner selection semantics.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.md) and [`dsh-tool-bash`](../../shell/tool-bash/README.md), which render this provider's enforcement and denial facts, while the [`dsh-sandbox`](../sandbox/README.md) seam owns the `SANDBOX_UNAVAILABLE` text and this provider owns runner selection, and profiles stay outside context.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit or needs special operational care. They are current package constraints, not a general platform comparison or a task backlog.

- **Windows ACL enforcement is partial** — NTFS hard links alias one file object across workspace and external paths, reads stay unconfined, and a tree another AppContainer tool has ACL'd with a package SID is unreadable to the Low-integrity child. The provider reports `enforcement: 'partial'` rather than overstating that boundary as full.
- **Landlock may be partial** — older supported kernel ABIs confine only the access classes they expose, reported as `enforcement: 'partial'` rather than overstated as full.
- **Seatbelt depends on deprecated `sandbox-exec`** — macOS still ships it, but this provider cannot replace or probe that private policy engine if Apple removes it.
- **Runner selection is cached for the provider lifetime** — installing, removing, or repairing a runner requires reloading the plugin before selection changes.
- **`runnerCommand` is an operator assertion** — a configured custom runner skips functional probes and is assumed to implement the bwrap-compatible profile honestly; if it is itself a Bash script, its interpreter startup runs before that script applies confinement.
- **Network and host-path hardening are bwrap-only** — `network: none`, `hidePaths`, and `exposeReadOnly` have no Landlock, Seatbelt, or Windows ACL implementation; the provider refuses those runners under that configuration instead of dropping it, so a host without usable bwrap cannot confine at all once they are set.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: environment-coherent groups

An environment-coherent capability group example, such as bash plus fs against one container, remains undecided.

</details>
