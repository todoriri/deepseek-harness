---
description: "Web cards and transcript rows for follow-up task suggestions that the user can start later as a new Session."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-follow-up-task

English | [中文](README.zh.md)

## Summary

Show each logged follow-up task suggestion as a card under its turn: the title, summary, a prompt disclosure, and Start, Open, Dismiss, or Restore according to its state. The package also registers transcript rows for `suggest_follow_up_task` and `dismiss_follow_up_task`. Starting opens the reserved Session in the source Session's Workspace with the prompt in an unsent draft; sending stays the user's decision. Dismissal is stored in this browser only. The package registers no model-facing input.

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

Enable this package through the follow-up task bundle: the Host [tool package](../tool-follow-up-task/README.md) and this Web plugin are mounted together by the bundle's patch, so enabling the bundle supplies both the tools and the cards. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields.

### Card states

The cards render under the turn that holds the suggestion, in suggestion order. Each card derives one state from four inputs — a later withdrawal record, this browser's dismissal record, the Session row under the reserved id, and the Workspace's archived ids — and the first matching row wins:

| State | Condition | Card |
|---|---|---|
| `started` | A Session row exists under the reserved id and is not blank, or the id is archived | **Open session** |
| `drafted` | A Session row exists under the reserved id and is blank | **Open draft** |
| `withdrawn` | The agent withdrew the suggestion with a later `dismiss_follow_up_task` call | The label, the title, and "Withdrawn by the agent"; no actions |
| `dismissed` | This browser dismissed the suggestion | The label, the title, and "Dismissed"; **Restore** |
| `available` | Otherwise | The label, title, summary, **Show prompt**, **Start**, and **Dismiss** |

### Start and open

**Start** finds the Workspace whose `sessionIds` contain the source Session, then calls `ctx.uiWorkspace.startSession(workspaceId, { sessionId: task.sessionId, prompt: task.prompt, whenDraftExists: 'keep' })`. When no Workspace holds the source Session, `startSession` falls back to its current or most recent Workspace. The prompt arrives in the composer unsent, so the user picks model, effort, or preset, edits, and sends; the package never submits it. A Session row under the reserved id turns the card into **Open session**, which opens that Session directly. **Open draft** repeats the Start path for a blank Session row; the Host reuses the blank and `whenDraftExists: 'keep'` preserves any text already in its draft.

The `sessionId` option belongs to the [Workspace UI](../../client/ui-workspace/README.md), which documents when the Host adopts a named identity, when it reuses a blank Session under it, and when it refuses the request. This package only supplies the reserved id.

### Dismiss and restore

**Dismiss** records the reserved Session id in this browser's persisted `dsh.follow-up-task.dismissed.v1` store, newest first and bounded to 200 ids; **Restore** removes it. A stored value that is not an array becomes no dismissals on load, and non-string entries are dropped. A dismissal changes only browser storage, so it never edits the Session log or affects another browser. The agent's withdrawal record arrives through the Session log for every client and takes precedence over a local dismissal; the card then shows the withdrawn state without actions.

### Transcript rows

The package registers one row per tool name in the keyed `tool.call.toolview` slot, so PTC sub-calls inside `run_code` get the same rows. The suggest row uses the new-session glyph and the title **Suggest follow-up task**; while the call is preparing or running and after it succeeds, its summary is the first line of the trimmed `title` argument, and it has no summary when that argument is absent or not a string. The dismiss row uses the same glyph, the title **Withdraw follow-up task**, and no summary. Both rows show the shared status words for preparing, running, failed, and stopped, put the first line of a refusal or error in the error color, expand to the full result text, and add an **Inspect call** control when the owner supplies one. An Auto review denial renders through the generic row before keyed dispatch.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export registers the `followUpTask` locale dictionaries, one Conversation definition for the `follow-up-task` node kind, the turn-tail cards through the `conversation.chat.turnTail` slot, and both transcript rows through the keyed `tool.call.toolview` slot. Every registration runs through a Cordis effect or slot injection, so disposing the plugin fiber removes them. The cards' face reads each turn's tasks from the Chat target's `turnDataSource(turn, 'follow-up-task')` and receives the Session list, Workspace list, dismissal store, and Start, open, dismiss, and restore callbacks from the slot injection.

The definition folds a suggestion's metadata into a hidden turn-tail node and sets `withdrawn` to true when a later dismissal record carries the same `taskId`. The card state is a pure function of the four inputs above; the Start path looks up the source Session's Workspace and calls `ctx.uiWorkspace.startSession`. The metadata from `tool/result` or `tool/ptc-dispatch` is untrusted durable data: the client validates five non-empty strings for a suggestion (one for a dismissal) and brands `ToolCallId` and `SessionId` itself; it imports only types from the Host package. The dismissal store wraps `createSnapshotStore` with persistence and validates the restored value once, right after creation, writing a repaired value back when the stored value is not a clean string array.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Locale, definition, card, and transcript-row registrations; card face callbacks |
| [`src/client/definition.ts`](src/client/definition.ts) | Hidden turn-tail Conversation node and withdrawal fold |
| [`src/client/card-state.ts`](src/client/card-state.ts) | Pure card-state derivation |
| [`src/client/FollowUpTaskCards.tsx`](src/client/FollowUpTaskCards.tsx) | Card rendering and Start, open, dismiss, and restore actions |
| [`src/client/FollowUpTaskRows.tsx`](src/client/FollowUpTaskRows.tsx) | Transcript rows for both tools |
| [`src/client/dismissals.ts`](src/client/dismissals.ts) | Persisted browser-local dismissal store |
| [`src/client/task.ts`](src/client/task.ts) | Metadata validation and branding |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese copy |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Host tools](../tool-follow-up-task/README.md) — the tools, presentation metadata, projection, and per-turn cap.
- [Workspace UI](../../client/ui-workspace/README.md) — the `sessionId` option and draft retention rules.
- [Tool UI](../../client/ui-tool/README.md) — the keyed `tool.call.toolview` slot and generic row fallback.
- [Conversation UI](../../client/ui-conversation/README.md) — turn-tail slots and Conversation node definitions.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

### Cards and transcript rows

#### What the model sees

Nothing. The package renders the logged `tool/result` and `tool/ptc-dispatch` records of `suggest_follow_up_task` and `dismiss_follow_up_task` as cards and transcript rows; it registers no prompt section, tool schema, Session event, or wire namespace, and its browser-local dismissals never enter a model request.

#### Token effect

Zero. Cards, rows, and dismissals add no model tokens; the Host [tool package](../tool-follow-up-task/README.md) owns every model-visible schema, description, result, and refusal.

#### KV Cache effect

Independent. The package never edits request tokens, so an already-reusable request prefix stays reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Fork inheritance** — a fork inherits its source's cards with the same reserved Session ids; the card state follows the reserved id, so starting from either Session marks both started.
- **Browser-local dismissal** — Dismiss and Restore affect this browser only; another browser still shows the card, and no cross-browser dismissal sync exists.
- **Plain-text summary** — the card shows `title` and `summary` as plain text. The summary description asks for no Markdown, but a model that wraps an identifier in backticks makes them visible in the card.
- **Same Workspace and checkout** — worktree isolation is deferred: Start uses the source Session's Workspace and checkout, and the card offers no directory choice.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
