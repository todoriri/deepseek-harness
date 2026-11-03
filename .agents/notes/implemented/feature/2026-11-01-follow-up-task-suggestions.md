# Agent Note: Follow-up task suggestions

Status: implemented

English | [中文](2026-11-01-follow-up-task-suggestions.zh.md)

## Problem

An agent working on one request often notices work outside it: a bug found in passing, missing test coverage, stale documentation, or a confirmed TODO. The available answers are to mention it in prose, which scrolls away and carries no startable instructions, or to do the work now, which widens the change and delays the request. Neither path records the observation with the context needed to act on it later.

A follow-up task needs the context the agent already has: the goal, the file paths, what it observed, and how to verify the result. The Session that starts it cannot see the conversation that produced it, so anything it receives has to stand alone. The user also needs a visible place where the suggestion waits, with its content available for review, until they choose to start it; nothing runs before that choice.

## Decision

The agent calls `suggest_follow_up_task` with `title`, `summary`, and `prompt` during a turn. The call reserves a Session id of the form `session-<uuid>` and returns `{ taskId, sessionId }`, where `taskId` is the call's own id. Under that turn the Web conversation shows a card with the title, the summary, a **Show prompt** disclosure, and **Start** and **Dismiss**. The card is rebuilt from the logged tool result, so it survives reload and replay.

**Start** opens a new Session under the reserved id, in the Workspace that holds the source Session, and places `prompt` in the composer unsent. The user picks model, effort, or preset, edits the text, and sends; the package never submits it. While that Session has no submitted input, the card shows **Open draft**, which repeats the Start path and preserves any text already in the draft; once it has started, or the reserved id is archived, the card shows **Open session**, which opens that Session directly. The Host adopts the reserved identity when no Session is stored under it, reuses it while it is blank and a member of the Workspace, refuses an identity stored under another directory or owned by subagent routing, and otherwise creates another Session.

The agent withdraws a suggestion with `dismiss_follow_up_task({ taskId })`, and the card shows "Withdrawn by the agent" with no actions. A Session the user already started is not affected, because the started and drafted states take precedence. The user's own **Dismiss** records the reserved Session id in this browser and shows **Restore**; a withdrawal arrives through the Session log for every client and takes precedence over a local dismissal.

### Components

| Package | Face | Role |
|---|---|---|
| [`@deepseek-ai/dsh-experimental-tool-follow-up-task`](../../../../packages/experimental/tool-follow-up-task/README.md) | Host | Both tools, the per-turn cap, the `followUpTasks` Session projection, and the metadata types |
| [`@deepseek-ai/dsh-experimental-client-ui-follow-up-task`](../../../../packages/experimental/client-ui-follow-up-task/README.md) | Web | The Conversation definition, turn-tail cards, transcript rows, browser-local dismissal store, and locale |
| [`@deepseek-ai/dsh-client-ui-workspace`](../../../../packages/client/ui-workspace/README.md) (existing) | Web | The optional `StartSessionOptions.sessionId` |

The tool package's [`cordis.patch.yml`](../../../../packages/experimental/tool-follow-up-task/cordis.patch.yml) inserts one row per package, so a composition gets the tools and the cards together or neither. The bundle is experimental and no shipped profile mounts it; Headless, ACP, and SDK compositions omit it because nothing there renders cards. The Web package also registers one transcript row per tool in the keyed `tool.call.toolview` slot, so both calls read as named rows instead of the generic fallback.

### Data contract

`src/contract.ts` in the tool package is the single definition of the two records. A successful suggestion writes `output.presentationMeta` with `taskId`, the reserved `sessionId`, and the trimmed `title`, `summary`, and `prompt`; a successful withdrawal writes the dismissed record with `taskId`. The core persists it as `tool/result.meta` for a native call and `tool/ptc-dispatch.meta` for a PTC sub-call. Only successful calls write metadata, so a refused call produces no card.

The Web package imports only types from that module and treats the metadata as untrusted durable data: it validates every field and brands `ToolCallId` and `SessionId` itself. The record therefore needs no wire namespace and no runtime module request from the browser bundle, and a malformed record yields no card rather than a broken one.

### Card states

A card derives one state from four inputs: a later withdrawal record for the same `taskId`, this browser's dismissal record, the Session list row under the reserved id, and the Workspace's archived ids. The first matching row wins:

| State | Condition | Card |
|---|---|---|
| `started` | a Session row exists and is not blank, or the reserved id is archived | **Open session** |
| `drafted` | a Session row exists and is blank | **Open draft** |
| `withdrawn` | the agent withdrew the suggestion | the title and "Withdrawn by the agent"; no actions |
| `dismissed` | this browser dismissed the suggestion | the title and "Dismissed"; **Restore** |
| `available` | otherwise | the title, the summary, **Show prompt**, **Start**, and **Dismiss** |

