# Agent Note: http-proxy 持有可选的 undici 响应体超时

Status: implemented

[English](2026-09-20-http-proxy-body-timeout.md) | 中文

## 问题

Node 内置的 `fetch` 运行在 undici 之上，其全局 dispatcher 将 `bodyTimeout` 与 `headersTimeout` 设为 300000 ms。流式 provider 会立即发送响应头，然后在 prefill 结束前不发送任何响应体字节，因此超过五分钟的 prefill 会被客户端自己的传输层中止，表现为裸的 `TypeError: terminated`（`cause` 为 `UND_ERR_BODY_TIMEOUT`）。`dsh-llm-pi-ai` 将其压平为可重试的 `TRANSPORT` 错误（[`stream.ts`](../../../../packages/llm/llm-pi-ai/src/stream.ts) 丢弃了 `cause` 链），并重试进入同样的等待，每次重试都会重新发送整个上下文。适配器的 `streamIdleTimeoutMs` 无法抢先处理：该看门狗（[`config.ts`](../../../../packages/llm/llm-pi-ai/src/config.ts) 中 `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000`，在 [`adapter.ts`](../../../../packages/llm/llm-pi-ai/src/adapter.ts) 中设置）在流静默时触发，而中止来自传输层。这就是 [deepseek-ai/deepseek-harness#5673](https://github.com/deepseek-ai/deepseek-harness/discussions/5673)；长上下文 prefill 超过五分钟的本地 teacher 必然陷入客户端中止并重试的循环。

## 决策

`dsh-http-proxy`——已经持有 undici 全局 dispatcher 的包——读取一个启动环境变量 `DSH_HTTP_BODY_TIMEOUT_MS`，并据此设置 undici 的 `bodyTimeout` 与 `headersTimeout`。两者由同一个值驱动，因为流式 provider 的静默间隙位于响应体中。`installProxyFromEnvironment` 从代理策略读取的同一个 `EnvLookup` 解析该值，因此遵循启动器“先导出变量、后 `$DSH_HOME/.env`”的分层。

解析规则：缺失或空白时不安装任何新对象，因此没有代理的进程保留 undici 自己的全局 dispatcher，[`install.spec.ts`](../../../../packages/util/http-proxy/tests/install.spec.ts) 所固定的“每个进程一个答案、无答案时不安装任何东西”不变式保持不变。值 `0` 取消该上限。正值作用于本进程路由的每一个请求。不是毫秒计数的值会被报告并跳过，与代理报告不可用值的方式一致。

该上限覆盖 dispatcher 的全部三个 undici 构造点：策略 Agent 及其 factory 构建的每个按 origin 划分的 client；直连策略取代代理策略时安装的直连 Agent；以及没有代理但配置了上限时新安装的直连 Agent。undici 的 `ProxyAgent` 仅用 connector 构建内部转发连接池并丢弃 client 超时，因此通过其 `factory` 重新应用该上限——补上了上游提案承认未覆盖的代理路径缺口。所有构造都留在本包内，因此 `verify-no-bare-dispatcher` 无需任何豁免即可通过。

## 考虑过的替代方案

**在 `dsh-llm-pi-ai` 中增加第二个 dispatcher 安装器（上游 `egress.ts` 的做法）。** 已拒绝：`verify-no-bare-dispatcher` 禁止在本包之外使用 `new Agent(...)` 与 `dispatcher` 选项，而第二个 `setGlobalDispatcher` 持有者会重新引入本包所要消除的单一全局槽位争用。它还会让 MCP-over-HTTP、web search 与 web fetch 停留在 undici 默认值上。

**由适配器提供按请求、限定 loopback 的 `fetch`。** 已推迟：pi-ai `0.85.1` 确实接受按请求的 `fetch`（`openai-completions` 将 `options.fetch` 传入 `openai` client；`pi-messages` 调用 `options?.fetch ?? globalThis.fetch`），并且 [`web-fetch-http`](../../../../packages/web/web-fetch-http/src/network.ts) 展示了经认可的 `proxy-exempt:` 按请求 dispatcher。但它只作用于 LLM，只修复一个消费者，需要适配器 fetch 接口，也无法限定进程级持有者所覆盖的其他出网路径。

## 后果

在将 `DSH_HTTP_BODY_TIMEOUT_MS` 设为大于 300000 的有限值的部署上，超过五分钟的 teacher prefill 会流式完成，而不会被客户端中止并重试，`terminated`/`TRANSPORT` 重试循环因此停止。该变量默认未设置，因此超时仍由适配器的空闲看门狗负责，随附 profile 的行为不变；快照语料不受影响，因为没有快照挂载该开关。小于或等于 undici 1000 ms 定时器精度的值不会生效；值 `0` 会取消非 LLM 出网路径仅有的响应体超时；该上限只覆盖全局 dispatcher 上的进程内请求——不包括 worker 线程的 dispatcher、`node:http` 遥测或 spawn 出的子进程。[`install.spec.ts`](../../../../packages/util/http-proxy/tests/install.spec.ts) 覆盖了：在有限上限下，直连与代理路径上停滞的响应体被中止；`0` 使其存活；不可用值被报告且默认值保持不变；以及未设置时全局 dispatcher 的身份不变。该开关及其限制记录在包的 [README](../../../../packages/util/http-proxy/README.zh.md) 中。
