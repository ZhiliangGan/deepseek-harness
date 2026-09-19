# Structured-output contracts

English | [中文](structured-output.zh.md)

Types of the structured-output domain: the armed contract, the durable settlement, and the live decision. The [structured-output Agent Note](../../.agents/notes/implemented/feature/2026-08-22-structured-output-contracts.md) owns the enforcement decisions; this page records the exact fields from [`packages/structured-output/structured-output/src/types.ts`](../../packages/structured-output/structured-output/src/types.ts).

## The contract

One contract asks the conversation's final reply to be a single JSON object or array satisfying a JSON Schema (the `dsh-tools` supported subset). The retry budget counts rejections that may each steer one extra attempt.

```ts type-equiv
/** The contract governing one validation cycle. */
interface StructuredOutputContract {
  /** The JSON Schema (dsh-tools supported subset) the final reply must satisfy. */
  readonly schema: JsonSchemaNode
  /** Rejections that may steer one extra attempt after the first try. */
  readonly maxRetries: number
}
```

## Durable events

Arming appends the whole contract; the latest armed record governs until the next outcome settles its turn.

```ts type-equiv
/** Durable record of one armed contract, appended at arm time. */
interface StructuredOutputArmed {
  readonly schema: JsonSchemaNode
  readonly maxRetries: number
}
```

Settlement carries exactly one of a validated value or bounded violations; `attempts` counts every validation of the turn including the settling one.

```ts type-equiv
/** Durable record of one turn's validation settlement. */
interface StructuredOutputOutcome {
  /** The turn whose final reply was validated. */
  readonly turn: number
  /** Whether the final reply parsed and satisfied the schema. */
  readonly valid: boolean
  /** Total validation attempts made (1 before any retry). */
  readonly attempts: number
  /** The parsed JSON value, present exactly when {@link valid} is true. */
  readonly value?: unknown
  /** Bounded violation explanations, present exactly when {@link valid} is false. */
  readonly violations?: readonly string[]
}
```

## Live decision

The scoped `structured-output/decided` event fires beside every settlement; its payload is the outcome minus the violations.

```ts type-equiv
/** Live decision notification after one turn's validation settles. */
interface StructuredOutputDecided {
  /** The turn whose final reply was validated. */
  readonly turn: number
  /** Whether the final reply parsed and satisfied the schema. */
  readonly valid: boolean
  /** Total validation attempts made (1 before any retry). */
  readonly attempts: number
  /** The parsed JSON value, present exactly when {@link valid} is true. */
  readonly value?: unknown
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxstructuredoutput--structuredoutputservice"></a>

### `ctx.structuredOutput` — `StructuredOutputService`

Enforce structured-output contracts on agent turns.

```ts cordis-catalog
/**
 * Arm one contract for the agent's next completing turn, replacing any
 * pending arm and overriding the standing contract for that turn.
 * @param agent - the exact live agent whose next turn validates.
 * @param request - the schema and an optional retry budget override.
 */
arm(agent: Agent, request: { schema: unknown; maxRetries?: number }): void
```

Types: [Agent](core.md)

Source: [`packages/structured-output/structured-output/src/index.ts`](../../packages/structured-output/structured-output/src/index.ts)

<a id="structured-output-events"></a>

### `structured-output/*` events

<a id="structured-outputdecided--emit"></a>

#### `structured-output/decided` — emit

One turn's structured-output validation settled (valid value or exhausted retries), after its durable `structured-output/outcome` event committed.

```ts cordis-catalog
/**
 * One turn's structured-output validation settled (valid value or
 * exhausted retries), after its durable `structured-output/outcome` event
 * committed.
 * @param payload.agent - the agent whose turn was validated.
 * @param payload.turn - the validated turn.
 * @param payload.valid - whether the final reply parsed and satisfied the schema.
 * @param payload.attempts - total validation attempts made (1 before any retry).
 * @param payload.value - the parsed JSON value; absent when invalid.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode emit
 */
'structured-output/decided'(this: Scoped<Agent>, payload: StructuredOutputDecided & { agent: Agent }): void
```

Types: [Agent](core.md) · [Scoped](scope.md)

Source: [`packages/structured-output/structured-output/src/index.ts`](../../packages/structured-output/structured-output/src/index.ts)
<!-- END GENERATED cordis-surface -->
