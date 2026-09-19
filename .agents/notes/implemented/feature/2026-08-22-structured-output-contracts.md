# Agent Note: Structured-output contracts

Status: implemented

English | [中文](2026-08-22-structured-output-contracts.zh.md)

## Problem

Embedding callers (CI, pipelines, SDK consumers) need the agent's final reply as machine-usable JSON, not free prose. The harness already validates JSON Schemas in two narrow places — tool outputs and workflow children ([workflow worker runtime](../../../../packages/workflow/workflow-worker-thread/src/runtime.ts) applies `assertObjectJsonSchema` per child) — but nothing shapes the reply of a whole conversation, and the LLM seam exposes no provider-native structured-output mode (`LlmCallConfig` carries provider/model/sampling only). OpenAI's Codex SDK answered the same need with a per-turn `outputSchema` on `thread.run`.

## Decision

One package, [`packages/structured-output/structured-output/`](../../../../packages/structured-output/structured-output/README.md), exposing `ctx.structuredOutput`. Enforcement lives entirely on documented extension points — no agent-loop change:

- **Arming** appends one durable `structured-output/armed` event (schema plus resolved retry budget) and injects the contract instruction (`agent.inject`, form `instructions`). A standing schema in plugin config covers every root-agent turn; `arm(agent, { schema })` covers the next completing turn and is consumed by it.
- **Validation** rides `agent/turn-stopping` — the serial stop-boundary extension point whose documented contract is exactly "a listener that objects steers and the machine re-reads its inbox". The turn's final assistant text comes from the durable log; one JSON document is extracted (whole-text parse, one stripped code fence, first balanced object/array in prose — string-aware scanning) and validated with `validateJsonSchemaValue` from `dsh-tools`, the same supported subset tools and workflow already enforce.
- **Retry** steers one `notice`-form message with bounded violations (three entries, 200 chars each) while `maxRetries` lasts; settlement appends `structured-output/outcome` (`{ turn, valid, attempts, value? | violations? }`) and emits the live `structured-output/decided`. A text-less turn (empty, cancelled) is left unenforced and the contract stays armed.

The SDK surfaces it as an optional `outputSchema` on `session/prompt`: the server arms the optional service before `followup` (compositions without the plugin fail loud on the parameter), and the settlement rides the existing `session.event` notification stream — no new result shape.

## Alternatives considered

### Why turn-stopping, not provider-native JSON mode

DeepSeek's `json_object` mode constrains every request it rides, not one reply of a tool-using conversation; setting it per-step would forbid tool calls mid-turn, and the final reply is only identifiable at the stop boundary. Prompt-side instruction plus boundary validation is provider-neutral, works unchanged across providers, and composes with the existing schema validator. The `responseFormat` seam remains open if a provider adds turn-scoped structured outputs.

### What a contract is not

It is not a type-guaranteed function call. A settlement may be `valid: false` (budget exhausted); callers read the outcome event and decide. The model sees the schema as an instruction, and extraction deliberately accepts fenced or prose-wrapped documents rather than demanding bare JSON — enforcement validates the value, not the formatting.

## Consequences

- `structured-output/armed` / `structured-output/outcome` join `SessionEventMap` (merge-extensible; no `SESSION_FORMAT_VERSION` bump); the invariant companion revalidates every valid outcome against its governing schema on load and live append.
- The jsonrpc-agent example composes the plugin, so its SDK deployment accepts `outputSchema`; dsh-base does not (opt-in for embedding deployments, unlike the universally useful notes/todo tools).
- Retry attempt counts are process-local (documented in the package README); the durable stream records settlements, not in-flight counts.

## Verification

- `packages/structured-output/structured-output/tests/` — real-loop enforcement against a scripted in-process adapter (steer-retry, fences, prose extraction, exhaustion, one-shot consumption, standing re-arm dedupe), pure extraction, Loader composition, and stream invariants; 100% per-file coverage under the CI gate.
- `packages/sdk/server/tests/plugin-apply.spec.ts` — `outputSchema` end-to-end over the wire with and without the plugin composed.
- `examples/headless-agent/tests/headless.snapshot.ts` — keyless `structured-output` snapshot: rejected prose steers one retry, the turn settles valid with the parsed value asserted in the session log.
