# Agent Note: pi-ai keeps thinking disabled for session titles

Status: implemented

English | [中文](2026-09-19-pi-ai-session-title-reasoning.zh.md)

## Problem

`dsh-llm-deepseek` maps the auxiliary `GenerateOptions.purpose` value `session-title` to a thinking-disabled request ([request serializer](../../../../packages/llm/llm-deepseek/src/serialize.ts)), because the [session-title policy](../../../../packages/session/session-title-llm/README.md) caps a title at a few dozen output tokens and rejects a reply that carries no text. `dsh-llm-pi-ai` resolved reasoning for every request from `GenerateOptions.reasoningEffort` or the route's configured `reasoning`, so a title request inherited a thinking route default, and a gateway that enables thinking for harness traffic on its own enabled it for titles too. The budget then went to reasoning tokens, dispatch returned no title text, and the title policy kept the fallback title derived from the first words of the first prompt.

## Decision

`dsh-llm-pi-ai` resolves a `session-title` request to reasoning level `off`, outranking both `GenerateOptions.reasoningEffort` and the route's `reasoning` default. `off` bypasses the adapter's level validation deliberately: a route may declare no `off` level while its model still accepts an omitted reasoning option, and omitting the option is exactly what dispatch sends.

The wire form follows the route's `compat.thinkingFormat`: `thinking: { type: 'disabled' }` for the DeepSeek format, `enable_thinking: false` for the Qwen and Qwen chat-template formats on a reasoning model, and no reasoning parameter for OpenAI-format endpoints. `GenerateOptions`, the configuration schema, the provider-neutral API, and the recorded Session format are unchanged. The [twin-adapter rule](../architecture/2026-06-13-twin-llm-adapters.md) is why this purpose contract belongs to the adapter rather than to a gateway.

## Alternatives considered

**Repair the reverse proxy.** Rejected: the purpose never reaches the wire, so a proxy can identify a title request only by heuristic, and a proxy guard that reads a caller's explicit `thinking: false` as "unset" overwrites it with true.

**Make the title route pure deployment configuration.** Rejected: it repairs one deployment while every route whose default thinks stays broken, and it leaves the twin adapters divergent.

**Pass `reasoningEffort: 'off'` from the title policy.** Rejected: the policy already omits any effort, and an adapter that defaults `reasoningEffort ?? profile.reasoning` still inherits the route default; it would also make every caller responsible for adapter semantics.

## Consequences

A route that declares a thinking default keeps it for agent traffic while title generation runs without reasoning, and a caller that passes an explicit effort beside `purpose: 'session-title'` is overridden, matching `dsh-llm-deepseek`. Titles on a thinking-first endpoint are produced within the policy's token budget instead of being rejected into the fallback. The recorded snapshot corpus is unchanged: shipped-profile sessions record the `deepseek-official` route served by `dsh-llm-deepseek`, and no snapshot mounts `dsh-llm-pi-ai`. Keyless coverage in [`adapter.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/adapter.spec.ts) pins the DeepSeek-format and Qwen-chat-template wire forms for a title request, and the override of an explicit effort beside that purpose.
