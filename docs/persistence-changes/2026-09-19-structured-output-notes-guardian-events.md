---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-19-structured-output-notes-guardian-events

English | [中文](2026-09-19-structured-output-notes-guardian-events.zh.md)

## Summary

Adds four log-only session events from the structured-output, notes, and guardian-approval packages: the armed contract and settled outcome of structured-output validation, whole-value note snapshots, and the guardian's durable review record.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

New roots in the same Session format version. Existing logs contain none of these events and stay valid; readers that predate them refuse a log carrying one, as every required-on-read event does. structured-output/armed and structured-output/outcome are appended only by the structured-output plugin (settlements after boundary validation), notes/change only by the notes tools (whole-value snapshots, last-wins replay), and guardian/review only by the guardian answerer; none are model-visible.

<a id="verification"></a>
## Verification

pnpm vitest run packages/structured-output packages/notes packages/interaction/guardian-approval: 125 tests passed; apps/cli headless expected replays cover notes-tools and structured-output scenarios keylessly.

<a id="dev-note"></a>
## Dev Note

None.
