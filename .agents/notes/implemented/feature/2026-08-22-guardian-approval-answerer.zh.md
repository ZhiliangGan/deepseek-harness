# Agent Note：Guardian 审批 answerer

Status: implemented

English | [中文](2026-08-22-guardian-approval-answerer.md)

## 问题

On-request 审批让人类为每个未保存动作被打断：常规工作（跑测试、读文件）与真正重大的工作同样等待。OpenAI 的 Codex harness 发布了 "guardian"——一个专门的审查会话，决定 on-request 审批是否可以自动结算，任何存疑都 fail closed。dsh 已有正确的缝（`ctx.approval` 的 `approval/request` waterfall，带组合 answerer 与 fail-closed 默认），但发布中的每个 answerer 都是人类。

## 决策

一个可选包，[`packages/interaction/guardian-approval/`](../../../../packages/interaction/guardian-approval/README.md)，在 waterfall 上注册一个 answerer。没有服务、没有注册表——缝已拥有请求、审计与 fail-closed 默认。

- **审查调用**：一次辅助 LLM 调用（`purpose: 'guardian-review'`，`dsh-llm` 的 GenerateOptions purpose 联合新成员），走必填的部署配置审查路由。提示携带 agent 最新的用户意图（上限 2000 字符，跳过 plugin 来源与空行）、工具名与提问方原因。策略行刻意保守：放行常规可逆工作，拒绝重大或不可逆风险，不确定时拒绝。
- **认领**：解析出的 `allow` 认领 `allowed-once`，`deny` 认领 `rejected`——各自先追加一条 log-only `guardian/review` 事件（`{ decision, rationale ≤400, toolName, callId? }`），因此每次自动结算都在服务拥有的 `approval/asked`/`approval/decided` 审计对旁携带其原因。
- **其余一切交还**：输出畸形、未知 decision 词汇、缺 rationale、tool-call 形回复、超时（`timeoutMs`，遵守审批自身的 abort 信号）、传输错误——answerer 调用 `next()`，由其余链（人类 UI）决定。交还式失败朝向人类，绝不静默授权：guardian 可以收窄人类工作量，但绝不放宽未应答审批的边界。交还不记录任何内容。

## 考虑过的替代方案

### 为什么是 waterfall answerer 而不是策略变更

审批策略词汇（`ask`/`never`）是会话级开关；guardian 是必须与人类 answerer 及任何未来 answerer 共存的逐决策审查者。waterfall 文档化的认领或 `next()` 契约正是这个形状，加载顺序确定性地组合链（guardian 在前，人类在后）。

### 拒绝意味着什么

guardian 的 `rejected` 结束该请求，但持久 `guardian/review` 的 rationale 告诉人类原因；人类可以在 UI 中重跑该动作并批准。这与 Codex 的显式 allow/deny 姿态一致，同时保留人工覆盖路径。

## 后果

- `guardian/review` 加入 `SessionEventMap`（log-only、可合并扩展；不提升 `SESSION_FORMAT_VERSION`）；包 invariant 校验其形状与上限。
- `'guardian-review'` 扩展辅助 purpose 联合；适配器可像既有 purpose 一样映射到传输元数据。
- 没有发布 bundle 组合 guardian；想要它的部署在其人类 answerer 之前组合它。

## 验证

- `packages/interaction/guardian-approval/tests/` —— 经 `ApprovalService.request()` 的真实 waterfall 与脚本化审查适配器（认领、交还、超时、中止、上限、purpose/路由断言）、cordis.yml 的 Loader 组合与流 invariant；CI 门下 100% 单文件覆盖率。
- 审批流尚无 keyless 快照场景（记录为 Known Limitation）；在出现之前由真实 waterfall spec 与 Loader 测试承担覆盖。
