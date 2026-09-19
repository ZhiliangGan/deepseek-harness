---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-19-structured-output-notes-guardian-events

[English](2026-09-19-structured-output-notes-guardian-events.md) | 中文

## 概述

新增四个仅入日志的会话事件，分别来自 structured-output、notes 与 guardian-approval 三个包：结构化输出校验的契约装配与结算、整值笔记快照、守护评审的持久记录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-19-structured-output-notes-guardian-events
baseline: false
changes:
  - root: "event:guardian/review"
    previous: null
    after: "bf0eecf5245d94b2805460f0570f72ceddab0849dc17510dc035ab1db58cd802"
    decision: same-version
  - root: "event:notes/change"
    previous: null
    after: "3486d3e08e5052dc2916b3527ed51cfe4bd18b55ba2617e99e025dae79647cfa"
    decision: same-version
  - root: "event:structured-output/armed"
    previous: null
    after: "903b35215976a648b06fb4a9e244da923a4e973ea88207692410a3a347aefcc9"
    decision: same-version
  - root: "event:structured-output/outcome"
    previous: null
    after: "370d64b59c1575bf0a7f60767f399f8f7005f0dff67ad1d893ad779cd2530344"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

同一 Session 格式版本下的新根。既有日志不含这些事件、保持有效；早于它们的读取方按 required-on-read 规则拒绝携带日志，这是所有此类事件的共同行为。structured-output/armed 与 structured-output/outcome 仅由 structured-output 插件追加（边界校验后结算），notes/change 仅由笔记工具追加（整值快照、回放取最新），guardian/review 仅由守护应答器追加；均不对模型可见。

<a id="verification"></a>
## 验证

pnpm vitest run packages/structured-output packages/notes packages/interaction/guardian-approval：125 个测试通过；apps/cli headless expected 回放以 keyless 方式覆盖 notes-tools 与 structured-output 场景。

<a id="dev-note"></a>
## 开发备注

无。
