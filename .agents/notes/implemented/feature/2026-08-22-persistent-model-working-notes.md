# Agent Note: Persistent model working notes

Status: implemented

English | [中文](2026-08-22-persistent-model-working-notes.zh.md)

## Problem

Summarization-based compaction loses exact details — decisions with reasons, constraints, commands, verification steps. The model had no durable place to put facts it must not lose: the todo list is a whole-list checklist cleared per standing plan, and [goal](2026-06-21-subagent-capability-seam.md) state is one structured objective. Both are shaped state; neither accepts free-form working text. After compaction the only recovery path was whatever the summary happened to keep.

The gap shows up hardest in long-horizon sessions: a several-hour task crosses many compactions, and each summarization round further compresses what earlier rounds already compressed. OpenAI's Codex harness answered the same gap with model-facing `history` and `notes` tools over its token-budget window rotation: let the model persist and re-read its own working state instead of trusting lossy summaries.

## Decision

One package, [`packages/notes/tool-notes/`](../../../../packages/notes/tool-notes/README.md), owning the whole capability: five model-facing tools (`list_notes`, `read_note`, `write_note`, `append_note`, `delete_note`), one durable event kind, and one projection unit. The note set lives in the **owning session log** — each mutation appends a `notes/change` event carrying the whole post-change note (whole-value rule, the `todo/write` and `goal/change` posture) or a deletion id. Because the durable log owns the state, notes survive compaction and restarts by construction; nothing extra runs at compaction time.

Note identity is a model-authored lower-kebab-case slug (1–64 chars). Ids are vocabulary the model chooses and re-reads — deliberately not branded opaque identifiers.

### Why a single package, not a Service Definition family

The capability has exactly one storage owner (the session log) and one consumer role (the model-facing tools). There is no provider to swap and no second consumer whose evolution would justify a seam split — `tool-todo` is the direct precedent. A `notes` service extracting the fold would add a package boundary with one caller on each side. If a cross-session memory capability or a UI editing surface appears, that is the moment to revisit (see Known Limitations in the package README).

### Validation and capacity

`maxNotes` and `maxNoteChars` are validated config (defaults 64 / 8000), enforced fail-loud at the operation boundary before any durable append — never truncation, because the logged snapshot must equal what the model believes it wrote. `append_note` bounds the complete resulting note. The durable invariant checks structural and cross-event relations only (id shape, non-empty content, revision increments by exactly one, `createdAt` stability, `updatedAt` monotonicity); it deliberately ignores the caps, because a log written under a looser deployment must still replay after the policy tightens (the `tool-todo` lesson).

### Model-visible contract

The tool descriptions carry the survival clause verbatim ("notes persist in the session log — they survive context compaction and restarts"). Model-facing outputs carry no timestamps, keeping transcripts deterministic; timestamps live in the durable event for UIs. A keyless snapshot scenario (`examples/headless-agent` `notes-tools`) pins the whole path through the real one-shot app: write → append → list → read, with the persisted `notes/change` events asserted in the session log.

## Alternatives considered

**Post-compaction injection instead of tools** — a compaction-end hook re-injecting note contents into context. Rejected for v1: it couples the feature to the compaction seam, spends tokens on content the model may not need, and the tool schema already restates the affordance on every request. The injection hook remains a deferred option if long-horizon sessions prove the model forgets to look (recorded in the package README's Known Limitations).

**Whole-map snapshots instead of per-note events** — a single `notes/write` carrying every note. Rejected: appending one line to a large note set would rewrite the whole map into the log each time; per-note whole values grow the log by the actual delta while keeping last-wins replay.

**Search** — omitted; browsing by id and preview covers the scale the caps admit, and full-text retrieval belongs to `dsh-session-query` if a need appears.

## Consequences

- `notes/change` joins `SessionEventMap` (merge-extensible; no `SESSION_FORMAT_VERSION` bump) and the `notes` projection unit joins `SessionProjectionMap` (`stateVersion` 1).
- The `dsh-base` bundle composes the tools with `maxNotes: 64`, `maxNoteChars: 8000`, so every shipped profile gains the capability.
- Subagents own their own sessions, hence their own note sets; no sharing surface exists.

## Verification

- `packages/notes/tool-notes/tests/` — behavior, projection fold, real-Loader composition (config effects), durable-stream invariants; 100% per-file coverage under the CI gate.
- `examples/headless-agent/tests/headless.snapshot.ts` — keyless `notes-tools` stream/`session log` snapshot through the real app.
