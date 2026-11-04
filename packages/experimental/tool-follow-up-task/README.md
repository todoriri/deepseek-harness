---
description: "Model tools that suggest follow-up tasks the user can start later as a new Session."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-tool-follow-up-task

English | [中文](README.zh.md)

## Summary

Give the model two tools for work it notices outside the current request: `suggest_follow_up_task` records a title, summary, and standalone prompt as a card the user may start later, and `dismiss_follow_up_task` withdraws a suggestion that is no longer needed. Nothing runs until the user starts the task, and a successful call adds no model request. The bundle mounts the Host tools and the Web cards together; a composition that omits it gets neither.

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

A Web composition selects this bundle as a patch layer. Its [`cordis.patch.yml`](cordis.patch.yml) inserts one row for these Host tools and one for the [Web cards](../client-ui-follow-up-task/README.md), so a composition gets both or neither. No shipped profile mounts it, and Headless, ACP, and SDK compositions leave it out because nothing there renders the cards.

```yaml
- insert:
    - id: tool-follow-up-task
      name: '@deepseek-ai/dsh-experimental-tool-follow-up-task'
    - id: client-ui-follow-up-task
      name: '@deepseek-ai/dsh-experimental-client-ui-follow-up-task'
```

The dsh installation does not ship this package, so a profile cannot resolve the bundle by name, through `dsh.profile.bundles` or through these rows in its `cordis.patch.yml`, until the profile installs the package. From the root of a built checkout, install it into the Web profile:

```sh
dsh plugin --profile web add ./packages/experimental/tool-follow-up-task
```

The CLI records the directory as a `link:` dependency and appends the bundle to `dsh.profile.bundles` after the base and Web layers. The link uses the checkout's build and dependencies, so rebuild the checkout and restart dsh after code changes. The Web **Plugins** page's **Add plugin** accepts the same directory as an absolute path, and **Enable now** switches the bundle on. Remove it with `dsh plugin --profile web remove @deepseek-ai/dsh-experimental-tool-follow-up-task`.

To try the bundle from a source checkout without changing a profile, run `pnpm dsh --patch packages/experimental/tool-follow-up-task/cordis.patch.yml --profile web`. `--patch` is a launcher option and must precede `--profile`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `maxSuggestionsPerTurn` | natural number, at least 1 | `3` | Most `suggest_follow_up_task` calls one turn may make; a call past it fails. |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-tool-follow-up-task) owns the declaration and exact field description.

A successful `suggest_follow_up_task` call returns `taskId` (the call's own id) and a reserved `sessionId` in `session-<uuid>` form. The card starts the task in the source Session's Workspace under that id with `prompt` in the composer; the user reviews the prompt, picks model, effort, or preset, edits, and sends. `dismiss_follow_up_task` takes the `taskId` to withdraw a suggestion; a Session the user already started is not affected.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) registers both tools, their timing prompt section, and the `followUpTasks` Session projection in the mounting scope; [`src/projection.ts`](src/projection.ts) folds the projection, and [`src/contract.ts`](src/contract.ts) defines the presentation metadata that the Web client re-validates. [`cordis.patch.yml`](cordis.patch.yml) inserts the `tool-follow-up-task` row and the `client-ui-follow-up-task` row.

A successful call writes `output.presentationMeta`: suggested metadata carries `taskId`, the reserved `sessionId`, and the trimmed `title`, `summary`, and `prompt`; dismissal metadata carries `taskId`. The core persists it as `tool/result.meta` for a native call and `tool/ptc-dispatch.meta` for a PTC sub-call. Only successful calls write metadata, so refused calls never produce a card.

The projection holds `openTurnCalls` (call ids of suggest calls in the open turn, or null outside a turn) and `suggested` (task ids of successful suggestions, in log order). It starts from `{ openTurnCalls: null, suggested: [] }`, resets the open-turn list on `turn/start`, clears it on `turn/end`, appends suggest call ids from `tool/call` and `tool/ptc-dispatch-start`, and appends a validated `taskId` from `tool/result` or `tool/ptc-dispatch` metadata that carries five non-empty strings. Every other event returns the same state reference. The projection is host-only: it has no wire view, and the Web client builds cards from delivered events.

The cap reads the call's position from `openTurnCalls`: the call's index plus one, or the list length plus one when the id is absent, and refuses a position above `maxSuggestionsPerTurn`. Parallel calls in one step therefore have a deterministic order, and refused calls still occupy a slot. A call with no calling Agent, or with a delegated subagent as its Agent, is refused before the cap check.

