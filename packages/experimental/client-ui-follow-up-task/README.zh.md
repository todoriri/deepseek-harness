---
description: "用于展示后续任务建议的 Web 卡片与工具行，用户可稍后将其作为新 Session 启动。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-follow-up-task

[English](README.md) | 中文

## 概述

在每条后续任务建议所属回合下方展示卡片：标题、摘要、提示词展开控件，以及随状态变化的 Start、Open、Dismiss 或 Restore。本包还为 `suggest_follow_up_task` 与 `dismiss_follow_up_task` 注册工具行。Start 会在源 Session 所属的 Workspace 中打开保留的 Session，并将提示词放入未发送的草稿；是否发送由用户决定。忽略只存储在本浏览器中。本包不注册任何面向模型的输入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过后续任务 bundle 启用本包：bundle 的 patch 将 Host [工具包](../tool-follow-up-task/README.zh.md) 与本 Web 插件一起挂载，因此启用 bundle 会同时提供工具和卡片。dsh 安装不随附这两个包；工具包的 README 说明如何[将该 bundle 安装到 profile](../tool-follow-up-task/README.zh.md#use-this-package)。Web Client loader 挂载 `/client` export；root Host export 不执行行为，本包也没有用户配置字段。

### 卡片状态

卡片按建议顺序渲染在持有该建议的回合下方。每张卡片从四个输入派生一个状态——后来的撤回记录、本浏览器的忽略记录、保留 id 下的 Session 行以及 Workspace 的归档 id——第一个匹配项生效：

| 状态 | 条件 | 卡片 |
|---|---|---|
| `started` | 保留 id 下存在 Session 行且不为空白，或该 id 已归档 | **打开会话** |
| `drafted` | 保留 id 下存在 Session 行且为空白 | **打开草稿** |
| `withdrawn` | 智能体通过后续的 `dismiss_follow_up_task` 调用撤回了建议 | 标签、标题与“已由智能体撤回”；无操作 |
| `dismissed` | 本浏览器忽略了该建议 | 标签、标题与“已忽略”；**恢复** |
| `available` | 其他情况 | 标签、标题、摘要、**显示提示词**、**开始** 与 **忽略** |

### 开始与打开

**开始** 会先查找 `sessionIds` 包含源 Session 的 Workspace，然后调用 `ctx.uiWorkspace.startSession(workspaceId, { sessionId: task.sessionId, prompt: task.prompt, whenDraftExists: 'keep' })`。没有 Workspace 持有源 Session 时，`startSession` 回退到其当前或最近的 Workspace。提示词以未发送状态进入编辑器，因此用户可选择模型、effort 或 preset、编辑并发送；本包从不提交它。保留 id 下出现 Session 行后，卡片变为 **打开会话**，直接打开该 Session。**打开草稿** 会为空白 Session 行重复 Start 路径；Host 复用该空白会话，`whenDraftExists: 'keep'` 保留其草稿中已有的文字。

`sessionId` 选项属于 [Workspace UI](../../client/ui-workspace/README.zh.md)，其中说明 Host 何时采用指定身份、何时复用其下的空白 Session，以及何时拒绝请求。本包只提供保留的 id。

### 忽略与恢复

**忽略** 会将保留的 Session id 记录到本浏览器持久化的 `dsh.follow-up-task.dismissed.v1` store 中，最新的在前，最多保留 200 个 id；**恢复** 会移除它。加载时，不是数组的存储值会变为无忽略记录，非字符串条目会被丢弃。忽略只改变浏览器存储，因此不会编辑 Session 日志，也不影响其他浏览器。智能体的撤回记录通过 Session 日志到达所有客户端，并优先于本地忽略；卡片随后显示已撤回状态且没有操作。

### 工具行

本包在 keyed `tool.call.toolview` slot 中为每个工具名注册一行，因此 `run_code` 内的 PTC 子调用也使用相同的行。建议行使用新会话图标与标题 **建议后续任务**；在调用准备中、运行中以及成功后，其摘要为去掉首尾空白的 `title` 参数的第一行，该参数缺失或不是字符串时没有摘要。撤回行使用相同图标、标题 **撤回后续任务**，没有摘要。两行都显示准备、运行、失败与停止的共享状态词，将拒绝或错误的第一行用错误颜色显示，可展开查看完整结果文本，并在 owner 提供时添加 **查看调用** 控件。Auto review 拒绝会在 keyed dispatch 之前通过通用行渲染。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client export 注册 `followUpTask` locale 字典、一个用于 `follow-up-task` 节点类型的 Conversation definition、通过 `conversation.chat.turnTail` slot 注册的回合尾部卡片，以及通过 keyed `tool.call.toolview` slot 注册的两个工具行。所有注册都通过 Cordis effect 或 slot injection 执行，因此销毁插件 fiber 会移除它们。卡片的 face 从 Chat target 的 `turnDataSource(turn, 'follow-up-task')` 读取每个回合的任务，并从 slot injection 接收 Session 列表、Workspace 列表、忽略 store 以及 Start、open、dismiss、restore 回调。

definition 将建议的 metadata 折叠为隐藏的回合尾部节点，并在后续携带相同 `taskId` 的撤回记录到达时将 `withdrawn` 设为 true。卡片状态是上述四个输入的纯函数；Start 路径查找源 Session 的 Workspace 并调用 `ctx.uiWorkspace.startSession`。来自 `tool/result` 或 `tool/ptc-dispatch` 的 metadata 属于不受信任的持久数据：客户端校验建议的五个非空字符串（撤回为一个）并自行 brand `ToolCallId` 与 `SessionId`；它只从 Host 包导入类型。忽略 store 向 `createSnapshotStore` 传入持久化解析器：解析器拒绝非数组值，此时没有忽略记录，并丢弃非字符串条目；解析结果不会写回，因此浏览器存储会保留原存储文本，直到下一次忽略或恢复。

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | locale、definition、卡片与工具行注册；卡片 face 回调 |
| [`src/client/definition.ts`](src/client/definition.ts) | 隐藏的回合尾部 Conversation 节点与撤回折叠 |
| [`src/client/card-state.ts`](src/client/card-state.ts) | 纯卡片状态派生 |
| [`src/client/FollowUpTaskCards.tsx`](src/client/FollowUpTaskCards.tsx) | 卡片渲染与 Start、open、dismiss、restore 操作 |
| [`src/client/FollowUpTaskRows.tsx`](src/client/FollowUpTaskRows.tsx) | 两个工具的工具行 |
| [`src/client/dismissals.ts`](src/client/dismissals.ts) | 持久化的浏览器本地忽略 store |
| [`src/client/task.ts`](src/client/task.ts) | metadata 校验与 brand |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文文案 |
| [`src/index.ts`](src/index.ts) | 不执行行为的 Host entry |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Host 工具](../tool-follow-up-task/README.zh.md)——工具、展示 metadata、projection 与每回合上限。
- [Workspace UI](../../client/ui-workspace/README.zh.md)——`sessionId` 选项与草稿保留规则。
- [工具 UI](../../client/ui-tool/README.zh.md)——keyed `tool.call.toolview` slot 与通用行后备。
- [会话 UI](../../client/ui-conversation/README.zh.md)——回合尾部 slot 与 Conversation 节点定义。
- [实验性包](../README.zh.md)——孵化状态与发布策略。

