---
description: "DeepSeek Harness 会话上的结构化输出契约：每轮一份 JSON Schema、停止边界校验与有界转向重试，供装配或排查契约的嵌入方与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-structured-output

[English](README.md) | 中文

<a id="summary"></a>
## 概述

结构化输出契约执行（`ctx.structuredOutput`）：对话的最终回复必须是满足某个 JSON Schema 的单个 JSON 对象或数组；在 turn 停止边界校验，未通过则 steer 重试，直到合规或重试预算耗尽。

<a id="table-of-contents"></a>
## 目录

- [概述](#summary)
- [功能](#what-it-does)
- [单一属主与作用域](#single-owner-and-scope)
- [配置](#configuration)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="what-it-does"></a>
## 功能

为一段对话挂载一份契约：

- **standing schema** —— 插件配置中的 `schema` 在没有一次性 arm 激活时校验每个根 agent turn（部署级"该 agent 始终以 JSON 回复"契约）；
- **一次性 arm** —— `ctx.structuredOutput.arm(agent, { schema, maxRetries? })` 校验该 agent 下一个完成的 turn 并随之消耗（嵌入路径：SDK `session/prompt` 的 `outputSchema`）。

挂载时追加一条持久 `structured-output/armed` 事件（schema 与已解析的重试预算——回放可重建契约），并向对话注入契约指令（`agent.inject`，source `structured-output`、form `instructions`）。

在每个 `agent/turn-stopping` 边界——文档化的扩展点：反对的监听器 steer 后机器再跑一步——服务从持久日志读取该 turn 的最终 assistant 文本，提取一个 JSON 文档（整文本解析、剥离一层代码围栏、或散文中第一个配对的对象/数组），用 `validateJsonSchemaValue`（`@deepseek-ai/dsh-tools`；与工具及 workflow 结构化输出相同的受支持子集）按当前 schema 校验：

- **合规** —— 一条 `structured-output/outcome` 事件 `{ turn, valid: true, attempts, value }` 与一条实时 `structured-output/decided` 通知；一次性 arm 被消耗。
- **不合规且预算未尽** —— 一条 steer 消息（source `structured-output`、form `notice`）携带受限违规列表；turn 保持打开，模型重新回复。
- **不合规且预算耗尽** —— turn 以 `{ turn, valid: false, attempts, violations }` 关闭；调用方从 outcome 事件读取失败。

未产生 assistant 文本的 turn（空 turn、取消）不执行校验；契约保持挂载。

<a id="single-owner-and-scope"></a>
## 单一属主与作用域

契约属于一个 agent 的对话。`arm()` 拒绝非注册表活动实例的 agent。子代理与压缩摘要器运行各自的循环；只有属主 agent 的 turn 被校验。

<a id="configuration"></a>
## 配置

`maxRetries`（默认 2）限制每次拒绝后可 steer 的额外尝试。`maxSchemaChars`（默认 16384）在挂载时限制 schema 的 JSON 序列化长度。非 JSON 对象的 schema 或超出 `dsh-tools` 受支持子集的 schema 在加载（standing）或 `arm()` 调用时显式失败——绝不在 turn 中途失败。持久 invariant 只检查结构与跨事件关系（合规 outcome 的 value 满足当前 schema；不合规 outcome 携带 violations），因此在宽松配置下写入的日志在策略收紧后仍可回放。

<a id="model-experience"></a>
## Model Experience

### 契约指令

#### 模型所见

挂载时一条注入的上下文消息（form `instructions`），声明最终回复义务并逐字嵌入 schema。

##### 契约开头原文

```markdown
Structured-output contract: when the task completes, your FINAL assistant message must be ONLY a single
JSON object or array satisfying this JSON Schema (no prose, no code fences, no text before or after):
```

#### Token 影响

条件性：每次挂载一条指令（standing 契约每会话注入一次，resume 时静默重挂）；重试为每次被拒的回复追加一条受限通知。

#### KV Cache 影响

指令作为排队上下文落在下一个 step 边界；前缀保持可复用。对话中途挂载只追加，既有请求 token 仍可复用；重试通知按拒绝逐条追加。

### 重试通知

#### 模型所见

每次被拒回复一条 `notice` 消息：`Your final reply was rejected by the structured-output contract.` 加最多三条违规，每条上限 200 字符。

#### Token 影响

受违规上限约束；重试预算内每次拒绝一条通知。

#### KV Cache 影响

只追加；新可见内容跟随可复用请求前缀，不使既有 KV-cache 条目失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **未使用 provider 原生 JSON 模式** —— 契约靠指令与校验，而非设置线上的 `response_format`；DeepSeek 的 `json_object` 模式按请求生效而非按最终回复，无法只约束工具调用对话中某个 turn 的最后一条消息。
- **standing 契约每会话只注入一次** —— 压缩后指令可能落在活动上下文之外；重试通知与 armed 事件保持契约可执行，若长会话证明需要，再注入属于压缩缝的事项。
- **重试计数是进程本地的** —— 各 outcome 中的持久 `attempts` 值反映结算进程；重试中途崩溃后，重开 turn 的计数重新开始。

### 开发备注

- 设计与契约：[Agent Note：结构化输出契约](../../../.agents/notes/implemented/feature/2026-08-22-structured-output-contracts.zh.md)。