The state is a pure function of those inputs, so a reload, a replay, or a change in the Session list produces the same card from the same facts.

### Host state and the per-turn cap

The tools read a host-only Session projection, `followUpTasks`, instead of scanning history: it holds the suggest call ids in the open turn and the task ids of every successful suggestion in the Session. It resets the open-turn list on `turn/start`, clears it on `turn/end`, appends suggest call ids from `tool/call` and `tool/ptc-dispatch-start`, and appends a validated `taskId` from `tool/result` and `tool/ptc-dispatch` metadata that carries five non-empty strings. The projection has no wire view; the Web cards read the delivered events.

`maxSuggestionsPerTurn` (a natural number of at least 1, default 3) bounds one turn's suggestions. A call's position is its index in the open-turn list plus one, or the list length plus one when the id is absent, and a position above the maximum is refused. Parallel calls in one step therefore get a deterministic order, and refused calls still occupy a slot. Both tools refuse a call with no calling agent and a call from a delegated subagent; the suggest tool also refuses an empty field, and the dismiss tool refuses a `taskId` that this Session never suggested. Every refusal is an ordinary tool error, and no refusal writes metadata.

## Alternatives considered

**A turn-end side call.** An `agent/turn-stopping` model call would suggest work after every turn without the model choosing a tool. The hook is serial and awaited before every turn closes, so it delays every turn and adds a model request per turn, and its suggestions live in process memory, outside the log, so replay could not reproduce the cards.

**A dedicated Session event.** A `follow-up-task/*` Session event would need a session-format review, a `SessionEventMap` member, and SDK expected-output updates. The tool result already carries every field the card shows, and replay rebuilds the card from it, so a new event type would record no fact that the log does not already hold.

**Host storage.** A Host storage domain, as Schedule uses for tasks, would hold suggestions durably. It adds a service, index, and lifecycle for data the tool result already holds; the reserved Session id supplies the started state that storage would otherwise exist to track.

**Auto-send.** Creating the Session and submitting `prompt` would spare the user a step. It would also start a request before the user reviews the prompt and picks model, effort, or preset, which are the choices a new Session needs before its first request.

**Fork at the turn.** A fork would hand the new Session the conversation. It re-prefills the whole parent prefix on a local vLLM, which takes minutes at about 200K tokens. A fresh Session with a standalone prompt starts from the context the prompt states.

**Synchronous log scans.** Reading the Session log directly for the cap and the dismiss check would remove the projection. Synchronous history reads are [deprecated and prohibited in new production code](../architecture/2026-09-09-deprecate-synchronous-session-event-reads.md); a projection is restored on resume and kept current from new events, so neither check reads history.

**A Host-stored dismissal.** Dismissal could live on the Host so that every browser agrees. A Host endpoint adds a service and a wire surface for a display preference that affects one browser, so dismissal stays browser-local until cross-browser sync is needed.

## Consequences

A suggestion costs one ordinary tool call: a turn that suggests adds no model request and no turn-close delay. The card is rebuilt from the Session log, so reload and replay reproduce it; the started state lives in the Session list under the reserved id, so every client agrees without new storage. The feature adds no Session event type, so no session-format migration, SDK expected output, or upgrade guide is needed.

The feature ships as two experimental packages mounted by one optional Web bundle. No shipped profile includes it, and Headless, ACP, and SDK compositions leave it out because they render no cards. The Web package registers no prompt section, tool schema, or Session event, so it changes nothing a model sees.

Known limitations:

- A fork inherits its source's cards with the same reserved ids, so starting from either Session marks both started.
- A user's dismissal does not sync across browsers; another browser still shows the card until the agent withdraws it.
- Inside one `run_code` program, a dismiss that immediately follows its suggest can be refused as unknown, because PTC appends `tool/ptc-dispatch` only after the sub-call resolves; a dismiss in a later step succeeds.
- Worktree isolation is deferred: the task starts in the source Session's Workspace and reuses its checkout, and the card offers no directory choice.
- The card renders `title` and `summary` as plain text; a model that wraps an identifier in backticks makes them visible in the card.

## Related

- [Client-derived tool presentation](../architecture/2026-08-23-client-derived-tool-presentation.md) retains `output.presentationMeta` and durable `tool/result.data.meta` as the channel for execution-result facts, which these cards consume.
- [Client Conversation business-node assembly](../architecture/2026-08-09-client-conversation-node-assembly.md) owns the Conversation definition mechanism this card uses.
- [Chat group tree exchanges](../architecture/2026-10-11-chat-group-tree-exchanges.md) places built-in nodes, including `turn-tail`, where these cards register.
- [Initial draft content and structured reference restoration](../architecture/2026-09-30-structured-draft-initialization.md) owns the `startSession` prompt options that fill the new Session's composer.
- [Writer acquisition for blank Session reuse](../architecture/2026-09-17-process-local-blank-sessions.md) owns the named blank Session reuse behind **Open draft**.
