# Adoption backlog — `deepseek-recipe` + `harness-opt` → DeepSeek Harness

- **Backlog drafted:** 2026-09-16. **Reconciled and premise-checked:** 2026-09-17.
- **Status:** fork-local operator document, **not** upstream-bound. It sits at the repository
  root, beside `LOGGING.md` and `RUNBOOK.md`, because `docs/**` requires a bilingual triplet
  (`<name>.md` + `<name>.zh.md` + `.i18n.yaml`) that a fork-local backlog does not need.
- **Authority for scope:** repl's `docs/temp_repos/stash-eval-harness-opt-deepseek-recipe-2026-09-16.md`
  and `docs/temp_repos/EXECUTION_PLAN-2026-09-16.md` (gitignored scratch), decisions G1–G4.
  This file is the dsh-side continuation of that plan; repl-side units (U0–U5 complete, U8/R3/R9
  operator-gated) stay tracked in repl.

## Checkout reconciliation (2026-09-17, done)

| Item | State |
|---|---|
| `origin` | `https://github.com/todoriri/deepseek-harness` (the fork) |
| `upstream` | `https://github.com/deepseek-ai/deepseek-harness` (previously `origin`) |
| pin branch | `pin/0.1.5-rc.2-docs` = `2f47366b70` (0.1.5-rc.2 + the local housekeeping commit) |
| `master` | `63f54ee5b1` = fork/upstream `0d1f50007f` (0.1.6-alpha.1) + that same housekeeping commit (`.gitignore`, `LOGGING.md`, `RUNBOOK.md`); pushed to the fork |
| working tree | 0.1.6-alpha.1; the pre-push `typecheck` gate rebuilt `lib/` from this source |
| running service | `dsh-web.service` still executes the **previously built** `apps/cli/lib/bin.js` (0.1.5-rc.2 image); a restart picks up the 0.1.6-alpha.1 build |

**Toolchain:** the pre-push hook (`lefthook` → `pnpm run typecheck`) needs Node ^22.19
(`/home/todoriri/.nvm/versions/node/v22.20.0/bin`) and pnpm 11.7.0. A plain shell has
`node v18.19.1` / `pnpm 10.11.0` and fails the hook in ~0.5 s.

**Large-jump caution:** `RUNBOOK.md` is correct that a big source move requires
`pnpm run clean` before `pnpm run build` (stale `lib/**` otherwise fails with `[MISSING_EXPORT]`).

