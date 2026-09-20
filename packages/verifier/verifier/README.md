---
description: "Verifier service: one auxiliary LLM judge reviews a candidate output against its task and returns a bounded pass/fail/uncertain verdict, for users mounting it and maintainers extending it."
kind: "package-reference"
---

# @deepseek-ai/dsh-verifier

English | [中文](README.zh.md)

## Summary

This package provides `ctx.verifier`: one auxiliary model call reviews a candidate output against its task and optional acceptance criteria, returning a verdict (`pass`/`fail`/`uncertain`), a 0–1 confidence score, and a rationale. Every unusable judge reply — malformed JSON, a tool call, timeout, abort, transport error — settles fail-closed as `uncertain` naming the failure; the service never claims `pass` it cannot support. The model-facing Consumer is `dsh-tool-verifier`; the `dsh` base bundle ships both enabled, with the judge riding the same default route as chat.

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

Mount the service (with its judge route) and the tool together when answers should be independently checked before the model commits to them.

### Tune the judge route

The base bundle mounts both packages with the product-default judge route (`deepseek-official` / `deepseek-flash`). Point the judge at another route or budget through an overlay (`$DSH_HOME/cordis.patch.yml` or `--patch <file>`) — a cheap fast model serves high-volume BoN selection well:

```yaml
- id: verifier
  config:
    judgeProvider: deepseek-official
    judgeModel: deepseek-v4-flash
    maxOutputTokens: 512   # output-token cap for one judge reply
    timeoutMs: 30000       # wall-clock budget; expiry settles the review 'uncertain'
```

| Field | Default | Meaning |
|---|---|---|
| `judgeProvider` | required | Provider route serving the judge calls |
| `judgeModel` | required | Model serving the judge calls |
| `maxOutputTokens` | `512` | Output-token cap for one judge reply |
| `timeoutMs` | `30000` | Wall-clock budget for one judge call |

A missing judge route fails at plugin load with a clear error. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-verifier) documents every accepted value.

### What you get

After mounting, the model can call `verify_output` before finalizing an answer; one auxiliary judge call returns the verdict as an ordinary tool result, which the durable log already records. Programmatic consumers call `ctx.verifier.review({ task, subject, criteria?, session, signal? })` directly — a Best-of-N selector, a goal-round certifier, or a workflow scorer all use the same service.

### Observable success and failures

A usable judge reply returns its verdict verbatim with the judge route attached. A malformed reply, a tool-call reply, a timeout, an abort, or a transport error returns `uncertain` with score `0.5` and a rationale naming the failure — the review always settles, and the caller sees exactly why no verdict was reached.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the judge call is made and bounded; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Fail closed, always settle.** `review()` catches every judge failure into an `uncertain` verdict with the failure in its rationale. A verifier that returned `pass` on a broken judge would be worse than no verifier.
- **One judge protocol, strictly parsed.** The judge call is a one-shot `ctx.llm.stream` with a fixed system prompt and `temperature: 0`; the reply must be one JSON object (whole-text, then one stripped code fence, then the first balanced object in prose) with a valid verdict, a finite 0–1 score, and a non-empty rationale.
- **No durable event of its own.** Verdicts reach the conversation as tool results through the Consumer, and `tool/result` is already durable surface history; a separate `verifier/review` session event is deferred until a consumer reads verdicts outside the conversation.
- **Fixed bounds, like the guardian.** Task 2000, criteria 1000, subject 8000, rationale 400 chars — prompt exchange bounds, not deployment tunables; oversized inputs are head-truncated with an omission marker.

### Judge call shape

`GenerateOptions` mirrors the guardian-approval precedent: provider/model from config, one user message with source `{kind: 'plugin', plugin: 'dsh-verifier'}`, `purpose: 'guardian-review'`, `sessionId` of the reviewed session, and a `deadline()` signal combining the caller's abort with `timeoutMs`. A reply containing any tool-call block is unusable.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The service: `Config`, judge prompt assembly, strict verdict parsing, fail-closed review |
| [`src/types.ts`](src/types.ts) | Domain vocabulary: review request, review result, verdict union |
| — | No runtime invariant companion is published; the service owns no durable state — verdicts surface through the Consumer's `tool/result` events, whose invariants the tool pipeline owns. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the LLM seam the judge rides to the Consumer that surfaces verdicts.

- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the `ctx.llm` adapter seam and `GenerateOptions` the judge call uses.
- [tool-verifier package](../tool-verifier/README.md) — the model-facing `verify_output` Consumer.
- [guardian-approval package](../../interaction/guardian-approval/README.md) — the judge-call precedent this service follows.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the Consumer's `verify_output` tool: the tool schema joins prompt assembly, and the verdict returns as a tool result.

#### KV Cache effect

The judge call is an auxiliary request that never joins the conversation prefix; the tool result appends after the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the service does not do. They are current package constraints, not a task backlog.

- **No durable `verifier/review` session event** — verdicts are durable only as Consumer tool results; a session event arrives with the first consumer that reads verdicts outside the conversation (goal-round certification is the deferred candidate).
- **Judge calls reuse the `guardian-review` purpose** — DeepSeek-side transport metadata cannot distinguish verifier from guardian calls; split the purpose value when an adapter needs verifier-specific policy.
- **One judge, no panel** — `review()` is one call; multi-judge voting composes at the caller (parallel `review` calls), not in the service.
- **Prompt-input bounds are fixed** — a deployment that regularly verifies documents larger than 8000 chars gets a truncated subject; raise the bound with evidence, not config.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
