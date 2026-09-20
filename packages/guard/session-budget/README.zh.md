---
description: "按会话限制轮数与累计 token 的预算守卫，供选择、配置或排查该插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-budget

[English](README.md) | 中文

## 概述

本包限定单个会话的最多开销。轮数上限会在超额轮次发起第一次模型请求之前将其拒绝；token 上限在累计「未缓存输入 + 输出」达到限额后停止新工作；两条上限还会在轮次停止边界取消当前轮，使 goal 轮次这类链式续跑无法越过预算。两项检查都读取持久状态，因此按会话生效且重启后依然成立。`dsh` base 组合默认启用该插件，限额为失控保护默认值：256 轮（与 goal 轮次上限对齐）与 400 万累计 token。

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

当会话开销必须由组合层兜底时启用本守卫——无人值守运行、定时跟进、重度采样工作，或任何应在已知成本处停下的 agent。由人掌握预算的交互式会话可跳过。

### 启用插件

随附 base 组合以 `disabled: true` 携带该行；通过 overlay 行（`$DSH_HOME/cordis.patch.yml` 或 `--patch <file>`）启用：

```yaml
- id: session-budget
  config:
    maxTurns: 40            # 0 disables the turn cap
    maxSessionTokens: 400000  # 0 disables the token cap; uncached input + output
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxTurns` | `0` | 每会话最大轮数；超出上限的轮次在不产生 step 的情况下被拒绝 |
| `maxSessionTokens` | `0` | 累计「未缓存输入 + 输出」token 达到该值后停止新工作 |

至少一个上限必须大于 0——什么都不设限的守卫会在启动时以明确报错失败，负数与小数限额同样如此。生成版[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-budget)记录了全部可接受的取值。

### 得到什么

设 `maxTurns: 40` 时，第 1 至 40 轮正常运行；第 41 轮会开轮并直接闭轮，不发起模型请求；第 40 轮的停止边界会以落盘的 `{kind: 'hook'}` 取消原因终止链式续跑。设 `maxSessionTokens` 时，持久累计用量一旦达到上限即发生同样行为；进行中的那一轮会跑完（超出量以一轮为界），后续 followup 被拒绝。被拒绝轮次认领的输入不落盘即被丢弃，被拒消息不产生任何开销。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释守卫如何执行两条上限；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计哲学

- **先拒后取消。** `agent/pre-step` 在超额轮的第一步即拒绝（无模型请求、输入不落盘）；`agent/turn-stopping` 在收尾轮满足上限时取消——这是文档指定的 runaway 轮次兜底生命周期点。穿过取消再混入的 followup 由下一次 pre-step 拒绝兜住。
- **只读持久状态。** 轮数上限读取 loop 提议的轮号；token 上限读取 `tokenUsage` 会话投影（`ctx.sessionProjections.snapshot(session, ['tokenUsage'])`），因此两项检查重启后依然成立，没有进程本地计数器。
- **不打断进行中的轮次。** token 检查只拒绝轮次的第一步（`step === 1`）；拒绝续跑 step 会让工具结果悬空，因此超出量以一轮为界。
- **加载即大声失败。** 两项限额在 `apply` 中校验；全零配置、负数、小数都会抛错。

### token 计量

token 上限只计 `uncachedInputTokens + outputTokens`——provider 实际新处理的 token。缓存读写不计入：长会话每轮请求都会重读自身上下文，计入会使上限随会话长度二次增长，而不是度量开销。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` 校验、失败即报、两个监听器 |
| — | 未发布运行时不变量伴随件；守卫不持有持久状态——轮号来自 loop，用量来自 token-meter 投影，各自持有自己的不变量。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时阅读这些页面。它们从守卫消费的生命周期事件讲到它读取的投影。

- [Agent loop README](../../core/agent-loop/README.zh.md) —— step 与轮次生命周期、pre-step 拒绝语义，以及本守卫填补的预算空白说明。
- [生成版配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-budget) —— 全部可接受配置字段及其声明来源。
- [guard 组地图](../README.zh.md) —— 兄弟守卫包与 loop 卫生家族。

-----

<a id="model-experience"></a>
## 模型体验

### 被拒绝的超额轮次

#### 模型看到什么

什么都没有。被拒绝的轮次从不产生模型请求；被认领的输入不落盘即结束，轮次无 step 闭轮，不新增工具 schema、提示或提醒。

#### token 影响

零——拒绝完全先于请求。

#### KV 缓存影响

无；不发起请求。

### 被取消的停止边界

#### 模型看到什么

没有附加消息。loop 以 `{kind: 'hook'}` 原因 `session-budget: session … reached its … limit` 持久记录 `turn/end`，体现在会话日志与 UI 历史中，而非模型上下文。

#### token 影响

守卫自身不产生任何额外 token。

#### KV 缓存影响

无；取消不产生请求内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义守卫何时不合用。它们是当前包约束，不是任务 backlog。

- **token 超出量以一个进行中的轮次为界** —— 达到上限时已在 step 的轮会跑完；只有其后的工作被拒绝。
- **按会话，不按 agent 树** —— subagent 会话独立计预算；父会话的上限不含子代理开销。
- **被拒输入不落盘即丢弃** —— 耗尽后到达的 followup 产生一个无持久用户消息的空轮；UI 显示一个闭合轮而非错误回复。
- **缓存流量不计入** —— 主要按缓存读写计费的部署应据此调整 `maxSessionTokens`；上限度量的是处理工作量，不是账单总额。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
