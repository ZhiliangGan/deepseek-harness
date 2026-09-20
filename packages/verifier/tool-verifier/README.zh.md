---
description: "ctx.verifier 接缝上的模型侧 verify_output 工具，供挂载它的用户与调整模型可请裁判检查什么的维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-verifier

[English](README.md) | 中文

## 概述

本包是 `ctx.verifier` 能力接缝的模型侧消费者。它注册 `verify_output`：模型传入任务（以及可选的验收标准与候选），一次独立裁判审查该候选，有界结论以普通工具结果返回。未显式给候选时，工具核验 agent 最近一条回答文本，因此自查一份刚起草的答案只需一次调用。`dsh` base 组合默认将其与 `dsh-verifier` 一起启用。

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

当答案应从会话内部被独立核验时挂载本工具——定稿高风险回复前、用户要求核验时，或作为采样模式的选择步骤。

### 配置

工具自身没有配置；base 组合已将其与服务一起挂载。不想要裁判介入的部署通过 overlay 禁用这对行：

```yaml
- id: tool-verifier
  disabled: true
```

### 模型看到什么

一个新工具 `verify_output`：`task`（必填）、`subject`（默认取会话中最近一条回答文本）与 `criteria`（可选）。结果是单个 JSON 对象——`verdict`（`pass`/`fail`/`uncertain`）、`score`（0–1）、`rationale` 与裁判路由——以模型照常阅读的工具结果返回。

### 可观察的成功与失败

裁判回复原样返回结论。无可核验候选的调用（无 `subject`、无先前回答文本）以工具错误失败，裁判侧失败以 `uncertain` 结算并指明原因——失败关闭契约见 [verifier 包](../verifier/README.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具如何解析候选；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计概念

工具是薄消费者：`defineTool` 做参数校验，解析候选，然后一次 `ctx.verifier.review()` 调用。候选默认取 agent 最近一条回答文本——对持久日志的最新非空 `assistant/message` 做尾部扫描，与 structured-output 停止边界读取的是同一事实源，因此被核验的候选正是模型刚说的内容。无 agent 的直接 `ctx.tools.execute()` 调用者会大声失败：裁判调用依赖会话做路由，也没有可默认的对象。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `verify_output` 工具：schema、候选解析、服务委托 |
| — | 未发布运行时不变量伴随件；工具不持有持久状态——结论以 `tool/result` 事件呈现，其不变量由工具管线持有。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时阅读这些页面。它们从本工具消费的接缝讲到撰写兄弟工具的 cookbook。

- [verifier 包](../verifier/README.zh.md) —— 本工具消费的服务及其失败关闭契约。
- [工具 cookbook](../../../docs/cookbook/adding-a-tool.zh.md) —— 本消费者遵循的模型侧工具契约。

-----

<a id="model-experience"></a>
## 模型体验

### verify_output 工具

#### 模型看到什么

挂载期间，下方工具描述加入会话工具目录；模型像看到其他工具一样看到该 schema，并把结论当作普通工具结果。

##### 工具描述

```markdown
verify_output: Run one independent judge to verify a candidate answer against its task before you commit
to it. Pass the task and, optionally, acceptance criteria; the candidate defaults to the latest answer
text in this conversation. Use before finalizing high-stakes answers, or when the user asks for
verification or double-checking.
```

#### token 影响

挂载期间工具 schema 加入提示组装。每次调用花费一次辅助裁判请求；结论以一条简短工具结果返回。

#### KV 缓存影响

工具 schema 进入请求的工具区；结论追加在可复用请求前缀之后，不会使既有 KV 缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义工具不做什么。它们是当前包约束，不是任务 backlog。

- **核验文本，不核验产物** —— 候选是传入的 subject 或最近一条回答文本；核验文件或 diff 意味着模型将其引用进 `subject`，受服务 8000 字符候选上限约束。
- **除原始结果外没有 UI 呈现** —— 今日的呈现方与 Web 卡片从工具结果派生；专用结论卡片待产品需要。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