**Doc drift found, both sides reported (`RUNBOOK.md` is operator-owned; not edited here):** the
runbook says the checkout is pinned to `dsh-v0.1.2-alpha.5` and Node v26.8.1, while the checkout
was at `0.1.5-rc.2` before this reconciliation and the live `dsh-web.service` `ExecStart` runs
`node v22.20.0` with `--trusted-host 192.168.1.52 --no-open` (flags the runbook's snippet omits).

## D1 / U6 — `delta.reasoning` fallback in the native adapter — RE-SCOPED, not started

**The plan's stated benefit is false for this environment**, so the change was not made:

- The eval's D1 row claims the change "stops the *local* provider path losing thinking deltas".
  The `local` / `local-direct` providers in `~/.dsh/settings.yaml` are `llm-pi-ai` providers with
  `api: openai-completions`; `packages/llm/llm-pi-ai/src/adapter.ts` streams through pi-ai
  (`Models.streamSimple`, `catalog.ts:312` maps `openai-completions`).
- pi-ai 0.85.1 already reads **all three** spellings:
  `packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:415`
  (`["reasoning_content", "reasoning", "reasoning_text"]`; also `:155`). repl's proxy emits
  `reasoning` (`src/router_v2/dialects.py:133`), which pi-ai parses.
- Live evidence that thinking is not lost: the current repl session log
  (`~/.dsh/sessions/--mnt-data1-Projects-repl--/session-d687a571-8066-4206-817a-2a81f3e61032/session.v3.jsonl.zstd`)
  contains 104 `"type":"reasoning"` and 31 `reasoning-chunks` records.
- The file D1 targets (`translate.ts`) belongs to the **native** adapter, which serves the
  provider `DeepSeek` against `https://api.deepseek.com` (`packages/llm/llm-deepseek/src/index.ts:129`,
  `config.ts:104`). Nothing in `~/.dsh` mounts it.

**Residual, deferred value:** if the `DeepSeek` provider were ever pointed at a
`reasoning`-spelling endpoint (like repl's proxy) via the endpoint override in
`packages/llm/llm-deepseek/src/config.ts:109`, thinking deltas would be dropped there. If that
configuration is ever used, the change belongs at
`packages/llm/llm-deepseek/src/protocols/chat-completions/translate.ts:157` (+ `types.ts`), and it
is a legitimate wire-boundary tolerance under `AGENTS.md` ("validate at … model/tool JSON … wire
boundaries"). Until then it is speculative feature work with no failing case.

## Remaining dsh units (none started)

Paths re-verified 2026-09-17 on `0d1f50007f` (0.1.6-alpha.1) — all present unless noted.

| # | Idea | Where | Effort |
|---|---|---|---|
| D2 | DeepSeek prompt-render + tokenizer reference package (port recipe encoding render; vendor `v4/v41` `tokenizer.json`) — dsh has no tokenizer source, only the "four bytes/token is a sizing heuristic" note (`packages/context/session-reference/src/index.ts:374`) | new package under `packages/llm/` | M |
| D3 | Preset identity: version + digest + lock on `AgentPresetRow` — still `id/trust/isDefault/name/description/broken` only (`packages/preset/agent-presets/src/types.ts:11-24`) | `packages/preset/agent-presets` | M |
| D4 | Content-addressed skill/component registry with collision + tamper detection | alongside `packages/skill/skill-filesystem` | M |
| D5 | Classified policy merge (`mandatory` / `forbidden_override`) | `packages/interaction` + `packages/settings` | M |
| D6 | `deepseek_harness` compiler target (emit a dsh profile directory) — HOP side, stub at `src/hop/compiler.py:350-351` | HOP repo + dsh profile-loader conventions | M–L |
| D7 | Harness capability probe + adapter contract (`--version` alone is insufficient); dsh headless exists (`packages/bundle/headless/src/startup.ts`) | dsh-side probe script / contract tests | M |
| D8 | Session trajectory integrity + event authority (per-source seq, dedup, rolling SHA-256, gap report) | `packages/session`, `packages/storage` | M |
| D9 | Trusted verifier plugin — "agent text never decides" | new plugin / bundle | L |
| D10 | Logprobs + distillation export in the session layer (today `grep -rl logprob packages --include=*.ts` hits only a test fixture; content kinds stay `text/reasoning/image/file/tool-call/tool-result`, `packages/session/session-format-v2-to-v3/src/payload.ts:123`) | `packages/llm/llm-deepseek` + `packages/session` | M |
| U7 | Preset/skill identity spike = D3 + D4 | as above | M |

**Do not port:** HOP's bwrap sandbox (dsh has `packages/sandbox`), its runner/CLI, or APM export.
Do **not** add OpenAI-Responses/Anthropic protocol adapters — pi-ai already implements both
(`dist/api/openai-responses.js`, `anthropic-messages.js`); add conformance tests only.

## Premise discipline (the lesson of D1)

Every backlog item carries a claimed benefit. D1's was reproduced from a document, not from the
running system, and it was wrong. Before implementing any item above: state the failing case,
reproduce it against the live configuration, and re-verify the referenced paths (the tree moved
666 commits since the evaluation; `translate.ts` relocated, most other paths did not).

## Governance

- One unit = one commit; run the narrowest evidence the surface needs (`pnpm run typecheck` is the
  pre-push hook; focused `pnpm exec vitest run packages/<group>/<package>/tests/<file>.spec.ts`
  for behavior; `pnpm run doc-sync` for documentation).
- Non-trivial changes need an Agent Note in the same change (`.agents/notes/README.md`).
- Commits go to the fork (`origin`); `upstream` stays fetch-only unless a PR is opened deliberately.
