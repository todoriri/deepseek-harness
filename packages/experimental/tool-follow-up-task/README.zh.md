---
description: "建议后续任务、供用户稍后作为新 Session 启动的模型工具。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-tool-follow-up-task

[English](README.md) | 中文

## 概述

为模型提供两个工具，处理它在当前请求之外注意到的工作：`suggest_follow_up_task` 记录标题、摘要和可独立使用的提示词，作为用户稍后可启动的卡片；`dismiss_follow_up_task` 撤回不再需要的建议。在用户启动任务之前不会执行任何内容，成功调用也不会新增模型请求。此 bundle 将 Host 工具与 Web 卡片一起挂载；不选中它的组合两者都不会获得。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web 组合以 patch 层的形式选择此 bundle。它的 [`cordis.patch.yml`](cordis.patch.yml) 插入一行 Host 工具和一行 [Web 卡片](../client-ui-follow-up-task/README.zh.md)，因此组合要么同时获得两者，要么都不获得。没有随附 profile 挂载它；Headless、ACP 与 SDK 组合不包含它，因为那里没有渲染卡片的界面。

```yaml
- insert:
    - id: tool-follow-up-task
      name: '@deepseek-ai/dsh-experimental-tool-follow-up-task'
    - id: client-ui-follow-up-task
      name: '@deepseek-ai/dsh-experimental-client-ui-follow-up-task'
```

在源码检出中，运行以下命令以带此 bundle 的 Web profile 启动：`pnpm dsh --patch packages/experimental/tool-follow-up-task/cordis.patch.yml --profile web`。`--patch` 是启动器选项，必须位于 `--profile` 之前。

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `maxSuggestionsPerTurn` | 自然数，至少 1 | `3` | 一个回合最多可进行的 `suggest_follow_up_task` 调用数；超过此数的调用失败。 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-tool-follow-up-task)拥有声明与准确的字段说明。

成功的 `suggest_follow_up_task` 调用返回 `taskId`（调用自身的 id）和保留的 `sessionId`（形式为 `session-<uuid>`）。卡片会在源 Session 所属的 Workspace 中以该 id 启动任务，并将 `prompt` 放入编辑器；用户检查提示词、选择模型、effort 或 preset、编辑并发送。`dismiss_follow_up_task` 接受 `taskId` 以撤回建议；用户已经启动的 Session 不受影响。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

[`src/index.ts`](src/index.ts) 在挂载作用域中注册两个工具与 `followUpTasks` Session projection；[`src/projection.ts`](src/projection.ts) 折叠该 projection，[`src/contract.ts`](src/contract.ts) 定义 Web 客户端会重新校验的展示 metadata。[`cordis.patch.yml`](cordis.patch.yml) 插入 `tool-follow-up-task` 行与 `client-ui-follow-up-task` 行。

成功调用写入 `output.presentationMeta`：建议 metadata 携带 `taskId`、保留的 `sessionId`，以及去掉首尾空白的 `title`、`summary` 与 `prompt`；撤回 metadata 携带 `taskId`。core 将其持久化为原生调用的 `tool/result.meta` 或 PTC 子调用的 `tool/ptc-dispatch.meta`。只有成功调用写入 metadata，因此被拒绝的调用永远不会产生卡片。

projection 保存 `openTurnCalls`（当前打开回合内 suggest 调用的 call id，回合外为 null）与 `suggested`（本 Session 中成功建议的 task id，按日志顺序）。初始值为 `{ openTurnCalls: null, suggested: [] }`：`turn/start` 重置打开回合列表，`turn/end` 清空它，`tool/call` 与 `tool/ptc-dispatch-start` 追加 suggest 的 call id，`tool/result` 或 `tool/ptc-dispatch` 中通过校验、携带五个非空字符串的 metadata 追加 `taskId`。其他事件返回同一个状态引用。该 projection 仅限 Host：没有 wire view，Web 客户端从交付的事件构建卡片。

上限从 `openTurnCalls` 读取调用位置：调用索引加一，id 不存在时为列表长度加一；位置超过 `maxSuggestionsPerTurn` 时拒绝。因此同一步骤中的并行调用具有确定的顺序，被拒绝的调用仍占用一个位置。没有调用 Agent、或 Agent 是委派 subagent 的调用会在上限检查之前被拒绝。

