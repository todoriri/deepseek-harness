# Agent Note: pi-ai 对会话标题关闭 thinking

Status: implemented

[English](2026-09-19-pi-ai-session-title-reasoning.md) | 中文

## Problem

`dsh-llm-deepseek` 把辅助用途 `GenerateOptions.purpose` 的取值 `session-title` 映射为关闭 thinking 的请求（[请求序列化器](../../../../packages/llm/llm-deepseek/src/serialize.ts)），因为[会话标题策略](../../../../packages/session/session-title-llm/README.zh.md)把标题限制在几十个输出 token 内，并拒绝不含文本的回复。`dsh-llm-pi-ai` 对每个请求都从 `GenerateOptions.reasoningEffort` 或路由配置的 `reasoning` 解析推理（reasoning），因此标题请求继承会思考的路由默认值；对 harness 流量自行开启 thinking 的网关也同样为标题开启。预算随后消耗在推理 token 上，分派不返回标题文本，标题策略保留由首条提示词开头若干词派生的回退标题。

## Decision

`dsh-llm-pi-ai` 把 `session-title` 请求解析为推理等级 `off`，其优先级高于 `GenerateOptions.reasoningEffort` 与路由的 `reasoning` 默认值。`off` 有意绕过适配器自身的等级校验：某路由可能未声明 `off` 等级，而其模型仍接受省略推理选项，省略该选项正是分派发送的内容。

协议形态跟随路由的 `compat.thinkingFormat`：DeepSeek 格式为 `thinking: { type: 'disabled' }`，推理模型上的 Qwen 与 Qwen chat-template 格式为 `enable_thinking: false`，OpenAI 格式端点不带推理参数。`GenerateOptions`、配置 schema、提供方无关 API 与会话记录格式均不变。[孪生适配器规则](../architecture/2026-06-13-twin-llm-adapters.zh.md)正是该用途契约属于适配器而非网关的原因。

## Alternatives considered

**修复反向代理。** 否决：用途从不进入协议，代理只能靠启发式识别标题请求；而把调用方显式的 `thinking: false` 读作"未设置"的代理守卫会把它覆盖为 true。

**把标题路由交由纯部署配置。** 否决：它只修复一个部署，任何默认思考的路由仍然失效，而且让两个孪生适配器继续分歧。

**由标题策略传入 `reasoningEffort: 'off'`。** 否决：策略本就不传任何 effort，而按 `reasoningEffort ?? profile.reasoning` 取默认值的适配器仍会继承路由默认值；这还会让每个调用方承担适配器语义。

## Consequences

声明 thinking 默认值的路由对 agent 流量保留该默认值，而标题生成在无推理下运行；与该用途并列传入显式 effort 的调用方会被覆盖，与 `dsh-llm-deepseek` 一致。思考优先端点上的标题可在策略的 token 预算内生成，而不再被拒绝为回退标题。已记录的快照语料不变：随包 profile 会话记录的是由 `dsh-llm-deepseek` 服务的 `deepseek-official` 路由，没有任何快照挂载 `dsh-llm-pi-ai`。[`adapter.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/adapter.spec.ts) 的 keyless 覆盖固定标题请求在 DeepSeek 格式与 Qwen chat-template 格式下的协议形态，以及该用途旁显式 effort 被覆盖的情形。
