# @deepseek-ai/dsh-structured-output

English | [中文](README.zh.md)

Structured-output contract enforcement (`ctx.structuredOutput`): the conversation's final reply must be a single JSON object or array satisfying a JSON Schema, validated at the turn's stop boundary with steering retries until it conforms or the retry budget ends.

## What it does

Arming installs one contract for a conversation:

- **standing schema** — `schema` in plugin config validates every root-agent turn while no one-shot arm is active (a deployment-wide "this agent always replies in JSON" contract);
- **one-shot arm** — `ctx.structuredOutput.arm(agent, { schema, maxRetries? })` validates the agent's next completing turn and is consumed by it (the embedding path: the SDK's `session/prompt` `outputSchema`).

Arming appends one durable `structured-output/armed` event (the schema plus the resolved retry budget — replay reconstructs the contract) and injects the contract instruction into the conversation (`agent.inject`, source `structured-output`, form `instructions`).

At every `agent/turn-stopping` boundary — the documented extension point where a listener that objects steers and the machine runs another step — the service reads the turn's final assistant text from the durable log, extracts one JSON document (whole-text parse, one stripped code fence, or the first balanced object/array in prose), and validates it against the governing schema with `validateJsonSchemaValue` (`@deepseek-ai/dsh-tools`; the same supported subset tools and workflow structured outputs use):

- **valid** — one `structured-output/outcome` event `{ turn, valid: true, attempts, value }` and one live `structured-output/decided` notification; a one-shot arm is consumed.
- **invalid, budget remaining** — one steering message (source `structured-output`, form `notice`) carrying the bounded violations; the turn stays open and the model replies again.
- **invalid, budget exhausted** — the turn closes with `{ turn, valid: false, attempts, violations }`; the caller reads the failure from the outcome event.

A turn that produced no assistant text (empty turn, cancellation) is left unenforced; the contract stays armed.

## Single owner and scope

The contract belongs to one agent's conversation. `arm()` rejects an agent that is not the registry's live instance. Subagents and compaction summarizers run their own loops; only the owning agent's turns validate.

## Configuration

`maxRetries` (default 2) bounds rejections that may steer one extra attempt each. `maxSchemaChars` (default 16384) bounds the schema's JSON serialization at arm time. A schema that is not a JSON object, or leaves the `dsh-tools` supported subset, fails loud at load (standing) or at the `arm()` call — never mid-turn. The durable invariant checks only structural and cross-event relations (a valid outcome's value satisfies the governing schema; an invalid outcome carries violations), so a log written under a looser deployment still replays after the policy tightens.

## Model Experience

### Contract instruction

#### What the model sees

One injected context message at arm time (form `instructions`), stating the final-reply obligation and embedding the schema verbatim.

##### Verbatim contract head

```markdown
Structured-output contract: when the task completes, your FINAL assistant message must be ONLY a single
JSON object or array satisfying this JSON Schema (no prose, no code fences, no text before or after):
```

#### Token effect

Conditional: one instruction per arm (a standing contract injects once per session and re-arms silently on resume); retries add one bounded notice per rejected reply.

#### KV Cache effect

The instruction lands as queued context at the next step boundary; prefixes remain reusable. A mid-conversation arm appends, so prior request tokens stay reusable; the retry notices append per rejection.

### Retry notice

#### What the model sees

One `notice`-form message per rejected reply: `Your final reply was rejected by the structured-output contract.` plus at most three violations, each capped at 200 characters.

#### Token effect

Bounded by the violation cap; one notice per rejection while the retry budget lasts.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Provider-native JSON mode is not used** — the contract instructs and validates rather than setting a wire `response_format`; DeepSeek's `json_object` mode applies per request, not per final reply, and cannot shape one turn's last message of a tool-using conversation.
- **A standing contract injects once per session** — after compaction the instruction may sit outside the live context; the retry notice and the armed event keep the contract enforceable, and re-injection is a compaction-seam concern if long sessions prove to need it.
- **Retry attempt counts are process-local** — the durable `attempts` value in each outcome reflects the settling process; a crash mid-retry restarts the count for the reopened turn.
