# Agent Note: 后续任务建议

Status: implemented

[English](2026-11-01-follow-up-task-suggestions.md) | 中文

## 问题

智能体在处理一个请求时，经常会注意到请求之外的工作：顺带发现的缺陷、缺失的测试覆盖、过时的文档，或一个已确认的 TODO。目前只有两种应对方式：在正文里提一句，而这句话会随对话滚走，也不带任何可执行的起点；或者现在就把这项工作做掉，这会扩大改动范围并推迟当前请求。两条路都没有把观察连同日后行动所需的上下文记录下来。

后续任务需要智能体已经掌握的上下文：目标、相关文件路径、观察到的现象，以及如何验证结果。启动它的 Session 看不到产生建议的那段对话，因此它收到的一切都必须能够独立成立。用户还需要一个可见的位置，让建议连同其内容停放在那里可供查看，直到用户选择开始；在那之前什么都不会运行。

## 决策

智能体在轮次中调用 `suggest_follow_up_task`，传入 `title`、`summary` 和 `prompt`。该调用预留一个形如 `session-<uuid>` 的 Session id，并返回 `{ taskId, sessionId }`，其中 `taskId` 就是这次调用自身的 id。在该轮次下方，Web 对话显示一张卡片，包含标题、摘要、**显示提示词**展开项，以及 **开始** 和 **忽略**。卡片由已记录的工具结果重建，因此能在重新加载和回放后继续存在。

**开始** 在预留 id 下、于持有源 Session 的 Workspace 中打开一个新 Session，并把 `prompt` 以未发送状态放入 composer。用户选择模型、推理强度或 preset，编辑文本并发送；本包从不代为提交。该 Session 尚无已提交输入时，卡片显示 **打开草稿**，再次执行开始路径并保留草稿中已有的文本；一旦该 Session 已开始，或预留 id 已被归档，卡片显示 **打开会话**，直接打开该 Session。没有 Session 存储在该 id 下时，Host 采用预留身份；该 id 下仍有空白 Session 且它是该 Workspace 的成员时，Host 重用它；若身份存储在另一目录下或由子代理路由拥有，Host 拒绝该身份；其他情况下 Host 创建另一个 Session。

智能体用 `dismiss_follow_up_task({ taskId })` 撤回建议，卡片显示「已由智能体撤回」，不带任何操作。用户已经启动的 Session 不受影响，因为已开始和草稿状态优先。用户自己的 **忽略** 把预留 Session id 记录在本浏览器中，并显示 **恢复**；撤回记录通过 Session 日志到达每个客户端，并优先于本地忽略。

### 组件

| 包 | 面 | 职责 |
|---|---|---|
| [`@deepseek-ai/dsh-experimental-tool-follow-up-task`](../../../../packages/experimental/tool-follow-up-task/README.zh.md) | Host | 两个工具、每轮上限、`followUpTasks` Session 投影，以及元数据类型 |
| [`@deepseek-ai/dsh-experimental-client-ui-follow-up-task`](../../../../packages/experimental/client-ui-follow-up-task/README.zh.md) | Web | Conversation 定义、turn-tail 卡片、转写行、浏览器本地忽略存储，以及 locale |
| [`@deepseek-ai/dsh-client-ui-workspace`](../../../../packages/client/ui-workspace/README.zh.md)（现有） | Web | 可选的 `StartSessionOptions.sessionId` |

工具包的 [`cordis.patch.yml`](../../../../packages/experimental/tool-follow-up-task/cordis.patch.yml) 为每个包插入一行，因此一个组合要么同时得到工具和卡片，要么都得不到。该组合包是实验性的，没有随附的 profile 挂载它；Headless、ACP 和 SDK 组合不包含它，因为那里没有渲染卡片的地方。Web 包还在 keyed `tool.call.toolview` slot 中为每个工具注册一个转写行，因此两次调用都显示为具名行，而不是通用兜底行。

### 数据契约

工具包中的 `src/contract.ts` 是这两条记录的单一定义。成功的建议写入 `output.presentationMeta`，携带 `taskId`、预留的 `sessionId`，以及去除首尾空白后的 `title`、`summary` 和 `prompt`；成功的撤回写入带 `taskId` 的已撤回记录。core 把原生调用持久化为 `tool/result.meta`，把 PTC 子调用持久化为 `tool/ptc-dispatch.meta`。只有成功的调用会写入元数据，因此被拒绝的调用不会产生卡片。

Web 包只从该模块导入类型，并把元数据视为不可信的持久数据：它逐字段校验，并自行对 `ToolCallId` 与 `SessionId` 施加 brand。因此该记录不需要 wire namespace，也不需要浏览器 bundle 发出任何运行时模块请求；格式错误的记录不会产生卡片，而不是产生一张损坏的卡片。

### 卡片状态

一张卡片根据四个输入推导出一个状态：针对同一 `taskId` 的后续撤回记录、本浏览器的忽略记录、预留 id 下的 Session 列表行，以及 Workspace 的已归档 id。首个匹配行胜出：

| 状态 | 条件 | 卡片 |
|---|---|---|
| `started` | 存在 Session 行且不为空白，或预留 id 已被归档 | **打开会话** |
| `drafted` | 存在 Session 行且为空白 | **打开草稿** |
| `withdrawn` | 智能体撤回了建议 | 标题与「已由智能体撤回」；无操作 |
| `dismissed` | 本浏览器忽略了建议 | 标题与「已忽略」；**恢复** |
| `available` | 其他情况 | 标题、摘要、**显示提示词**、**开始** 和 **忽略** |

该状态是这些输入的纯函数，因此重新加载、回放或 Session 列表变化都会从同样的事实得到同样的卡片。