每次成功建议都会生成 `session-${randomUUID()}` 作为保留的 Session 身份；该值返回给模型并存入 metadata。销毁插件会移除工具注册与 projection 注册。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 插入 Host 工具行与 Web 卡片行 |
| [`src/index.ts`](src/index.ts) | 注册工具、拒绝、上限与 projection |
| [`src/projection.ts`](src/projection.ts) | 仅限 Host 的 `followUpTasks` 折叠 |
| [`src/contract.ts`](src/contract.ts) | 与 Web 客户端共享的展示 metadata 类型 |

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [Web 卡片](../client-ui-follow-up-task/README.zh.md)——卡片状态、Start 与 Dismiss 操作，以及 transcript 行。
- [Workspace UI](../../client/ui-workspace/README.zh.md)——`startSession` 接受保留的 `sessionId`。
- [Session projection](../../../docs/subsystems/session-projection.zh.md)——提供上限与撤回检查的 Host 折叠。
- [工具目录](../../../docs/tool-catalog.zh.md)——已发布工具的生成 schema 与面向模型的说明。
- [实验性包](../README.zh.md)——孵化状态与发布策略。

-----

<a id="model-experience"></a>
## 模型体验

### 建议工具

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-follow-up-task)拥有准确的说明、参数文本、结果文本与拒绝文本。模型收到带有 `title`、`summary` 与 `prompt` 参数的 `suggest_follow_up_task`。说明告诉它将此工具用于当前请求之外值得做的工作——例如顺带发现的 bug、缺失的测试覆盖、过时的文档或已确认的 TODO——而不要用于当前请求需要的工作、现在就能完成的小修复或推测性想法。它还说明除非用户启动任务，否则不会执行任何内容；用户会看到 `title` 与 `summary` 并检查 `prompt`；`prompt` 必须能够独立使用，因为新 Session 看不到这段会话。成功结果说明任务已展示给用户、只有用户选择才会启动，并让模型继续当前请求。拒绝信息会说明空字段、每回合上限、缺少调用 Agent 或 subagent 调用者。

#### Token 影响

挂载期间，工具 schema 为每次请求带来固定成本。每次调用将三个参数与一条有界结果或拒绝信息追加到普通工具历史，每回合上限限制了包括被拒绝调用在内的建议数量。

#### KV Cache 影响

未改变的工具 schema 保留既有前缀。调用追加到先前历史之后；成功调用为卡片写入结果 metadata，但不会改写更早的请求 token。

### 撤回工具

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-follow-up-task)拥有准确的说明、参数文本、结果文本与拒绝文本。模型收到只带一个 `taskId` 参数的 `dismiss_follow_up_task`。说明告诉它在本 Session 中撤回此前提出、已不再需要的建议，例如工作已在此处完成或更好的建议取代了它，并说明用户已经启动的 Session 不受影响。成功结果说明任务已撤回；拒绝信息会说明缺少调用 Agent、subagent 调用者，或本 Session 从未建议过的 `taskId`。

#### Token 影响

挂载期间，schema 为每次请求带来固定成本。每次调用将一个 `taskId` 参数与一条有界结果或拒绝信息追加到普通工具历史。

#### KV Cache 影响

未改变的工具 schema 保留既有前缀。调用追加到先前历史之后；撤回 metadata 不会改写更早的请求 token。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **fork 继承**——fork 以相同的保留 Session id 继承源会话的卡片，因此从任一 Session 启动都会把两者标记为已启动。
- **用户忽略仅限浏览器本地**——用户的 Dismiss 只存储在该浏览器中；另一个浏览器仍会显示卡片。智能体可通过 `dismiss_follow_up_task` 为所有客户端撤回它。
- **PTC 撤回竞态**——在同一个 `run_code` 程序中，紧跟在 suggest 之后的 dismiss 可能因未知而被拒绝，因为 PTC 只有在子调用完成后才追加 `tool/ptc-dispatch`；在后续步骤中撤回会成功。
- **相同 Workspace 与检出目录**——工作树隔离已延期：任务在源 Session 的 Workspace 中启动并复用其检出目录，用户无法选择目录。
- **仅限顶层 Agent**——委派的 subagent 不能建议或撤回任务；它必须向父 Agent 报告该后续工作。
- **没有 Plugin Manager 开关**——该 bundle 不是官方可选 bundle，Plugin Manager 不为它提供开关；profile 只能通过显式 patch 层加载它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
