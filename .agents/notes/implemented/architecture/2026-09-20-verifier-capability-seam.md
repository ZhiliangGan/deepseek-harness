# Agent Note: The verifier capability seam

Status: implemented

English | [中文](2026-09-20-verifier-capability-seam.zh.md)

## Problem

Test-time-scaling patterns that raise answer quality — best-of-n selection, evaluator-driven iteration, tree search — all share one missing primitive on DeepSeek Harness: an independent evaluator. The goal and ralph packages explicitly defer "an independent evaluator with evaluator-driven continuation" to a separate policy layer, and no package could answer "is this candidate output correct for this task?" without the model grading its own homework. Snell-style optimal test-time compute splits into parallel sampling (already expressible through workflow `parallel()`), sequential refinement (ralph, goal rounds), and verifiers — the third axis had no seam at all.

## Decision

One capability seam under a new `packages/verifier/` group, following the capability-seams roles:

- **`dsh-verifier`** is Service Definition and implementation folded into one package (like `ctx.llm` itself): `ctx.verifier.review({ task, subject, criteria?, session, signal? })` makes one auxiliary `ctx.llm.stream` judge call at `temperature: 0` and returns one bounded `{verdict: pass|fail|uncertain, score, rationale, judge}`. Every unusable outcome — malformed reply, tool-call reply, timeout, abort, transport error — settles fail-closed as `uncertain` naming the failure; the service never returns a `pass` it cannot support.
- **`dsh-tool-verifier`** is the model-facing Consumer: the `verify_output` tool verifies the agent's latest answer text by default (a tail scan of the durable log, the same source structured-output reads), so self-checking a drafted answer costs one call.

Three scope decisions keep the seam minimal:

1. **No durable `verifier/review` session event.** The guardian appends `guardian/review` because its verdict has no other durable carrier; a verifier verdict reaches the conversation as a `tool/result` surface event, which the log already records. A session event (and its catalog, invariant companion, and SDK projection churn) waits for a consumer that reads verdicts outside the conversation — goal-round certification is the deferred candidate.
2. **Judge calls reuse the `guardian-review` purpose.** The purpose union is provider-neutral classification for auxiliary calls; nothing keys off verifier-specific policy today, and the capability-seams note's "don't split preemptively" applies. Split the value when an adapter needs verifier-specific transport policy.
3. **No provider role yet.** Every verifier runs on `ctx.llm`; a rule-based or remote judge provider is the split trigger.

The same landing ships the seam's first orchestrations as content, not code: `dsh-skill-reasoning` carries program-first and decompose-first disciplines plus best-of-n and tree-search `workflow` scripts, and `dsh-session-budget` guards the spend those patterns invite. The sampling skills embed their judge as a prompt prefix inside workflow scripts because workflow `agent()` options do not expose `SubagentStartRequest.persona`; when persona exposure lands, the scripts can adopt it without a seam change.

## Alternatives considered

- **A `tool-bestof` package embedding fixed scripts** (the ralph shape) — rejected for the first landing: the `workflow` tool already executes arbitrary scripts, so a skill that teaches the pattern needs no new package surface, and per-question tuning (candidate count, selection rule) lives in script arguments instead of Config fields. Promote to a package when a deployment needs an immutable, deployment-owned sampler.
- **Extending goal or ralph with an evaluator** — rejected: both READMEs defer evaluation to a separate policy layer; baking a judge into either couples the loop drivers to one judge route.
- **An LLM-judge inside the agent loop** (a `turn-stopping` verdict on every turn) — rejected: always-on judging doubles spend on ordinary turns; the seam lets consumers choose where verification pays.
- **Structured-output reuse** (arm a schema so the model self-reports a verdict) — rejected: that validates reply shape, not answer correctness; the verifier's value is independence from the author.

## Consequences

- The base bundle ships both packages enabled with the product-default judge route (`deepseek-official` / `deepseek-flash`), so every base-backed profile exposes `verify_output`; the follow-up enabling decision, taken with the session-budget and skill-reasoning rows, trades snapshot drift (re-record owed alongside the pre-existing tool-notes drift) for shipped capability.
- Verdicts are durable only as tool results; session-query consumers filter on `verify_output` tool calls rather than a dedicated event until a cross-conversation consumer exists.
- The judge route is deployment config, so a cheap fast model can serve high-volume BoN selection while sessions chat on a stronger route.
- `packages/verifier/` is a new group with its own README; the group links the LLM streaming subsystem page because the judge rides that seam.
