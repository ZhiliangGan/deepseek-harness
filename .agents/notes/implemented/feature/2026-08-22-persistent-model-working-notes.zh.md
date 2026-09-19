# Agent Note：模型持久工作笔记

Status: implemented

English | [中文](2026-08-22-persistent-model-working-notes.md)

## 问题

基于摘要的压缩会丢失精确细节——带理由的决策、约束、命令、验证步骤。模型没有持久的地方存放不能丢失的事实：todo 列表是按 standing plan 整表清空的检查清单，[goal](2026-06-21-subagent-capability-seam.zh.md) 状态是一个结构化目标。两者都是定型状态；都不接受自由格式的工作文本。压缩之后唯一的恢复途径是摘要碰巧保留的内容。

这个缺口在长程会话中最明显：一个数小时的任务跨越多次压缩，每轮摘要进一步压缩先前轮次已经压缩过的内容。OpenAI 的 Codex harness 用同一思路回应了这个缺口——在其 token-budget 窗口轮换之上提供面向模型的 `history` 与 `notes` 工具：让模型持久化并重读自己的工作状态，而不是相信有损摘要。

## 决策

一个包，[`packages/notes/tool-notes/`](../../../../packages/notes/tool-notes/README.zh.md)，拥有完整能力：五个面向模型的工具（`list_notes`、`read_note`、`write_note`、`append_note`、`delete_note`）、一种持久事件、一个投影单元。笔记集合存放在**所属会话日志**中——每次变更追加一条 `notes/change` 事件，携带变更后的整条笔记（whole-value 规则，与 `todo/write`、`goal/change` 一致）或删除 id。因为持久日志拥有状态，笔记天然跨压缩与重启存活；压缩时无需额外动作。

笔记标识是模型选定的 lower-kebab-case 短 id（1–64 字符）。id 是模型选择并重读的词汇——刻意不做 branded 不透明标识符。

### 为什么是单包而不是 Service Definition 族

该能力只有一个存储属主（会话日志）和一个消费者角色（面向模型的工具）。没有可替换的 provider，也没有第二个消费者会演进到值得拆缝——`tool-todo` 是直接先例。抽出一个只被一个调用方使用的 `notes` 服务只会增加包边界。若将来出现跨会话记忆能力或 UI 编辑面，才是重新评估的时机（见包 README 的 Known Limitations）。

### 校验与容量

`maxNotes` 与 `maxNoteChars` 是经校验的配置（默认 64 / 8000），在操作边界、任何持久追加之前显式失败——绝不截断，因为日志快照必须与模型认为写入的内容一致。`append_note` 约束追加后的完整笔记。持久 invariant 只检查结构与跨事件关系（id 形状、非空内容、revision 恰好加一、`createdAt` 稳定、`updatedAt` 单调）；它刻意忽略容量上限，因为在宽松配置下写入的日志必须在策略收紧后仍可回放（`tool-todo` 的教训）。

### 模型可见契约

工具描述逐字携带存活条款（"notes persist in the session log — they survive context compaction and restarts"）。面向模型的输出不携带时间戳，保持转录确定性；时间戳存放在持久事件中供 UI 使用。一个 keyless 快照场景（`examples/headless-agent` 的 `notes-tools`）通过真实 one-shot 应用钉住完整路径：write → append → list → read，并在会话日志中断言持久化的 `notes/change` 事件。

## 考虑过的替代方案

**压缩后注入而非工具**——压缩结束钩子把笔记内容重新注入上下文。v1 拒绝：它把特性耦合到压缩缝，为模型可能不需要的内容消耗 token，且工具 schema 已在每个请求上重述该能力。若长程会话证明模型忘记主动查看，该注入钩子仍是保留选项（记录在包 README 的 Known Limitations）。

**整表快照而非逐笔记事件**——单条 `notes/write` 携带全部笔记。拒绝：向大笔记集合追加一行会在日志中重写整表；逐笔记整值让日志按实际增量增长，同时保持 last-wins 回放。

**搜索**——省略；按 id 与预览浏览足以覆盖上限允许的规模，若有需要，全文检索属于 `dsh-session-query`。

## 后果

- `notes/change` 加入 `SessionEventMap`（可合并扩展；不提升 `SESSION_FORMAT_VERSION`），`notes` 投影单元加入 `SessionProjectionMap`（`stateVersion` 1）。
- `dsh-base` bundle 以 `maxNotes: 64`、`maxNoteChars: 8000` 组合该工具，所有发布的 profile 都获得此能力。
- 子代理拥有自己的会话，因此拥有自己的笔记集合；不存在共享面。

## 验证

- `packages/notes/tool-notes/tests/` —— 行为、投影折叠、真实 Loader 组合（配置效果）、持久流 invariant；CI 门下 100% 单文件覆盖率。
- `examples/headless-agent/tests/headless.snapshot.ts` —— 通过真实应用的 keyless `notes-tools` 流/会话日志快照。
