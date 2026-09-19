---
description: "structured-output 组地图：一个产品包，装配每轮 JSON Schema 契约并提供停止边界校验与有界重试，供在组内导航的用户与维护者阅读。"
kind: "package-group"
---

# structured-output/ — 结构化输出能力族

[English](README.md) | 中文

<a id="summary"></a>
## 概述

结构化输出契约：一个约束对话最终回复的 JSON Schema，在 agent turn 生命周期上执行。

[Structured-output subsystem](../../docs/subsystems/structured-output.zh.md) — 契约装配、持久结算与 `structured-output/decided` 实时事件。

| 包 | 角色 | ctx key |
|---|---|---|
| [`structured-output/`](structured-output/README.zh.md) | 挂载契约、校验最终回复、steer 重试 | `ctx.structuredOutput` |
子包 README 拥有挂载、执行、事件与配置契约。

<a id="table-of-contents"></a>
## 目录

- [概述](#summary)
- [包](#packages)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包



<a id="dev-note"></a>
### 开发备注

- 分组README描述组内包的分工；各包契约由其自身README与 .agents/notes/ 中的 Agent Note 承载。
