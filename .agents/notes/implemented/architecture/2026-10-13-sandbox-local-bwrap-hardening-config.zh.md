# Agent Note：以提供方配置实现 bwrap 网络与宿主路径加固

Status: implemented

[English](2026-10-13-sandbox-local-bwrap-hardening-config.md) | 中文

## Problem

在默认的 `workspace-write` bwrap profile 中，受限命令可以访问宿主网络，并读取操作方可读的每个文件：`--ro-bind / /` 呈现整棵目录树，而非特权用户命名空间不会改变文件所有权。2026-10-12 在报告宿主上的测量：到宿主监听器的 TCP 连接被接受，`~/.ssh` 下 10 个文件、`~/.dsh` 下 1006 个文件可读，`~/.config/gh/hosts.yml` 可读。对于 shell 必须被视为敌对的自主 agent，可读的凭据加上开放的网络正是外泄的组合（loopcc 评审发现 D86-2，记录于 loopcc 项目）。

原始请求的两个前提是错误的，并影响了决策：运行模型传输的是 harness 进程而非沙箱，因此关闭网络不会破坏提供方访问；仓库内每个 spawner 在子进程启动前都已剥离凭据形态的环境变量名，因此无需环境相关工作。

## Decision

`@deepseek-ai/dsh-sandbox-local` 新增三个经校验的配置字段：`network: 'inherit' | 'none'`、`hidePaths` 与 `exposeReadOnly`。它们是操作方对每条受限命令的常设选择，承载于提供方，而不是逐调用的 `SandboxPolicy`——后者的词汇仍仅限文件效果。

- bwrap 追加 `--unshare-net`，然后为每个被遮蔽目录挂载 tmpfs，再是只读暴露绑定，再是模式挂载，最后把每个遮蔽重新挂载为只读。顺序即机制：bwrap 必须在遮蔽变为只读之前在其下创建挂载点，而 `--remount-ro` 不递归，因此遮蔽之下的工作区仍可写。bwrap 探测运行的就是加固后的 profile。
- 只有 bwrap 或 bwrap 兼容的 `runnerCommand` 能表达该加固。当选择落在 Landlock、Seatbelt 或 Windows ACL runner 上时，提供方缓存 `unavailable`，`confine()` 抛出指明该 runner 的 `SANDBOX_UNAVAILABLE`，绝不会在静默丢弃加固的情况下限制命令。
- 路径在加载时校验并规范化：绝对、存在、遮蔽绝不为 `/`、暴露条目位于某个遮蔽之下。哪些工具链路径得以保留由操作方在 `cordis.yml` 中列出，绝不是 `profiles.ts` 中的常量，因为工具链位置因宿主而异。
- 默认值产生不变的 argv；无需升级指南。

## Consequences

- 选择加入的部署在受限命令内失去 `pnpm install`、`git fetch`、`curl` 以及到宿主服务的回环连接；落地流程运行在沙箱之外的 worker 可以接受这一点。
- 一旦设置任一字段，没有可用 bwrap 的宿主将完全无法限制命令；拒绝信息指明 runner，让操作方看到原因。
- 遮蔽 `$HOME` 只移除了基于 shell 的外泄路径。harness 进程自身仍以操作方的权限运行；其自有工具可以读取什么是另一个决策。
- Landlock 档无法遮蔽目录（其授权是 allow-list），且没有原生插件工作就没有网络控制；Seatbelt 的 `(deny network*)` 形式未交付，因为没有 macOS 宿主可以验证它，而未经测试的强制执行声明比拒绝更糟。

## Alternatives considered

**把网络与遮蔽作为逐调用策略的字段。** 被否决：seam 文档声明文件效果是其全部词汇，而这一变更需要四个 runner 实现加上原生 Landlock launcher，只为一位操作方的部署级选择。

**用 `/usr`、`/bin`、`/lib` 重建根目录而非遮蔽。** 被否决：依赖宿主且脆弱，会破坏 git 目录位于工作区之外的 `/mnt` worktree，而且相比遮蔽存放秘密的目录收益甚微。

**让遮蔽保持可写。** 被否决：`read-only` 承诺除 `/dev/null` 外没有可写接收器，且在 `--ro-bind / /` 下被遮蔽目录本就只读，因此只读遮蔽恰好保留了今天的行为。

**在链中没有 bwrap 的平台上于加载时拒绝。** 被否决，改为在首次受限包装时的单一拒绝路径：Linux 上的 runner 选择本就是惰性且依赖探测的，而第二条加载时路径在 Linux 覆盖率通道中不可达。
