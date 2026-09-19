---
description: "审批请求瀑布上的 LLM 评审应答器：在不打断人的前提下裁定按需审批，供选择、配置或排查该守护器的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-guardian-approval

[English](README.md) | 中文

<a id="summary"></a>
## 概述

Guardian 审批：`approval/request` waterfall 上的 LLM 审查 answerer，在不打断人类的情况下结算 on-request 审批，对无法确信判断的一切选择交还。

<a id="table-of-contents"></a>
## 目录

- [概述](#summary)
- [功能](#what-it-does)
- [组合](#composition)
- [配置](#configuration)
- [持久记录](#durable-record)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="what-it-does"></a>
## 功能

在 `ctx.approval` 的 `approval/request` waterfall 上注册一个 answerer。当 on-request 审批触发时，guardian 用配置的审查路由发起一次辅助模型调用（`purpose: 'guardian-review'`），携带紧凑的审查提示：agent 最新的用户意图（上限 2000 字符）、工具名与提问方的原因。审查模型被要求只回复 `{"decision":"allow"|"deny","rationale":"…"}`（提取接受外层代码围栏或散文包裹）。随后：

- **`allow`** —— guardian 认领该请求（`allowed-once`，词汇表中唯一的授权），在此之前追加一条持久 `guardian/review` 记录。
- **`deny`** —— guardian 以 `rejected` 认领，同样留下持久记录。
- **其他一切** —— 输出畸形、未知 decision、缺 rationale、tool-call 形回复、超时、中止、传输错误 —— guardian 调用 `next()`，由其余 answerer 链决定（在发布应用中：人类审批 UI）。guardian 绝不放宽未应答审批的边界；失败向人类交还，而不是静默授权。

审查提示的策略行刻意保守：放行常规可逆工作，拒绝重大或不可逆风险，不确定时拒绝（拒绝仍会交还可被人类覆盖）。

<a id="composition"></a>
## 组合

加载顺序决定链序：把 guardian 组合在人类 answerer 之前，常规审批无需人工往返即可结算；更晚的组合只能看到 guardian 交还的部分。该插件是可选的——没有发布 bundle 组合它。它要求 `ctx.llm` 带已配置的审查路由。

<a id="configuration"></a>
## 配置

`reviewerProvider` 与 `reviewerModel` 必填（审查者是明确的部署选择，绝无默认路由）。`maxOutputTokens`（默认 256）限制单次审查回复；`timeoutMs`（默认 30000，受平台定时器上限约束）是墙钟预算——到期交还链。审查调用遵守审批自身的 abort 信号。

<a id="durable-record"></a>
## 持久记录

每次认领在 waterfall claim 之前追加一条 log-only `guardian/review` 事件（`{ decision, rationale（≤400 字符）, toolName, callId? }`），因此服务拥有的 `approval/asked` + `approval/decided` 审计对总伴有自动结算的原因。交还不记录任何内容。包 invariant 在加载与实时追加时校验记录形状与上限。

<a id="model-experience"></a>
## Model Experience

None，因为 guardian 的审查调用是会话不可见的辅助模型请求。被审查 agent 的请求流不变：模型可见的唯一差异是哪些工具执行不再有人工停顿。

#### KV Cache 影响

独立行为：辅助请求不与会话共享前缀，guardian 绝不向会话追加内容。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **不重建转录** —— 审查提示携带最新用户意图、工具名与提问原因，而非近期工具调用转录；若审查质量不足，Codex 式紧凑转录 guardian 是后续工作。
- **无工具范围限定** —— guardian 平等地审查每个 on-request 审批；配置级 allow/deny 工具模式集推迟到有部署需要时。
- **无快照路径** —— 审批流尚无 keyless 快照场景；覆盖由真实 waterfall spec 与 Loader 组合测试承担。

### 开发备注

- 设计与契约：[Agent Note：守护审批应答器](../../../.agents/notes/implemented/feature/2026-08-22-guardian-approval-answerer.zh.md)。
