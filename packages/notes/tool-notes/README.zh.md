---
description: "基于 DeepSeek Harness 会话日志的模型侧持久工作笔记工具：五个持久工具、单一会话归属与 notes 投影，供选择、配置或排查这些工具的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-notes

[English](README.md) | 中文

<a id="summary"></a>
## 概述

面向模型的持久工作笔记工具：agent 在工作中写入、在上下文丢失后重读的持久自由文本状态。

<a id="table-of-contents"></a>
## 目录

- [概述](#summary)
- [功能](#what-it-does)
- [单一属主](#single-owner)
- [配置](#configuration)
- [校验](#validation)
- [渲染](#rendering)
- [会话投影](#session-projection)
- [导出形状](#export-shape)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="what-it-does"></a>
## 功能

在 `ctx.tools` 上注册五个工具：

- `list_notes()` — 当前笔记集合：id、首行预览、大小、版本号，按首次创建顺序。
- `read_note(id)` — 单条笔记的完整内容。
- `write_note(id, content)` — 创建或整体替换一条笔记。
- `append_note(id, text)` — 追加一行；笔记不存在时创建。
- `delete_note(id)` — 删除一条笔记。

每次变更向调用方 agent 的会话日志追加一条 `notes/change` 事件 —— upsert 携带变更后的整条笔记（whole-value 规则，与 `todo/write`、`goal/change` 一致）；delete 携带 id。回放时按 id 取最新值。因为持久日志拥有状态，笔记跨上下文压缩与进程重启存活：压缩后模型通过工具重读笔记，而不是相信自己对它们的记忆。

笔记 id 是模型选定的 1–64 字符 lower-kebab-case 短标识（例如 `decisions`、`verify-steps`）；id 是词汇，不是不透明标识符。

<a id="single-owner"></a>
## 单一属主

笔记集合属于调用工具的那一个 agent 会话。没有共享作用域：非 agent 调用方（无 `exec.agent`）没有可写之处，直接拒绝。子代理拥有自己的会话，因此也拥有自己的笔记集合。

<a id="configuration"></a>
## 配置

`maxNotes`（默认 64）限制单会话笔记数；`maxNoteChars`（默认 8000）限制单条笔记完整内容的 UTF-16 码元数。超出数量上限的创建或超出长度上限的文本以稳定错误显式失败 —— 不截断，因为持久快照必须与模型认为写入的内容一致。`append_note` 约束的是追加后的完整笔记，而不仅是追加文本。

持久日志 invariant 不跟随这两个上限：在宽松配置下写入的日志必须在配置收紧后仍可回放，所以 invariant 只检查结构与跨事件关系（id 形状、非空内容、版本链、时间戳稳定性）。

<a id="validation"></a>
## 校验

除 schema 的类型/必填检查外，`execute` 拒绝非法 id（大写、数字开头、连续或尾部连字符、超过 64 字符）、全空白文本、`read_note`/`delete_note` 的未知 id，以及容量超限。所有拒绝都发生在持久追加之前，被拒绝的调用不会进入日志。

<a id="rendering"></a>
## 渲染

规范结果是紧凑的确定性确认（`{ id, revision, chars, created }`、`list_notes` 的摘要、`read_note` 的完整内容）；各自的 Native 渲染器返回一行稳定文本。面向模型的输出刻意不携带时间戳，让转录保持确定性。时间戳存放在持久 `notes/change` 事件中供 UI 使用。

<a id="session-projection"></a>
## 会话投影

当组合挂载 `ctx.sessionProjections`（[`@deepseek-ai/dsh-session-projection`](../../session/session-projection/README.zh.md)）时，本包在注入的子上下文中注册 `notes` 投影单元：`init` = `null`（尚无变更），`apply` = 按首次创建顺序的整值折叠（删除不存在的 id 返回同一状态引用），`view` = 恒等，`stateVersion` = 1。key 在 [`src/types.ts`](src/types.ts) 合入 `SessionProjectionMap`；未挂载注册表的组合不受影响。

<a id="export-shape"></a>
## 导出形状

函数/命名空间插件：导出 `name` / `inject` / `apply`，无默认导出。多余的 `export default` 会经 Loader 的 `unwrapExports` 折叠模块并丢失 `inject`（见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### 模型所见

模型看到生成的 [`list_notes`、`read_note`、`write_note`、`append_note`、`delete_note` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-notes)。写入类描述逐字声明存活契约：笔记存放在会话日志中，跨上下文压缩与重启存活，与对话本身不同。

##### 存活条款原文（`write_note`/`append_note` 描述的一部分）

```markdown
Notes persist in the session log — they survive context compaction and restarts, unlike the conversation itself.
```

#### Token 影响

在工具可见的每个请求上携带固定 schema 成本。笔记内容本身零直接成本：只有模型重读时才消耗 token。

#### KV Cache 影响

定义与可见性不变时前缀稳定。插件生命周期或作用域限制可能使该 schema 的复用失效。

### 工具调用历史与结果

#### 模型所见

每次调用的参数保留在历史中直至压缩；确认各为一行确定性文本（`Wrote note "id" (revision R, C chars).`、`Appended to note …`、`Deleted note "id".`、`N note(s): a, b`、`Note "id" (revision R): <content>`）。稳定失败为 `Error: invalid note id …`、`Error: unknown note id "…"; call list_notes for the current ids`、配置一节的容量错误，以及 `Error: <tool> requires an owning agent session`。持久 `notes/change` 事件是 UI 与回放状态，不是第二条模型消息。

#### Token 影响

token 增长随模型写入与重读的内容伸缩；结果受配置一节的上限约束。

#### KV Cache 影响

只追加；新可见内容跟随可复用请求前缀，不使既有 KV-cache 条目失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **无跨会话笔记** — 笔记集合限定于一个会话日志；跨会话记忆是独立能力（会话外存储），不属于本包。
- **无笔记搜索** — 模型按 id 与预览浏览；笔记全文检索若有需要属于 `dsh-session-query` 的取回面。
- **无压缩结束提醒** — 工具描述携带存活契约，但不会在压缩后注入列出当前笔记 id 的提醒；若长程会话证明需要，该钩子属于压缩缝。

### 开发备注

- 设计与 invariant：[Agent Note：持久模型工作笔记](../../../.agents/notes/implemented/feature/2026-08-22-persistent-model-working-notes.zh.md)。
