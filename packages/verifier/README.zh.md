---
description: "验证器能力家族的包地图：ctx.verifier 裁判服务与模型侧 verify_output 消费者，供组合它们的用户与扩展该接缝的维护者阅读。"
kind: "package-group"
---

# verifier/ — 独立核验家族

[English](README.md) | 中文

## 概述

`verifier/` 组持有一个能力：独立裁判按任务审查候选输出并返回有界结论。`verifier` 提供 `ctx.verifier` 服务——一次辅助 LLM 调用、严格结论解析、失败关闭结算；`tool-verifier` 把它以 `verify_output` 暴露给模型，使 agent 能在定稿前自查答案。`dsh` base 组合默认启用两者，判路取产品默认路由。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

两个包覆盖能力接缝的两个角色。

| 包 | 提供什么 |
|---|---|
| [`verifier/`](verifier/README.zh.md) | `ctx.verifier`：每次审查一次裁判调用，verdict/score/rationale，所有不可用结果失败关闭 |
| [`tool-verifier/`](tool-verifier/README.zh.md) | 模型侧 `verify_output` 工具；结论以普通工具结果返回 |

-----

<a id="related-documentation"></a>
## 相关文档

先读裁判所乘的 LLM 流式接缝，再读各包 README 了解挂载与契约。

- [LLM 流式子系统](../../docs/subsystems/llm-streaming.zh.md) —— 每次裁判调用使用的 `ctx.llm` 适配器接缝与 `GenerateOptions`。
- [guardian-approval 包](../interaction/guardian-approval/README.zh.md) —— 服务沿用的裁判调用先例。
- [生成版配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-verifier) —— 服务的全部可接受配置字段。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

该接缝今日是一个服务加一个消费者；第二个消费者（goal 轮次认证）或第二个提供方（规则裁判）是 capability-seams 笔记记录的拆分触发条件。本备注明确非权威——已发布行为以包 README 与代码为准。

</details>