Every successful suggestion mints `session-${randomUUID()}` as the reserved Session identity; the value is returned to the model and stored in metadata. Disposing the plugin removes the tool registrations, the prompt section, and the projection registration.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Inserts the Host tools row and the Web cards row |
| [`src/index.ts`](src/index.ts) | Registers the tools, prompt section, refusals, cap, and projection |
| [`src/projection.ts`](src/projection.ts) | The host-only `followUpTasks` fold |
| [`src/contract.ts`](src/contract.ts) | Presentation metadata types shared with the Web client |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web cards](../client-ui-follow-up-task/README.md) — card states, Start and Dismiss actions, and transcript rows.
- [Workspace UI](../../client/ui-workspace/README.md) — `startSession` accepts the reserved `sessionId`.
- [Session projections](../../../docs/subsystems/session-projection.md) — the host fold that supplies the cap and dismiss checks.
- [Tool catalog](../../../docs/tool-catalog.md) — generated schemas and model-facing descriptions for shipped tools.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

### Timing section

#### What the model sees

While `suggest_follow_up_task` is visible in the assembling scope, the system prompt carries one sentence at the `TOOL_FOLLOW_UP_TASK` order. The sentence states when to call the tool; the tool description states what qualifies and what does not. A scope that hides the tool, such as a preset that denies it, renders no section.

##### Timing guidance

```markdown
Before your final response, if you noticed worthwhile work outside this request, offer it with suggest_follow_up_task instead of only listing it in your reply.
```

#### Token effect

One fixed sentence is present on each request while the tool is visible. With the bundle patched into the headless profile, a fixed first turn measured 6,001 prompt tokens before the section and 6,028 after it on a local llama.cpp tokenizer; the figure includes the four words the change removed from the suggest description.

#### KV Cache effect

Prefix-stable while the plugin is mounted and the tool's visibility is unchanged. Mounting, unmounting, or hiding the tool changes the rendered system prompt once, as every prompt-section change does.

### Suggest tool

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-follow-up-task) owns the exact description, parameter text, result text, and refusal text. The model receives `suggest_follow_up_task` with `title`, `summary`, and `prompt` parameters. The description tells it to use the tool for worthwhile work outside the current request — a bug found in passing, missing test coverage, stale documentation, or a confirmed TODO — and not for work the current request needs, fixes it can finish now, or speculative ideas. It also says nothing runs unless the user starts the task, the user sees `title` and `summary` and reviews `prompt`, and `prompt` must stand alone because the new Session cannot see this conversation. A successful result states that the task is shown to the user, starts only by choice, and the model should continue the current request. Refusals state an empty field, the per-turn cap, a missing calling Agent, or a subagent caller.

#### Token effect

The tool's schema has a fixed per-request cost while mounted. Each call appends its three arguments and one bounded result or refusal to ordinary tool history, and the per-turn cap bounds how many suggestions — including refused calls — occupy one turn.

#### KV Cache effect

Unchanged tool schemas retain their existing prefix. Calls append after prior history; a successful call writes result metadata for the card but does not rewrite earlier request tokens.

### Withdraw tool

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-follow-up-task) owns the exact description, parameter text, result text, and refusal text. The model receives `dismiss_follow_up_task` with one `taskId` parameter. The description tells it to withdraw a suggestion it made earlier in this Session when it is no longer needed, for example because the work was done here or a better suggestion replaced it, and that a Session the user already started is not affected. A successful result states that the task is withdrawn; refusals state a missing calling Agent, a subagent caller, or a `taskId` this Session never suggested.

#### Token effect

The schema has a fixed per-request cost while mounted. Each call appends one `taskId` argument and one bounded result or refusal to ordinary tool history.

#### KV Cache effect

Unchanged tool schemas retain their existing prefix. Calls append after prior history; dismissal metadata does not rewrite earlier request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Fork inheritance** — a fork inherits its source's cards with the same reserved Session ids, so starting from either Session marks both started.
- **Browser-local user dismissal** — a user's Dismiss is stored in that browser only; another browser still shows the card. The agent withdraws it for every client with `dismiss_follow_up_task`.
- **PTC dismissal race** — inside one `run_code` program, a dismiss that immediately follows its suggest can be refused as unknown because PTC appends `tool/ptc-dispatch` only after the sub-call resolves; a dismiss in a later step succeeds.
- **Same Workspace and checkout** — worktree isolation is deferred: the task starts in the source Session's Workspace and reuses its checkout, and the user cannot choose a directory.
- **Top-level agents only** — a delegated subagent cannot suggest or withdraw a task; it must report the follow-up to its parent Agent.
- **Not shipped with dsh** — the bundle is not an official optional bundle, so the installation does not carry it and the Plugin Manager offers no switch for it until a profile installs the package. The installation may depend on an experimental package only when `OPTIONAL_BUNDLES` names it ([rationale](../../../.agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.md)), and admission requires an approved official icon.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
