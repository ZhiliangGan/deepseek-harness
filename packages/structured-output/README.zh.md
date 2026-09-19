# structured-output/ — 结构化输出能力族

English | [中文](README.md)

结构化输出契约：一个约束对话最终回复的 JSON Schema，在 agent turn 生命周期上执行。

| 包 | 角色 | ctx key |
|---|---|---|
| [`structured-output/`](structured-output/README.md) | 挂载契约、校验最终回复、steer 重试 | `ctx.structuredOutput` |

子包 README 拥有挂载、执行、事件与配置契约。
