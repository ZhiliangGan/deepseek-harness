# @deepseek-ai/dsh-guardian-approval

English | [中文](README.zh.md)

Guardian approval: an LLM-review answerer on the `approval/request` waterfall that settles on-request approvals without interrupting the human, and defers everything it cannot confidently decide.

## What it does

Registers one answerer on `ctx.approval`'s `approval/request` waterfall. When an on-request approval fires, the guardian makes one auxiliary model call (`purpose: 'guardian-review'`, the configured reviewer route) with a compact review prompt: the agent's latest user intent (bounded at 2000 chars), the tool name, and the asker's reason. The reviewer is instructed to reply with exactly `{"decision":"allow"|"deny","rationale":"…"}` (extraction accepts a surrounding code fence or prose). Then:

- **`allow`** — the guardian claims the request (`allowed-once`, the only grant the vocabulary has) after appending one durable `guardian/review` record.
- **`deny`** — the guardian claims it as `rejected`, same durable record.
- **anything else** — malformed output, unknown decision, missing rationale, a tool-call-shaped reply, timeout, abort, transport error — the guardian calls `next()` and the remaining answerer chain decides (in the shipped app: the human approval UI). The guardian never widens what an unanswered approval would do; defer-fail is toward the human, not toward a silent grant.

The review prompt's policy line is deliberately conservative: allow routine reversible work, deny consequential or irreversible risk, deny when uncertain (a denial still defers to a human who can override).

## Composition

Load order decides the chain: compose the guardian BEFORE the human answerer so routine approvals settle without a human round-trip; a later composition only sees what the guardian deferred. The plugin is opt-in — no shipped bundle composes it. It requires `ctx.llm` with a configured reviewer route.

## Configuration

`reviewerProvider` and `reviewerModel` are required (the reviewer is a deliberate deployment choice, never a default route). `maxOutputTokens` (default 256) caps one review reply; `timeoutMs` (default 30000, bounded by the platform timer ceiling) is the wall-clock budget — expiry defers to the chain. The review call honors the approval's own abort signal.

## Durable record

Every claim appends one log-only `guardian/review` event (`{ decision, rationale (≤400 chars), toolName, callId? }`) BEFORE the waterfall claim, so the audit pair `approval/asked` + `approval/decided` (service-owned) is always accompanied by the WHY of an automatic settlement. Deferrals record nothing. The package invariant validates the record's shape and bounds on load and live append.

## Model Experience

None, as the guardian's review call is an auxiliary model request the conversation never sees. The reviewed agent's request stream is unchanged: the only model-visible difference is which tool executions proceed without a human pause.

#### KV Cache effect

Independent behavior: the auxiliary request shares no prefix with the conversation, and the guardian never appends conversation content.

## Known Limitations and Deferred Work

- **No transcript reconstruction** — the review prompt carries the latest user intent, the tool name, and the ask reason, not the recent tool-call transcript; the Codex-style compact-transcript guardian is a follow-up if review quality proves insufficient.
- **No tool scoping** — the guardian reviews every on-request approval equally; a config-level allow/deny tool pattern set is deferred until a deployment needs it.
- **No snapshot harness path** — approval flows have no keyless snapshot scenario yet; coverage is the real-waterfall spec and the Loader composition test.
