---
description: "验证器服务：一次辅助 LLM 裁判调用按任务审查候选输出并返回有界的 pass/fail/uncertain 结论，供挂载它的用户与扩展它的维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-verifier

[English](README.md) | 中文

## 概述

本包提供 `ctx.verifier`：一次辅助模型调用按任务与可选验收标准审查候选输出，返回结论（`pass`/`fail`/`uncertain`）、0–1 置信分与理由。所有不可用的裁判回复——畸形 JSON、工具调用、超时、中止、传输错误——都以 `uncertain` 失败关闭并指明原因；服务绝不声称自己无法支撑的 `pass`。模型侧消费者是 `dsh-tool-verifier`；`dsh` base 组合默认启用两者，判路与聊天共用产品默认路由。

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

当答案应在模型定稿前被独立核验时，同时挂载服务（含裁判路由）与工具。

### 挂载服务与工具

```yaml
- id: verifier
  config:
    judgeProvider: deepseek-official
    judgeModel: deepseek-v4-flash
    maxOutputTokens: 512   # output-token cap for one judge reply
    timeoutMs: 30000       # wall-clock budget; expiry settles the review 'uncertain'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `judgeProvider` | 必填 | 服务裁判调用的 provider 路由 |
| `judgeModel` | 必填 | 服务裁判调用的模型 |
| `maxOutputTokens` | `512` | 单次裁判回复的输出 token 上限 |
| `timeoutMs` | `30000` | 单次裁判调用的墙钟预算 |

缺失裁判路由会在插件加载时以明确报错失败。生成版[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-verifier)记录了全部可接受的取值。

### 得到什么

挂载后，模型可在定稿前调用 `verify_output`；一次辅助裁判调用以普通工具结果返回结论，而工具结果本就由持久日志记录。编程侧消费者直接调用 `ctx.verifier.review({ task, subject, criteria?, session, signal? })`——Best-of-N 选择器、goal 轮次认证器、workflow 评分器用的都是同一服务。

### 可观察的成功与失败

可用的裁判回复原样返回结论并附带裁判路由。畸形回复、工具调用回复、超时、中止或传输错误返回 `uncertain`，分数 `0.5`，理由指明失败原因——审查总会结算，调用方能看到为何没有结论。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释裁判调用的构造与边界；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计哲学

- **失败关闭，必然结算。** `review()` 把所有裁判失败捕获为带失败原因的 `uncertain`。在坏掉的裁判上返回 `pass` 的验证器比没有验证器更糟。
- **单一裁判协议，严格解析。** 裁判调用是一次性 `ctx.llm.stream`，固定系统提示、`temperature: 0`；回复必须是单个 JSON 对象（整文、剥一层代码栅栏、再取散文中首个平衡对象三级尝试），verdict 合法、score 为 0–1 有限数、rationale 非空。
- **不持有独立持久事件。** 结论经消费者的工具结果进入会话，`tool/result` 已是持久表面历史；独立的 `verifier/review` 会话事件推迟到出现会话外读取结论的消费者再做。
- **固定边界，同 guardian。** 任务 2000、标准 1000、候选 8000、理由 400 字符——提示交换边界而非部署调参；超长输入头部截断并带省略标记。

### 裁判调用形态

`GenerateOptions` 沿用 guardian-approval 先例：config 的 provider/model、一条 source 为 `{kind: 'plugin', plugin: 'dsh-verifier'}` 的用户消息、`purpose: 'guardian-review'`、被审会话的 `sessionId`，以及把调用方中止与 `timeoutMs` 合并的 `deadline()` 信号。含任何 tool-call 块的回复不可用。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务本体：`Config`、裁判提示组装、严格结论解析、失败关闭审查 |
| [`src/types.ts`](src/types.ts) | 领域词汇：审查请求、审查结果、结论联合类型 |
| — | 未发布运行时不变量伴随件；服务不持有持久状态——结论经由消费者的 `tool/result` 事件呈现，其不变量由工具管线持有。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时阅读这些页面。它们从裁判所乘的 LLM 接缝讲到呈现结论的消费者。

- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md) —— 裁判调用使用的 `ctx.llm` 适配器接缝与 `GenerateOptions`。
- [tool-verifier 包](../tool-verifier/README.zh.md) —— 模型侧 `verify_output` 消费者。
- [guardian-approval 包](../../interaction/guardian-approval/README.zh.md) —— 本服务沿用的裁判调用先例。

-----

<a id="model-experience"></a>
## 模型体验

间接经由消费者的 `verify_output` 工具：工具 schema 加入提示组装，结论以工具结果返回。

#### KV 缓存影响

裁判调用是不进入会话前缀的辅助请求；工具结果追加在可复用请求前缀之后，不会使既有 KV 缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义服务不做什么。它们是当前包约束，不是任务 backlog。

- **没有持久 `verifier/review` 会话事件** —— 结论仅以消费者工具结果的形式持久；会话事件待首个在会话外读取结论的消费者出现（goal 轮次认证是延后候选）。
- **裁判调用复用 `guardian-review` purpose** —— DeepSeek 侧传输元数据无法区分验证器与 guardian 调用；当适配器需要验证器专属策略时再拆分该 purpose 值。
- **单裁判，无评审团** —— `review()` 是单次调用；多裁判投票在调用方组合（并行 `review`），不在服务内。
- **提示输入边界固定** —— 常规审查超过 8000 字符文档的部署会得到截断的候选；有证据再提高边界，而不是加配置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
