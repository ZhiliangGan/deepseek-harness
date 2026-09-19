---
description: "The notes group map: one product package exposing the session's model-facing persistent working-notes tools, for users and maintainers navigating the group."
kind: "package-group"
---

# notes/ — persistent model working-notes capability family

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

The model-facing persistent notes capability. It is a single **product** package because one agent session owns the note set; there is no replaceable provider contract. Notes live in the owning session log, so they survive context compaction and process restarts.

[Notes subsystem](../../docs/subsystems/notes.md) — the durable notes vocabulary: whole-value `notes/change` events and the `NoteSnapshot` they carry.

| Package | Role | ctx key |
|---|---|---|
| [`tool-notes/`](tool-notes/README.md) | Stores and exposes the session's persistent notes. | (registers on `ctx.tools`) |
The child README owns the tools, persistence, and rendering contract.

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
