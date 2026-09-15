# LOGGING — where DeepSeek Harness keeps its logs & data

Where `dsh` (the DeepSeek Harness browser UI) stores the conversation log, its
derived caches, runtime logs, and telemetry on this host (`rai`, user
`todoriri`, service `dsh-web.service`).

All user data lives under **`$DSH_HOME`** (default `~/.dsh`; set `$DSH_HOME` to
relocate everything below). Use your real home, e.g. `/home/todoriri/.dsh`.

## 1. Conversation log — the "traces and trajectory" the Web UI shows

The durable, append-only **session event log** (`SessionEvent`s:
`turn/start`, `user/message`, `assistant/chunk`, `tool/call`, `tool/result`,
`step/end`, `turn/end`, …).

```
$DSH_HOME/sessions/<project-key>/session-<uuid>/session.jsonl.zstd
```

- Root: `dshHomePath('sessions')` = `$DSH_HOME/sessions` (set in the web
  profile's `session-persistence-jsonl` config).
- Path scheme (source: `packages/session/session-persistence-jsonl/src/format.ts`):
  `<root>/<projectKey(cwd)>/session-<uuid>/session.jsonl.zstd`.
  `<project-key>` is derived from the session's working directory (`/` → `-`);
  `session-<uuid>` is the session id.
- Format: JSONL, **zstd-compressed** by default. First line is a header
  record, then one `SessionEvent` per logical line (delta chunks pack into
  `text-chunks` / `reasoning-chunks` / `tool-call-chunks` rows by default).

Example from rai (`zstd -d -c`):
```
{"type":"session","version":0,"id":"session-172537c7-…","cwd":"/mnt/data1/Projects/DeepSeek-V4-Flash-Dual-DGX-Spark-1M-Context",…}
{"type":"user/message","seq":N,"time":…,"data":{…}}
```

This log is the **source of truth**: the model's context and the Web UI
trajectory are projected from it (see `docs/architecture.md` — "The session
log is the source of the context the model sees").

### Read a session
```sh
zstd -d -c \
  ~/.dsh/sessions/<project-key>/<session-uuid>/session.jsonl.zstd
```

### Note: sessions group by project (cwd)
The `dsh-web.service` runs with `WorkingDirectory=/mnt/data1/Projects/deepseek-harness`,
so new sessions created through the service land under the project key
`--mnt-data1-Projects-deepseek-harness--` — not under the key of an older
project you may have been in with an earlier launch.

## 2. Derived / index caches (sidebars, session cards)

Rebuildable from the logs, not the source of truth:

```
$DSH_HOME/storages/session_projcache.json   # per-session title, goal, sessionStats (turns/steps/llmMs)
$DSH_HOME/storages/workspace.json           # workspace path -> sessionIds
```

## 3. Runtime / service logs

The harness's operational stdout/stderr is captured by systemd (not a dsh file):

```sh
sudo journalctl -u dsh-web -f
```

## 4. Telemetry (remote, off by default)

Session telemetry is an **OTLP remote export**, not stored locally. It is
disabled by default (`DSH_TELEMETRY_MODE || 'DISABLED'` in the web profile's
`session-telemetry-otel` config); when enabled it POSTs to
`https://harness-telemetry.deepseeksvc.com/v1/logs`. Nothing leaves the machine
unless you opt in.

## 5. Other user data under `$DSH_HOME`

```
$DSH_HOME/settings.yaml        # settings
$DSH_HOME/.credentials.yaml    # API credentials
$DSH_HOME/profiles/web/        # web profile + your patch layer (cordis.patch.yml)
```
