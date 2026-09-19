---
description: "notes 组地图：一个产品包，暴露会话的模型侧持久工作笔记工具，供在组内导航的用户与维护者阅读。"
kind: "package-group"
---

# notes/ — 持久化模型工作笔记能力族

[English](README.md) | 中文

<a id="summary"></a>
## 概述

面向模型的持久笔记能力。它是单个 **product** 包，因为一个 agent 会话拥有整套笔记；没有可替换的 provider 契约。笔记存放在所属会话日志中，因此跨上下文压缩与进程重启存活。

[Notes subsystem](../../docs/subsystems/notes.zh.md) — 持久笔记词汇：整值 `notes/change` 事件与其携带的 `NoteSnapshot`。

| 包 | 角色 | ctx key |
|---|---|---|
| [`tool-notes/`](tool-notes/README.zh.md) | 存储并暴露会话的持久笔记。 | （注册在 `ctx.tools`） |
子包 README 拥有工具、持久化与渲染契约。

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
