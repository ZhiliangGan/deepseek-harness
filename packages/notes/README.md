# notes/ — persistent model working-notes capability family

English | [中文](README.zh.md)

The model-facing persistent notes capability. It is a single **product** package because one agent session owns the note set; there is no replaceable provider contract. Notes live in the owning session log, so they survive context compaction and process restarts.

| Package | Role | ctx key |
|---|---|---|
| [`tool-notes/`](tool-notes/README.md) | Stores and exposes the session's persistent notes. | (registers on `ctx.tools`) |

The child README owns the tools, persistence, and rendering contract.
