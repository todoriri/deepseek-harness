# Agent Note: bwrap network and host-path hardening as provider configuration

Status: implemented

English | [中文](2026-10-13-sandbox-local-bwrap-hardening-config.zh.md)

## Problem

Inside the default `workspace-write` bwrap profile a confined command reaches the host network and reads every file the operator can read: `--ro-bind / /` presents the whole tree, and an unprivileged user namespace changes no ownership. Measured 2026-10-12 on the reporting host: a TCP connect to a host listener was accepted, 10 files under `~/.ssh` and 1006 under `~/.dsh` were readable, and `~/.config/gh/hosts.yml` was readable. For an autonomous agent whose shell must be assumed hostile, readable credentials and an open network are the exfiltration pair (loopcc review finding D86-2, recorded in the loopcc project).

Two premises of the original request were wrong and shaped the decision: the harness process, not the sandbox, runs the model transport, so closing the network cannot break provider access; and every in-repo spawner already strips credential-shaped environment names before a child starts, so no environment work was needed.

## Decision

`@deepseek-ai/dsh-sandbox-local` gains three validated config fields: `network: 'inherit' | 'none'`, `hidePaths`, and `exposeReadOnly`. They are the operator's standing choice for every confined command, carried on the provider, not on the per-call `SandboxPolicy`, whose vocabulary stays file effects only.

- bwrap appends `--unshare-net`, then a tmpfs per masked directory, then the read-only exposure binds, then the mode mounts, and remounts every mask read-only last. The order is the mechanism: bwrap must create the mountpoints beneath a mask before it turns read-only, and `--remount-ro` is not recursive, so the workspace beneath a mask stays writable. The bwrap probe runs the hardened profile.
- Only bwrap, or a bwrap-compatible `runnerCommand`, expresses the hardening. When selection lands on Landlock, Seatbelt, or the Windows ACL runner, the provider caches `unavailable` and `confine()` throws `SANDBOX_UNAVAILABLE` naming that runner, never confining with the hardening silently dropped.
- Paths are validated and canonicalized at load: absolute, existing, a mask never `/`, an exposure beneath some mask. Which toolchain paths survive is the operator's list in `cordis.yml`, never a constant in `profiles.ts`, because toolchain locations vary per host.
- Defaults produce the unchanged argv; no upgrade guide is needed.

## Consequences

- An opted-in deployment loses `pnpm install`, `git fetch`, `curl`, and loopback to host services inside confined commands; a worker whose landing runs outside the sandbox accepts that.
- A host without usable bwrap cannot confine at all once any field is set; the refusal names the runner so the operator can see why.
- Hiding `$HOME` removes the shell-based exfiltration path only. The harness process itself still runs with the operator's privileges; what its own tools may read is a separate decision.
- The Landlock rung cannot mask a directory (its grants are an allow-list) and has no network control without native-addon work; the Seatbelt `(deny network*)` form was not shipped because no macOS host was available to exercise it, and an untested enforcement claim is worse than a refusal.

## Alternatives considered

**Network and masks as fields of the per-call policy.** Rejected: the seam documents file effects as its whole vocabulary, and the change would need four runner implementations plus the native Landlock launcher for one operator's deployment-level choice.

**Rebuilding the root from `/usr`, `/bin`, `/lib` instead of masking.** Rejected: host-specific and fragile, it breaks `/mnt` worktrees whose git directory lives outside the workspace, and it gains little over masking the directories that hold the secrets.

**Leaving the mask writable.** Rejected: `read-only` promises no writable sink beyond `/dev/null`, and under `--ro-bind / /` the masked directory was already read-only, so the read-only mask preserves today's behavior exactly.

**Refusing at load on platforms whose chain has no bwrap.** Rejected in favor of one refusal path at the first confined wrap: runner selection is already lazy and probe-dependent on Linux, and a second load-time path would be unreachable in the Linux coverage lane.
