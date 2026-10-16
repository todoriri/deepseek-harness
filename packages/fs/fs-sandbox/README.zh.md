---
description: "强制沙箱的 `ctx.fs` 后端：面向把模型文件变更限制在会话工作区内的部署方与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-sandbox

[English](README.md) | 中文

## 概述

`dsh-fs-sandbox` 按各会话的沙箱模式限制模型对文件的写入与编辑，同时保留本地文件系统的读取行为。`read-only` 拒绝所有变更；`workspace-write` 只允许目标位于会话工作区或平台临时根目录内；`danger-full-access` 不限制变更。当会话需要将文件变更限制在工作区内时，使用它代替 `fs-local`，并加载 `ctx.sandboxPolicy`。被拒绝的操作返回 `FS_SANDBOX_DENIED`，文件系统工具会显示当前模式和同轮次升级提示。

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

当模型的文件写入与编辑必须受会话沙箱模式约束时，挂载此后端以替代 `fs-local`。读取默认不受约束；当模型属于不可信代码时设置 `fenceReads: true`，把读取工具一并约束到相同的根目录。围栏按调用生效：工具层把调用会话的模式与工作区根目录解析为与 bash runner 收到的相同策略，因此文件系统与 shell 两个能力族绝不会约束到不同根目录。

### 最小组合

先加载共享策略服务，再加载此后端，最后加载工具；编辑前读取策略插件仍为可选。

```yaml
- name: '@deepseek-ai/dsh-sandbox-policy'
- name: '@deepseek-ai/dsh-fs-sandbox'
  config:
    cwd: /absolute/path/to/workspace
    # Contain `read`, `read_image`, `list` and search to the workspace + temp
    # roots. Leave it out for a cooperative author that needs host context.
    fenceReads: true
- name: '@deepseek-ai/dsh-tool-fs'
```

（代码块两侧逐字一致，故上方注释与英文侧相同。）除本地后端自身的旋钮（`cwd` 解析默认值与 `diffBasisMaxBytes` 覆写上限）之外，此后端新增 `fenceReads`；[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-fs-sandbox)是完整配置的真源。

### 围栏行为

有效模式来自调用会话的覆盖值或升级授权，两者都未生效时才回退到部署默认值。`read-only` 以结构化 `FS_SANDBOX_DENIED` 拒绝所有变更。`workspace-write` 只允许目标规范化后位于工作区根目录或平台临时区域（`/tmp`、`os.tmpdir()`）之下的变更——与 Seatbelt profile 授权的可写集合相同。`danger-full-access` 不加围栏直接委托。

当 `fenceReads: true` 时，承载内容的读取（`readText`、`streamText`、`readBytes`、`readByteRange`、`listDir`）在 `workspace-write` 下遵循同一策略。该选项只会收窄：`read-only` 与 `danger-full-access` 仍允许所有读取，因此启用它不可能授予会话原本没有的访问权。元数据读取（`stat`、`lstat`）保持不受围栏——它们只暴露存在性与大小，绝不暴露内容。

### 可观察的成功与失败

读取、列出、元数据操作与只读监听均与 `fs-local` 完全一致，除非设置了 `fenceReads`；变更围栏不限制观察。被拒绝的变更返回携带有效模式的 `FS_SANDBOX_DENIED` 错误；经工具，模型会看到 `[sandbox: file access denied under <mode> mode]` 及唯一一次获批更宽权限的重试提示，与 bash 的拒绝完全相同。被拒绝的读取返回相同形状且完全不返回内容——被拒绝的流不产生任何前缀。获得批准升级的会话可以在该次调用中以严格更宽的模式重试同一操作。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释沙箱后端背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

围栏是在可信代码中检查模型控制路径的策略，而非内核边界。操作属于 seam 自身（open、rename），只有目标路径不可信，因此「规范化后检查包含关系」就是该接口的完整答案。不可信代码的内核级隔离仍由 `ctx.shell` 负责。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `SandboxedFileSystem`：`writeText`/`editText` 上的模式围栏、可选的 `fenceReads` 对 `readText`/`streamText`/`readBytes`/`readByteRange`/`listDir` 的围栏、`sandboxMode` 事实 |
| [`src/containment.ts`](src/containment.ts) | 祖先包含检查，带词法快速路径与基于身份的兜底 |

### 变更如何被围栏