-----

<a id="model-experience"></a>
## 模型体验

### 卡片与工具行

#### 模型看到什么

无。本包将 `suggest_follow_up_task` 与 `dismiss_follow_up_task` 的已记录 `tool/result` 与 `tool/ptc-dispatch` 记录渲染为卡片与工具行；它不注册任何提示词段落、工具 schema、Session 事件或 wire namespace，其浏览器本地忽略记录也从不进入模型请求。

#### Token 影响

零。卡片、工具行与忽略记录不增加模型 token；Host [工具包](../tool-follow-up-task/README.zh.md)拥有所有模型可见的提示段、schema、说明、结果与拒绝信息。

#### KV Cache 影响

独立。本包从不编辑请求 token，因此已可复用的请求前缀保持可复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **fork 继承**——fork 以相同的保留 Session id 继承源会话的卡片；卡片状态跟随保留 id，因此从任一 Session 启动都会把两者标记为已启动。
- **忽略仅限浏览器本地**——Dismiss 与 Restore 只影响本浏览器；另一个浏览器仍会显示卡片，也不存在跨浏览器忽略同步。
- **纯文本摘要**——卡片将 `title` 与 `summary` 作为纯文本显示。摘要说明要求不使用 Markdown，但模型若用反引号包裹标识符，卡片会原样显示。
- **相同 Workspace 与检出目录**——工作树隔离已延期：Start 使用源 Session 的 Workspace 与检出目录，卡片也不提供目录选择。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
