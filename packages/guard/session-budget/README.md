---
description: "Session budget guard that caps turns and cumulative tokens per session, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-budget

English | [中文](README.zh.md)

## Summary

This package bounds what one session may spend. A turn cap rejects any proposed turn beyond the limit before its first model request, and a token cap stops new work once cumulative uncached-input-plus-output tokens reach the limit; both also cancel the active turn at its stop boundary, so chained continuation such as goal rounds cannot spend past the budget. Limits are per session and survive restarts because both checks read durable state. The `dsh` base bundle ships the plugin enabled with runaway-protection defaults: 256 turns (aligned with the goal round cap) and 4M cumulative tokens.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable this guard when a session's spend must be bounded from the composition — unattended runs, scheduled follow-ups, sampling-heavy work, or any agent whose loop should stop at a known cost. Skip it for interactive sessions where the human is the budget.

### Tune the limits

The base bundle ships `maxTurns: 256` and `maxSessionTokens: 4000000` — runaway backstops, not usage discipline. Raise, lower, or narrow them through an overlay row (`$DSH_HOME/cordis.patch.yml` or `--patch <file>`); at least one limit must stay greater than 0:

```yaml
- id: session-budget
  config:
    maxTurns: 40            # 0 disables the turn cap
    maxSessionTokens: 400000  # 0 disables the token cap; uncached input + output
```

| Field | Default | Meaning |
|---|---|---|
| `maxTurns` | `0` | Maximum turns per session; a proposed turn beyond the cap is rejected without a step |
| `maxSessionTokens` | `0` | Maximum cumulative uncached-input-plus-output tokens before new work stops |

At least one limit must be greater than 0 — a guard that bounds nothing fails at startup with a clear error, as do negative or fractional limits. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-budget) documents every accepted value.

### What you get

With `maxTurns: 40`, turns 1 through 40 run normally; a 41st turn opens and closes without a model request, and the stop boundary of turn 40 cancels chained continuation with a logged `{kind: 'hook'}` cause naming the limit. With `maxSessionTokens`, the same happens once durable cumulative usage reaches the cap; an in-flight turn finishes (overshoot is bounded by one turn), and followups are rejected. Input claimed by a rejected turn is dropped unlogged, so a rejected message produces no spend.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the guard enforces both caps and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Reject before spend, cancel after spend.** `agent/pre-step` rejects an over-budget turn's first step (no model request, no logged input); `agent/turn-stopping` cancels when the closing turn meets a limit, the documented lifecycle point for bounding runaway turns. A followup that slips past a cancel is caught by the next pre-step rejection.
- **Durable state only.** The turn cap reads the turn number the loop proposes; the token cap reads the `tokenUsage` session projection (`ctx.sessionProjections.snapshot(session, ['tokenUsage'])`), so both survive process restarts with no process-local counters.
- **Leave in-flight turns intact.** The token check rejects only a turn's first step (`step === 1`); rejecting a continuation step would strand tool results mid-turn, so overshoot is bounded by one turn instead.
- **Fail loud at load.** Both limits validate in `apply`; an all-zero config, a negative, or a fractional limit throws.

### Token accounting

The token cap counts `uncachedInputTokens + outputTokens` — tokens the provider actually processed as new work. Cache reads and writes are excluded because a long session re-reads its own context every request; counting them would make the cap grow quadratically with conversation length rather than measuring spend.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, the two listeners |
| — | No runtime invariant companion is published; the guard owns no durable state — it reads turn numbers from the loop and usage from the token-meter projection, each of which owns its own invariants. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the lifecycle events the guard consumes to the projection it reads.

- [Agent loop README](../../core/agent-loop/README.md) — the step and turn lifecycle, pre-step rejection semantics, and the documented budget-gap note this guard fills.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-budget) — every accepted config field and its source declaration.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

### Rejected over-budget turn

#### What the model sees

Nothing. A rejected turn never reaches a model request; the claimed input ends unlogged and the turn closes with no step, so no tool schema, prompt, or reminder is added.

#### Token effect

Zero tokens — rejection precedes the request entirely.

#### KV Cache effect

None; no request is issued.

### Cancelled stop boundary

#### What the model sees

No additional message. The loop durably logs `turn/end` with the `{kind: 'hook'}` cause `session-budget: session … reached its … limit`, visible in the session log and UI history rather than in model context.

#### Token effect

Zero additional tokens from the guard itself.

#### KV Cache effect

None; cancellation emits no request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **Token overshoot is bounded by one in-flight turn** — a turn already stepping when the cap is met finishes; only later work is rejected.
- **Per-session, not per-agent-tree** — subagent sessions are budgeted independently; a parent's cap does not include its children's spend.
- **Rejected input is dropped unlogged** — a followup that arrives after exhaustion produces an empty turn with no durable user message; the UI shows a closed turn rather than an error reply.
- **Cache traffic is excluded** — deployments billed mostly on cache reads should size `maxSessionTokens` accordingly; the cap measures processed work, not invoice totals.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