每次变更先解析按调用策略（`danger-full-access` 原样返回调用方目标；`read-only` 抛出 `FS_SANDBOX_DENIED`），`workspace-write` 则立即重新规范化目标，并要求它位于由唯一的 `writableRoots` 函数派生的某个可写根之下——与 Seatbelt profile 授权的集合相同，因此 fs 围栏与 bash runner 不会漂移。被变更的正是这个新目标，因此工具解析后被替换的符号链接祖先也会被发现。变更随后按描述符固定目标目录（`fs-local` 的 `verifyOpens`，由本后端启用）：暂存目录、其中的文件以及发布时的 rename 全部经由 `/proc/self/fd/<dirfd>/…`，因此在该包含检查之后被替换的组件也无法改写写入的落点。

### 读取如何被围栏

仅在启用 `fenceReads` 且模式为 `workspace-write` 时：守卫通过与变更相同的 `resolve` 重新规范化目标，要求它位于同一 `writableRoots` 集合之下，并把该新目标交给继承的读取——因此工具解析后被替换的符号链接祖先也会被发现。该读取随后先 open，并在返回任何字节之前核验内核为该描述符报告的路径正是被解析的目标，然后从该描述符读取内容：在包含检查与 open 之间落下的替换会失败，而不是逃逸。这需要 `/proc/self/fd`（Linux；Node 不提供 `openat`）；在没有它的主机上，继承的读取又回到按路径进行——只有上面的先解析后 open 方向仍然成立，后端会如实报告这一点而不是隐瞒。检查在任何内容产生之前运行，因此被拒绝的流不产生任何内容，而不是先给前缀再拒绝。

### 威胁模型

在 Linux 上，解析到系统调用之间的窗口由描述符固定关闭：读取先 open 并核验所打开的描述符正是被解析的目标，变更则按描述符固定目标目录，因此被限制的 worker 换入路径的符号链接不再能改写这两种操作。在没有 `/proc/self/fd` 的地方（Node 不提供 `openat`），这些原语不生效，窗口仍然存在——后端会报告这一平台事实，而不是隐瞒它。拒绝是结构化 `FsError`，而不是 stderr 推断——进程内围栏准确知道自己拒绝了什么。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从本后端逐步进入共享策略归属及其背后的隔离决策。

- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md)——穷尽式提供方约定、策略事件与错误分类体系。
- [dsh-fs](../fs/README.zh.md)——本后端实现的 `ctx.fs` 约定。
- [fs-local](../fs-local/README.zh.md)——本后端扩展的本地后端。
- [sandbox-policy](../../sandbox/sandbox-policy/README.zh.md)——本后端所需的共享逐会话策略解析器。
- [进程沙箱子系统](../../../docs/subsystems/sandbox.zh.md)——模式、逐调用策略与故障关闭错误。
- [跨能力族 fs 沙箱参考](../../sandbox/sandbox-policy/README.zh.md)——共享模式围栏及其升级编排。

-----

<a id="model-experience"></a>
## 模型体验

### 文件系统策略与拒绝

#### 模型看到的内容

策略归属方贡献与具体能力无关的 `sandbox:policy` 上下文。作为间接影响，`dsh-tool-fs` 会把本后端的 `FS_SANDBOX_DENIED` 拒绝渲染为 `[sandbox: file access denied under <mode> mode]` 标记和同轮次升级提示。

#### Token 影响

该后端挂载期间，当前策略条款会增加一条简短的运行时上下文消息；拒绝则会把有界标记与升级提示追加到对话历史。

#### KV Cache 影响

常驻策略发生变化时，会在保留的历史之后追加一份由归属方渲染、取代先前状态的运行时上下文快照；操作结果保持仅追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明沙箱后端何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用沙箱对比或任务积压。

- **策略围栏，而非内核边界**：该检查是可信代码处理模型控制的路径。在 Linux 上，描述符固定关闭了围栏自身操作的解析到系统调用窗口；在没有 `/proc/self/fd` 的主机上该窗口仍然存在，而对抗性宿主进程在任何情况下都不在范围内。不可信代码的内核级隔离仍属于 `ctx.shell`。
- **围栏与 runner 的一致性由单一所有方派生**：可写集合来自 `writableRoots`，该函数与 Seatbelt profile 共享；在其他位置定义可写集合的 runner profile 会发生漂移。
- **要求 `ctx.sandboxPolicy`**：工具使用它解析每个会话策略，后端用它处理无 agent（智能体）调用的回退；未组合该服务时，后端不会实施约束。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
