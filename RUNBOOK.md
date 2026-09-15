# RUNBOOK — DeepSeek Harness Web UI as a systemd service (local)

Operational record for running `dsh web` (the DeepSeek Harness browser UI) as a
systemd service on this host. Applies to this machine (`rai`, user `todoriri`,
Node v26.8.1, repository checkout at `/mnt/data1/Projects/deepseek-harness`,
pinned to release `dsh-v0.1.2-alpha.5`).

**Current setup: local-only.** The Web UI is served on loopback
(`127.0.0.1:3080`) for local use directly on `rai`. There is no LAN/firewall
exposure.

## Service

| Unit | Role | Listens on |
|---|---|---|
| `dsh-web.service` | the harness (built launcher `apps/cli/lib/bin.js web`) | `127.0.0.1:3080` (loopback) |

`dsh-web.service` is `enabled` at boot and `Restart=on-failure`.

### Service file
`/etc/systemd/system/dsh-web.service` (ExecStart):
```
/home/todoriri/.nvm/versions/node/v22.20.0/bin/node \
  /mnt/data1/Projects/deepseek-harness/apps/cli/lib/bin.js web \
  --host 127.0.0.1 --port 3080
```

- Runs as `User=todoriri` with `WorkingDirectory` = the checkout.
- `DSH_PERMISSION_MODE=workspace-write` keeps the `ask` approval policy
  (vs `danger-full-access`, which sets approval to `never`).
- Optional env overrides: `/etc/dsh/web.env` (root-only; e.g. `DEEPSEEK_API_KEY`,
  `DSH_TELEMETRY_*`). Not required — the model key already lives in
  `~/.dsh/.credentials.yaml`.

## Operations

```sh
systemctl status dsh-web                 # status
sudo journalctl -u dsh-web -f            # logs (the "dsh web: http://127.0.0.1:3080" URL line = readiness)
sudo systemctl restart dsh-web           # restart
sudo systemctl stop dsh-web              # stop
# after editing /etc/systemd/system/dsh-web.service
sudo systemctl daemon-reload && sudo systemctl restart dsh-web
```

## Verification

```sh
ss -tlnp | grep ':3080'                                   # LISTEN 127.0.0.1:3080 (node)
# The Web UI is token-gated: bare `/` returns 401; `/?token=…` returns 303
# (sets the trust cookie). Grab the live URL from the service log:
sudo journalctl -u dsh-web --no-pager | grep -oE 'http://127.0.0.1:3080/\?token=[A-Za-z0-9_-]+' | tail -1
```

## Updating to a new HEAD

The service runs the *built* launcher, so after pulling new commits: reinstall,
**clean**, rebuild, restart.

```sh
git fetch origin && git merge --ff-only origin/master
pnpm install
pnpm run clean          # REQUIRED on large jumps (see note below)
pnpm run build
sudo systemctl restart dsh-web
```

Skipping `pnpm run clean` makes `pnpm run build` (tsdown) fail with
`[MISSING_EXPORT]` errors that cite stale `lib/**` files importing symbols
removed from the new source. That is stale build output, not a source bug —
clean and rebuild.

## Troubleshooting

- **Port already in use (`EADDRINUSE` in `journalctl -u dsh-web`)** — another
  `dsh web` is running. Find/stop it: `ss -tlnp | grep :3080`, `kill <pid>`.
  Sessions are durable in `~/.dsh/sessions/*.jsonl.zstd`, so a restart loses no
  history.
- **Harness won't start after a source edit** — the unit uses the *built*
  launcher (`apps/cli/lib/bin.js`). Rebuild (`pnpm run clean && pnpm run build`)
  from the repo root and restart.

## History / why loopback-only

- The harness **cannot bind a specific LAN IP**: its webserver schema only
  accepts `127.0.0.1` or `0.0.0.0`, and the `--host 0.0.0.0` *flag* is
  deliberately rejected for safety (it exposes the agent's remote-code-execution
  surface to the network, and the `/api` browser-trust fence is not an
  authentication layer). See `packages/host/webserver/src/index.ts` and
  `packages/bundle/web-app/src/startup.ts`.
- A previous iteration exposed the UI to the LAN via a `socat` forwarder
  (`dsh-web-lan.service`, `192.168.1.52:3080` → `127.0.0.1:3080`). That was
  **removed**; remote use from another machine is unsupported/reverted, and the
  UI is intended for local use on this host. If remote access is ever needed
  again, prefer a TLS + authenticated reverse proxy (or Tailscale), not a bare
  forwarder.
