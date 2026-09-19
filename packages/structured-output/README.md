---
description: "The structured-output group map: one product package arming per-turn JSON Schema contracts with boundary validation and bounded retries, for users and maintainers navigating the group."
kind: "package-group"
---

# structured-output/ — structured-output capability family

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

The structured-output contract: one JSON Schema the conversation's final reply must satisfy, enforced on the agent turn lifecycle.

[Structured-output subsystem](../../docs/subsystems/structured-output.md) — armed contracts, durable settlements, and the live `structured-output/decided` event.

| Package | Role | ctx key |
|---|---|---|
| [`structured-output/`](structured-output/README.md) | Arms contracts, validates final replies, steers retries | `ctx.structuredOutput` |
The child README owns the arming, enforcement, events, and configuration contract.

<a id="table-of-contents"></a>
## Table of Contents

- [Summary](#summary)
- [Packages](#packages)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages



### Dev Note

- This group README maps the group's package; each package's contract lives in its own README and the Agent Notes under .agents/notes/.
