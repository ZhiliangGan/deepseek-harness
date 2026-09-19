# Agent Note：结构化输出契约

Status: implemented

English | [中文](2026-08-22-structured-output-contracts.md)

## 问题

嵌入调用方（CI、流水线、SDK 消费者）需要 agent 的最终回复是机器可用的 JSON，而不是自由散文。harness 已在两个窄点校验 JSON Schema——工具输出与 workflow 子代理（[workflow worker runtime](../../../../packages/workflow/workflow-ptc/src/runtime.ts) 对每个子代理应用 `assertObjectJsonSchema`）——但没有任何机制约束整段对话的回复，且 LLM 缝没有暴露 provider 原生的结构化输出模式（`LlmCallConfig` 只携带 provider/model/采样参数）。OpenAI 的 Codex SDK 用 `thread.run` 上的逐 turn `outputSchema` 回应了同一需求。

## 决策

一个包，[`packages/structured-output/structured-output/`](../../../../packages/structured-output/structured-output/README.zh.md)，暴露 `ctx.structuredOutput`。执行完全落在文档化扩展点上——不改动 agent-loop：

- **挂载**追加一条持久 `structured-output/armed` 事件（schema 与已解析的重试预算）并注入契约指令（`agent.inject`，form `instructions`）。插件配置中的 standing schema 覆盖每个根 agent turn；`arm(agent, { schema })` 覆盖下一个完成的 turn 并随之消耗。
- **校验**挂在 `agent/turn-stopping`——串行停止边界扩展点，其文档化契约正是"反对的监听器 steer 后机器重读 inbox"。turn 的最终 assistant 文本取自持久日志；提取一个 JSON 文档（整文本解析、剥离一层代码围栏、散文中第一个配对的对象/数组——字符串感知扫描），并用 `dsh-tools` 的 `validateJsonSchemaValue`（与工具及 workflow 已执行相同的受支持子集）校验。
- **重试**在 `maxRetries` 预算内 steer 一条携带受限违规（三条、每条 200 字符）的 `notice` 消息；结算追加 `structured-output/outcome`（`{ turn, valid, attempts, value? | violations? }`）并发出实时 `structured-output/decided`。无文本的 turn（空、取消）不执行校验，契约保持挂载。

SDK 以 `session/prompt` 上的可选 `outputSchema` 暴露：server 在 `followup` 前挂载可选服务（未组合插件的部署对该参数显式失败），结算经由既有 `session.event` 通知流返回——不新增结果形状。

## 考虑过的替代方案

### 为什么是 turn-stopping 而不是 provider 原生 JSON 模式

DeepSeek 的 `json_object` 模式约束其搭载的每个请求，而不是工具调用对话中的某一条回复；按 step 设置会在 turn 中途禁止工具调用，而最终回复只有在停止边界才可识别。提示侧指令加边界校验与 provider 无关、跨 provider 不变，并与既有 schema 校验器组合。若将来 provider 提供按 turn 的结构化输出，`responseFormat` 缝仍然开放。

### 契约不是什么

它不是类型保证的函数调用。结算可能 `valid: false`（预算耗尽）；调用方读取 outcome 事件并自行决策。模型把 schema 视为指令，提取刻意接受围栏或散文包裹的文档而非强求裸 JSON——执行校验的是值，不是格式。

## 后果

- `structured-output/armed` / `structured-output/outcome` 加入 `SessionEventMap`（可合并扩展；不提升 `SESSION_FORMAT_VERSION`）；invariant 伴生在加载与实时追加时按当前 schema 复验每个合规 outcome。
- jsonrpc-agent 示例组合该插件，其 SDK 部署接受 `outputSchema`；dsh-base 不组合（面向嵌入部署的选择性能力，与普遍有用的 notes/todo 工具不同）。
- 重试计数是进程本地的（包 README 已记录）；持久流记录结算，不记录进行中的计数。

## 验证

- `packages/structured-output/structured-output/tests/` —— 脚本化进程内适配器驱动的真实循环执行（steer 重试、围栏、散文提取、预算耗尽、一次性消耗、standing 重挂去重）、纯提取、Loader 组合与流 invariant；CI 门下 100% 单文件覆盖率。
- `packages/sdk/server/tests/plugin-apply.spec.ts` —— 组合与未组合插件时 `outputSchema` 的线上端到端。
- `examples/headless-agent/tests/headless.snapshot.ts` —— keyless `structured-output` 快照：被拒散文 steer 一次重试，turn 以会话日志中断言的合规值结算。
