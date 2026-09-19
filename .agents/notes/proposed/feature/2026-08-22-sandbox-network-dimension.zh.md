# Agent Note：沙箱网络维度

Status: proposed

English | [中文](2026-08-22-sandbox-network-dimension.md)

## 问题

沙箱缝的文件效果词汇在其范围内是完整的，JSDoc 明确写着："Network and process visibility are outside this vocabulary"（[`packages/sandbox/sandbox/src/index.ts`](../../../../packages/sandbox/sandbox/src/index.ts)）。`read-only` 或 `workspace-write` 下的受限进程可以打开任意网络连接——把它可读的工作区数据外传。OpenAI 的 Codex harness 用带逐 host 策略的本地 HTTP/SOCKS5 网络代理、托管 CA 下的可选 TLS MITM、以及按 host 注入凭据而非放进子进程环境的凭据代理（openai/codex `network-proxy/`）来关闭这一面。该代理层是正确的长期形态，但它是部署级组件，不是缝的词汇。

## 提案

为 `SandboxExecutionPolicy` 扩展一个显式的 network 字段并逐平台执行，按三个独立步骤落地：

### 步骤 1 —— 词汇与 fail-closed 解析

- `SandboxExecutionPolicy` 增加 `network: 'denied' | 'allowed'`（在消费方的显式 resolve 步骤默认，与 mode 相同；`danger-full-access` 蕴含 `allowed`）。
- 词汇变更同一变更内更新缝 README、`SandboxMode` JSDoc（"outside this vocabulary" 句移入历史）与沙箱 subsystem 文档。

### 步骤 2 —— 逐平台执行

- **macOS（Seatbelt）**：`packages/sandbox/sandbox-local/src/profiles.ts` 在生成的 sbpl 上追加 `(deny network*)`（及反向）。成本低，`full` 执行。
- **Linux（Landlock）**：`native/landlock-run` 在探测到的 ABI ≥ 4 时增加 ABI-4 `LANDLOCK_ACCESS_NET_{BIND,CONNECT}_TCP` 规则。两个诚实的限制决定 `partial` 执行：仅 TCP（无 UDP，因此 DNS 必须失败或在受限前解析）；低于 6.7 的内核报告无网络执行。`SandboxEnforcement` 已带有这个 `full`/`partial` 划分。
- **Windows**：初期无执行路径；后端报告 `partial`，策略仍解析（拒绝降级为策略诚实的元数据，绝不静默放行）。

### 步骤 3 —— 消费方接线

`dsh-bash-sandbox` 从自身配置解析 network 字段（受限 profile 默认 `network: denied`）；fs/subprocess 提供方透传；模型可见的运行时上下文快照增加网络行，让模型在撞上边界之前就知道它。

## 考虑过的替代方案

- **现在就做本地代理（Codex 形态）**：逐 host allowlist 与凭据代理严格强于系统调用拒绝，但它们是带生命周期（进程监督、CA 管理、密钥存储）的部署组件——不是策略字段。在词汇之后落地，代理才有可执行的缝。
- **`sandbox-exec`/seccomp 过滤列表**：拒绝作为主机制；Landlock 已是树内 Linux 机制，且保持 native 插件单一职责。

## 后果（若采纳）

- `SandboxPolicy` 增加一个字段：所有后端与升级词汇（`EscalationRequest` 为获批的放宽增加网络维度）一起更新；磁盘格式不受影响（策略逐调用，从不持久化）。
- 执行诚实性即契约：无法拒绝网络的主机报告 `partial`，要求绝对边界的调用方按此对待。
- 运行时上下文的审批贡献（dsh-user-approval）以与文件效果相同的快照风格陈述网络边界。

## 验收标准

- 每个受限执行解析出显式的 `network` 字段；受限之下没有任何静默默认为 `allowed` 的路径。
- 无法执行所解析网络策略的主机报告 `partial` 执行，要求绝对边界的调用方绝不把它当作 `full`。
- 在每个报告网络执行为 `full` 的平台上，REAL 组合测试中被拒绝的受限进程无法完成出站 TCP 连接。
- 模型可见的运行时上下文快照陈述生效的网络边界。

## 风险

- Landlock 原生改动触及 source-of-record 的 vendored 插件（`native/landlock-run`）；其内核 ABI 矩阵（含低于 6.7 的 CI runner）必须保持绿色，否则给网络规则设闸。
- 连 UDP 一起拒绝 DNS 会破坏 mode 允许的工作流的名称解析；resolve 步骤在 Linux `denied` 实际可用之前可能需要文档化的回环解析器方案。
- 一开始被所有后端忽略的词汇字段有政策表演的风险：后端落地与 `partial` 报告必须与词汇同一变更交付，而不是之后。

## 验证（实现时）

- 平台测试：seatbelt profile 字符串钉住 `(deny network*)` 形态；native 插件的 ABI 探测以内核版本偏差用例给网络规则设闸；每个后端的 `enforcement()` 答案对策略断言。
- REAL 组合测试限制一个 curl 回环监听器的 bash 调用：在报告 `full` 的各平台上 `denied` fail closed，且解析出的策略在请求上下文中可见。
