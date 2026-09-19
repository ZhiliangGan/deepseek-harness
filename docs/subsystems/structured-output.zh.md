# 结构化输出契约

English | [中文](structured-output.md)

结构化输出域的类型：挂载的契约、持久结算与实时决策。[structured-output Agent Note](../../.agents/notes/implemented/feature/2026-08-22-structured-output-contracts.zh.md) 拥有执行决策；本页记录 [`packages/structured-output/structured-output/src/types.ts`](../../packages/structured-output/structured-output/src/types.ts) 的确切字段。

## 契约

一份契约要求对话的最终回复是满足某个 JSON Schema（`dsh-tools` 受支持子集）的单个 JSON 对象或数组。重试预算计数每次拒绝各可 steer 的一次额外尝试。

```ts type-equiv
/** The contract governing one validation cycle. */
interface StructuredOutputContract {
  /** The JSON Schema (dsh-tools supported subset) the final reply must satisfy. */
  readonly schema: JsonSchemaNode
  /** Rejections that may steer one extra attempt after the first try. */
  readonly maxRetries: number
}
```

## 持久事件

挂载追加完整契约；最新 armed 记录生效直到下一个 outcome 结算其 turn。

```ts type-equiv
/** Durable record of one armed contract, appended at arm time. */
interface StructuredOutputArmed {
  readonly schema: JsonSchemaNode
  readonly maxRetries: number
}
```

结算恰好携带校验值或受限违规之一；`attempts` 计入该 turn 的每次校验（含结算那次）。

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

## 实时决策

作用域 `structured-output/decided` 事件伴随每次结算发出；其负载是去掉 violations 的 outcome。

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

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

Types: [Agent](core.zh.md) · [Scoped](scope.zh.md)

Source: [`packages/structured-output/structured-output/src/index.ts`](../../packages/structured-output/structured-output/src/index.ts)
<!-- END GENERATED cordis-surface -->