### Host 状态与每轮上限

工具读取仅存在于 Host 的 Session 投影 `followUpTasks`，而不扫描历史：它保存打开轮次中的建议调用 id，以及该 Session 中每个成功建议的 task id。它在 `turn/start` 时重置打开轮次列表，在 `turn/end` 时清空，从 `tool/call` 与 `tool/ptc-dispatch-start` 追加建议调用 id，并从 `tool/result` 与 `tool/ptc-dispatch` 的元数据中追加经过校验、携带五个非空字符串的 `taskId`。该投影没有 wire 视图；Web 卡片读取已送达的事件。

`maxSuggestionsPerTurn`（至少为 1 的自然数，默认 3）限制一个轮次中的建议数量。一次调用的位置是它在打开轮次列表中的索引加一，或该 id 不在列表中时为列表长度加一；位置超过上限即被拒绝。因此同一步中的并行调用有确定顺序，被拒绝的调用仍然占据一个位置。两个工具都会拒绝没有调用方 agent 的调用，以及来自委派子代理的调用；建议工具还会拒绝空字段，撤回工具会拒绝本 Session 从未建议过的 `taskId`。每次拒绝都是普通的工具错误，任何拒绝都不会写入元数据。

## 考虑过的替代方案

**轮次结束时的旁路调用。** `agent/turn-stopping` 模型调用能在每个轮次结束后给出建议，无需模型主动选择工具。该 hook 是串行的，并在每个轮次关闭前被等待，因此会拖慢每个轮次，并且每轮增加一次模型请求；其建议只存在于进程内存中，在日志之外，回放无法重现这些卡片。

**专用 Session 事件。** 用 `follow-up-task/*` Session 事件记录建议，需要 session-format 评审、`SessionEventMap` 成员以及 SDK 预期输出更新。工具结果已经携带卡片展示的每个字段，回放也能从它重建卡片，因此新事件类型不会记录日志中尚未保存的任何事实。

**Host 存储。** 像 Schedule 为任务所做的 Host 存储域能持久保存建议。它为工具结果已持有的数据增加服务、索引和生命周期；预留 Session id 已经提供了存储原本要追踪的已开始状态。

**自动发送。** 创建 Session 并提交 `prompt` 能省去用户一步。它也会在用户审阅提示词、选择模型、推理强度或 preset 之前就发出请求，而这些正是新 Session 在第一次请求前需要做出的选择。

**在轮次处 fork。** fork 会把对话交给新 Session。它会在本地 vLLM 上重新预填充整个父级前缀，在约 200K token 时需要数分钟。带独立提示词的全新 Session 从提示词所述的上下文开始。

**同步日志扫描。** 直接读 Session 日志来执行上限与撤回检查可以省掉投影。同步历史读取已[弃用，新的生产代码禁止使用](../architecture/2026-09-09-deprecate-synchronous-session-event-reads.zh.md)；投影会在恢复时重建，并从新事件保持最新，因此两项检查都不读取历史。

**Host 保存的忽略状态。** 忽略状态可以放在 Host 上，让每个浏览器一致。Host 端点会为一个只影响单个浏览器显示偏好的状态增加服务和 wire 接口，因此忽略保持浏览器本地，直到确需跨浏览器同步。

## 后果

一次建议只花费一次普通工具调用：发出建议的轮次不会增加模型请求，也不会延迟轮次关闭。卡片由 Session 日志重建，因此重新加载和回放都会重现它；已开始状态存在于预留 id 下的 Session 列表里，因此每个客户端都能一致看到，无需新的存储。该功能不新增 Session 事件类型，因此不需要 session-format 迁移、SDK 预期输出或升级指南。

该功能以两个实验性包发布，由一个可选的 Web 组合包一起挂载。没有随附的 profile 包含它；Headless、ACP 和 SDK 组合都不包含它，因为它们不渲染卡片。Web 包不注册提示词 section、工具 schema 或 Session 事件，因此不改变模型看到的任何内容。

已知限制：

- fork 会以相同的预留 id 继承源 Session 的卡片，因此从任一 Session 开始都会把两者都标记为已开始。
- 用户的忽略不会跨浏览器同步；在智能体撤回之前，另一个浏览器仍会显示卡片。
- 在同一个 `run_code` 程序内，紧跟在建议之后的撤回可能因未知而被拒绝，因为 PTC 只在子调用解析后才追加 `tool/ptc-dispatch`；在后续步骤中的撤回会成功。
- 工作树隔离被推迟：任务在源 Session 的 Workspace 中启动并复用其 checkout，卡片不提供目录选择。
- 卡片把 `title` 和 `summary` 渲染为纯文本；模型若用反引号包裹标识符，卡片会原样显示。

## 相关

- [Client 从原始 Session 工具事件派生展示](../architecture/2026-08-23-client-derived-tool-presentation.zh.md)保留 `output.presentationMeta` 与持久 `tool/result.data.meta` 作为执行结果事实的通道，这些卡片消费该通道。
- [Client Conversation 业务节点组装](../architecture/2026-08-09-client-conversation-node-assembly.zh.md)拥有本卡片使用的 Conversation 定义机制。
- [Chat 分组树交换](../architecture/2026-10-11-chat-group-tree-exchanges.zh.md)决定内置节点（包括 `turn-tail`）的放置位置，这些卡片在那里注册。
- [初始草稿内容与结构化引用恢复](../architecture/2026-09-30-structured-draft-initialization.zh.md)拥有填充新 Session composer 的 `startSession` 提示词选项。
- [空白 Session 复用的写入者获取](../architecture/2026-09-17-process-local-blank-sessions.zh.md)拥有 **打开草稿** 背后的具名空白 Session 复用。
