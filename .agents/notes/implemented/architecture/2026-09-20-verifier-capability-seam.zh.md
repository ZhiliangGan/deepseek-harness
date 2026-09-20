# Agent Note: 验证器能力接缝

Status: implemented

[English](2026-09-20-verifier-capability-seam.md) | 中文

## Problem

提升答案质量的 test-time-scaling 模式——best-of-n 选择、评估器驱动的迭代、树搜索——在 DeepSeek Harness 上共享同一个缺失原语：独立评估器。goal 与 ralph 包都把「带评估器驱动的独立评估」显式推迟到独立策略层，而没有任何包能回答「这个候选输出对该任务是否正确」，除非模型给自己的作业打分。Snell 式最优 test-time compute 分为并行采样（workflow `parallel()` 已可表达）、序列改进（ralph、goal 轮次）与验证器——第三条轴完全没有接缝。

## Decision

在新的 `packages/verifier/` 组下建一个能力接缝，遵循 capability-seams 角色：

- **`dsh-verifier`** 是服务定义与实现合一的包（同 `ctx.llm` 本身）：`ctx.verifier.review({ task, subject, criteria?, session, signal? })` 以 `temperature: 0` 发起一次辅助 `ctx.llm.stream` 裁判调用，返回一个有界的 `{verdict: pass|fail|uncertain, score, rationale, judge}`。所有不可用结果——畸形回复、工具调用回复、超时、中止、传输错误——都以指明原因的 `uncertain` 失败关闭；服务绝不返回自己无法支撑的 `pass`。
- **`dsh-tool-verifier`** 是模型侧消费者：`verify_output` 工具默认核验 agent 最近一条回答文本（对持久日志的尾部扫描，与 structured-output 读取同一事实源），因此自查一份刚起草的答案只需一次调用。

三个范围决策保持接缝最小：

1. **不落 `verifier/review` 持久会话事件。** guardian 之所以追加 `guardian/review`，是因为它的裁决没有别的持久载体；验证器结论经 `tool/result` 表面事件进入会话，日志已有记录。会话事件（连同目录、不变量伴随件与 SDK 投影的连锁改动）待出现会话外读取结论的消费者再做——goal 轮次认证是延后候选。
2. **裁判调用复用 `guardian-review` purpose。** purpose 联合类型是辅助调用的 provider 中立分类；今天没有任何东西依赖验证器专属策略，capability-seams 笔记的「不预拆分」适用。当适配器需要验证器专属传输策略时再拆分该值。
3. **暂无提供方角色。** 所有验证器都跑在 `ctx.llm` 上；规则裁判或远程裁判是拆分触发条件。

同一落地集以内容而非代码交付该接缝的首批编排：`dsh-skill-reasoning` 携带 program-first 与 decompose-first 纪律以及 best-of-n 与树搜索 `workflow` 脚本；`dsh-session-budget` 守卫这些模式引入的开销。采样技能把裁判作为提示前缀内嵌在 workflow 脚本里，因为 workflow `agent()` 选项不暴露 `SubagentStartRequest.persona`；当 persona 暴露落地后，脚本无需改接缝即可采用。

## Alternatives considered

- **内嵌固定脚本的 `tool-bestof` 包**（ralph 形态）——首次落地不采用：`workflow` 工具本就执行任意脚本，教模式的技能不需要新包面，且按问题调参（候选数、选择规则）落在脚本参数而非 Config 字段。当部署需要不可变、部署方持有的采样器时再升级为包。
- **给 goal 或 ralph 扩评估器**——不采用：两个包的 README 都把评估推迟到独立策略层；把裁判烤进任一会把 loop 驱动器耦合到一个裁判路由。
- **agent loop 内的 LLM 裁判**（每轮 `turn-stopping` 裁决）——不采用：常开裁判让普通轮次开销翻倍；接缝让消费者选择核验在哪里划算。
- **复用 structured-output**（arm 一个 schema 让模型自报结论）——不采用：那校验的是回复形状而非答案正确性；验证器的价值在于独立于作者。

## Consequences

- base 组合以产品默认判路（`deepseek-official` / `deepseek-flash`）默认启用两个包，所有 base 系 profile 都暴露 `verify_output`；该后续启用决策与 session-budget、skill-reasoning 两行一并做出，以快照漂移（需与既有 tool-notes 漂移一并重录）换取随包能力。
- 结论仅以工具结果形式持久；session-query 消费者在出现跨会话消费者之前，按 `verify_output` 工具调用过滤而非按专有事件过滤。
- 裁判路由是部署配置，高频 BoN 选择可用便宜快模型服务，而会话聊天用更强路由。
- `packages/verifier/` 是带自有 README 的新组；组链接 LLM 流式子系统页，因为裁判乘在该接缝上。
