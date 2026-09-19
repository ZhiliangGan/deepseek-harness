# notes/ — 持久化模型工作笔记能力族

English | [中文](README.md)

面向模型的持久笔记能力。它是单个 **product** 包，因为一个 agent 会话拥有整套笔记；没有可替换的 provider 契约。笔记存放在所属会话日志中，因此跨上下文压缩与进程重启存活。

| 包 | 角色 | ctx key |
|---|---|---|
| [`tool-notes/`](tool-notes/README.md) | 存储并暴露会话的持久笔记。 | （注册在 `ctx.tools`） |

子包 README 拥有工具、持久化与渲染契约。
