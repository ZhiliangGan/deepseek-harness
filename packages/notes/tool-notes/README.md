---
description: "The model-facing persistent working-notes tools over the DeepSeek Harness session log: five durable tools, single-session ownership, and the notes projection, for users and maintainers choosing, configuring, or debugging the tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-notes

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

The model-facing persistent working-notes tools: durable free-form state the agent writes during work and re-reads after context loss.

<a id="table-of-contents"></a>
## Table of Contents

- [Summary](#summary)
- [What it does](#what-it-does)
- [Single owner](#single-owner)
- [Configuration](#configuration)
- [Validation](#validation)
- [Rendering](#rendering)
- [Session projection](#session-projection)
- [Export shape](#export-shape)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="what-it-does"></a>
## What it does

Registers five tools on `ctx.tools`:

- `list_notes()` — the current note set: id, first-line preview, size, revision, in first-creation order.
- `read_note(id)` — one note's full content.
- `write_note(id, content)` — create or wholly replace one note.
- `append_note(id, text)` — append one line, creating the note when absent.
- `delete_note(id)` — remove one note.

Each mutation appends one `notes/change` event to the calling agent's session log — an upsert carries the whole post-change note (whole-value rule, like `todo/write` and `goal/change`); a delete carries the id. Replay is last-wins per id. Because the durable log owns the state, notes survive context compaction and process restarts: after compaction the model re-reads notes through the tools instead of trusting its memory of them.

A note id is a lower-kebab-case slug of 1–64 characters chosen by the model (for example `decisions`, `verify-steps`); ids are vocabulary, not opaque identifiers.

<a id="single-owner"></a>
## Single owner

The note set belongs to the ONE agent session that called the tool. There is no shared scope: a non-agent caller (no `exec.agent`) has nowhere to write and is rejected. Subagents own their own sessions and therefore their own note sets.

<a id="configuration"></a>
## Configuration

`maxNotes` (default 64) caps the note count per session; `maxNoteChars` (default 8000) caps one note's complete content in UTF-16 code units. A create beyond the count or any text beyond the length fails loud with a stable error — no truncation, because the durable snapshot must equal what the model believes it wrote. `append_note` bounds the complete resulting note, not just the appended text.

The durable-log invariant does NOT follow the caps: a log written under a looser deployment must still replay after the policy tightens, so the invariant checks only structural and cross-event relations (id shape, non-empty content, revision chains, timestamp stability).

<a id="validation"></a>
## Validation

Beyond the schema's type/required checks, `execute` rejects a malformed id (uppercase, digits first, double or trailing hyphens, over 64 chars), all-whitespace text, unknown ids on `read_note`/`delete_note`, and capacity overruns. Every rejection happens before the durable append, so a rejected call never reaches the log.

<a id="rendering"></a>
## Rendering

Canonical results are compact deterministic acknowledgements (`{ id, revision, chars, created }`, summaries for `list_notes`, full content for `read_note`); their Native renderers return one stable line each. Model-facing outputs deliberately carry no timestamps, so transcripts stay deterministic. Timestamps live in the durable `notes/change` event for UIs.

<a id="session-projection"></a>
## Session projection

When the composition mounts `ctx.sessionProjections` ([`@deepseek-ai/dsh-session-projection`](../../session/session-projection/README.md)), this package registers the `notes` projection unit under an injected child: `init` = `null` (no change yet), `apply` = the whole-value fold in first-creation order (a delete of an absent id returns the same state reference), `view` = identity, `stateVersion` = 1. The key merges into `SessionProjectionMap` in [`src/types.ts`](src/types.ts); compositions without the registry are unaffected.

<a id="export-shape"></a>
## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated [`list_notes`, `read_note`, `write_note`, `append_note`, `delete_note` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-notes). The writing descriptions state the survival contract verbatim: notes persist in the session log and survive context compaction and restarts, unlike the conversation itself.

##### Verbatim survival clause (part of `write_note`/`append_note` descriptions)

```markdown
Notes persist in the session log — they survive context compaction and restarts, unlike the conversation itself.
```

#### Token effect

Fixed schema cost on every request where the tools are visible. Note content itself is zero-direct: it costs tokens only when the model reads a note back.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from these schemas.

### Tool-call history and results

#### What the model sees

Each call's arguments stay in history until compaction; acknowledgements are one deterministic line each (`Wrote note "id" (revision R, C chars).`, `Appended to note …`, `Deleted note "id".`, `N note(s): a, b`, `Note "id" (revision R): <content>`). Stable failures are `Error: invalid note id …`, `Error: unknown note id "…"; call list_notes for the current ids`, the capacity errors of § Configuration, and `Error: <tool> requires an owning agent session`. The durable `notes/change` events are UI and replay state, not a second model message.

#### Token effect

Token growth scales with what the model writes and reads back; the results are bounded by the caps of § Configuration.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No cross-session notes** — the note set is scoped to one session log; memories across sessions are a separate capability (session-external storage), not this package.
- **No note search** — the model browses by id and preview; full-text search over notes belongs to `dsh-session-query`'s retrieval surface if a need appears.
- **No compaction-end reminder** — the tools' descriptions carry the survival contract, but nothing injects a post-compaction notice listing current note ids; that hook belongs to the compaction seam if long-horizon sessions prove to need it.

### Dev Note

- Design and invariants: [Agent Note: persistent model working notes](../../../.agents/notes/implemented/feature/2026-08-22-persistent-model-working-notes.md).
