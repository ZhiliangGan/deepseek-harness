/**
 * Structured-output enforcement (`ctx.structuredOutput`): one contract asks
 * the model for a final reply that is a single JSON object or array satisfying
 * a JSON Schema. Arming injects the contract into the conversation, the
 * `agent/turn-stopping` extension point validates the turn's final assistant
 * text, and a rejected reply steers one extra attempt while the retry budget
 * lasts. Every settlement appends one durable `structured-output/outcome`
 * event and emits a live `structured-output/decided` notification. A
 * deployment schema in config arms a standing contract; `arm()` arms one
 * next-turn contract for embedding callers.
 * @module @deepseek-ai/dsh-structured-output
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import z from '@deepseek-ai/schemastery'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { extractJsonDocument } from './extract.ts'
import type { JsonExtraction } from './extract.ts'
import type {
  StructuredOutputArmed,
  StructuredOutputContract,
  StructuredOutputDecided,
  StructuredOutputOutcome,
} from './types.ts'

// The durable event declarations live in src/types.ts (their one home); this
// re-export keeps the module edge in the emitted index.d.ts so aggregate
// programs consuming the declarations still receive the SessionEventMap merge.
export type * from './types.ts'
export { extractJsonDocument } from './extract.ts'
export type { JsonExtraction } from './extract.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    structuredOutput: StructuredOutputService
  }

  interface Events {
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
  }
}

/** Structured-output service configuration. */
export interface Config {
  /**
   * Deployment-wide standing schema: every root-agent turn is validated
   * against it while no per-turn arm is active. A dsh-tools supported JSON
   * Schema value.
   */
  schema?: unknown
  /** Rejections that may steer one extra attempt after the first try. */
  maxRetries?: number
  /** Maximum UTF-16 code units of the schema's JSON serialization. */
  maxSchemaChars?: number
}

/** Bounds applied to every model-facing and durable violation list. */
const MAX_VIOLATIONS = 3
const MAX_VIOLATION_CHARS = 200

/** Process-local per-session enforcement state (durable state lives in events). */
interface SessionState {
  /** A per-turn arm waiting for its first turn-stopping boundary. */
  pendingArm: StructuredOutputContract | undefined
  /** Validation attempts already made per turn. */
  readonly attempts: Map<number, number>
}

/**
 * Validate and bound one caller-supplied schema.
 * @param schema - the raw schema value from config or an arm request.
 * @param maxSchemaChars - the configured serialization bound.
 * @returns the validated contract schema.
 */
function resolveSchema(schema: unknown, maxSchemaChars: number): JsonSchemaNode {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error('structured-output schema must be a JSON object')
  }
  assertSupportedJsonSchema(schema)
  const serialized = JSON.stringify(schema)
  if (serialized.length > maxSchemaChars) {
    throw new Error(
      `structured-output schema serializes to ${serialized.length} chars; the bound is ${maxSchemaChars}`,
    )
  }
  return schema
}

/** The final assistant text of one turn, from the durable log. */
function finalAssistantText(session: Session, turn: number): string | undefined {
  for (let index = session.events.length - 1; index >= 0; index--) {
    const event = session.events[index]
    /* v8 ignore next -- descending indices over a live array never go out of range */
    if (event === undefined || event.type !== 'assistant/message' || event.data.turn !== turn) continue
    const text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    return text.length === 0 ? undefined : text
  }
  return undefined
}

/**
 * Bound one violation list for model-facing and durable use.
 * @param violations - the raw validator explanations, any length.
 * @returns at most {@link MAX_VIOLATIONS} entries, each capped at {@link MAX_VIOLATION_CHARS}.
 */
export function boundViolations(violations: readonly string[]): string[] {
  return violations.slice(0, MAX_VIOLATIONS)
    .map(violation => violation.length <= MAX_VIOLATION_CHARS
      ? violation
      : `${violation.slice(0, MAX_VIOLATION_CHARS - 1)}…`)
}

/** The contract message injected at arm time. */
function contractMessage(schema: JsonSchemaNode): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: 'Structured-output contract: when the task completes, your FINAL assistant message must be ONLY a single '
        + 'JSON object or array satisfying this JSON Schema (no prose, no code fences, no text before or after):\n'
        + JSON.stringify(schema, null, 2),
    }],
    source: { kind: 'plugin', plugin: 'structured-output', form: 'instructions' },
  })
}

/** The retry feedback message steering one rejected reply. */
function feedbackMessage(violations: readonly string[]): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: 'Your final reply was rejected by the structured-output contract. Reply again with ONLY a single JSON '
        + 'object or array satisfying the schema — no prose, no code fences. Violations:\n'
        + boundViolations(violations).map(violation => `- ${violation}`).join('\n'),
    }],
    source: { kind: 'plugin', plugin: 'structured-output', form: 'notice', summary: 'Structured output rejected; requesting a conforming reply' },
  })
}

/**
 * Enforce structured-output contracts on agent turns.
 */
export class StructuredOutputService extends Service {
  static inject = ['agents']

  static Config: z<Config> = z.object({
    schema: z.any(),
    maxRetries: z.number().step(1).min(0).default(2),
    maxSchemaChars: z.number().step(1).min(1).default(16384),
  })

  /** Resolved standing contract from config, when one is declared. */
  readonly standing: StructuredOutputContract | undefined
  /** Resolved and validated configuration bounds. */
  readonly resolved: { readonly maxRetries: number; readonly maxSchemaChars: number }

  private readonly states = new WeakMap<Session, SessionState>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'structuredOutput')
    // Static-Config schemastery defaults materialize before construction on
    // every loader path; the fallbacks serve direct construction only.
    /* v8 ignore next */
    const maxRetries = resolveMaxRetries(config.maxRetries ?? 2)
    /* v8 ignore next */
    const maxSchemaChars = config.maxSchemaChars ?? 16384
    this.resolved = { maxRetries, maxSchemaChars }
    this.standing = config.schema === undefined
      ? undefined
      : { schema: resolveSchema(config.schema, maxSchemaChars), maxRetries }
    ctx.on('agent/session-start', ({ agent }) => {
      if (this.standing === undefined) return
      // A resume re-fires session-start; the standing contract already armed
      // durably (and its instruction already rides the log) when the latest
      // armed record matches, so do not append or inject again.
      const latest = latestArmedContract(agent.session.events)
      if (latest !== undefined && latest.maxRetries === this.standing.maxRetries
        && JSON.stringify(latest.schema) === JSON.stringify(this.standing.schema)) {
        this.state(agent.session).pendingArm = this.standing
        return
      }
      this.armContract(agent, this.standing)
    })
    ctx.on('agent/turn-stopping', ({ agent, turn }) => {
      this.enforce(agent, turn)
    }, { global: true })
  }

  /**
   * Arm one contract for the agent's next completing turn, replacing any
   * pending arm and overriding the standing contract for that turn.
   * @param agent - the exact live agent whose next turn validates.
   * @param request - the schema and an optional retry budget override.
   */
  arm(agent: Agent, request: { schema: unknown; maxRetries?: number }): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new Error(`agent "${agent.id}" is not live in this registry`)
    }
    const contract: StructuredOutputContract = {
      schema: resolveSchema(request.schema, this.resolved.maxSchemaChars),
      maxRetries: resolveMaxRetries(request.maxRetries ?? this.resolved.maxRetries),
    }
    this.armContract(agent, contract)
  }

  /** Inject the contract and record the durable armed event. */
  private armContract(agent: Agent, contract: StructuredOutputContract): void {
    const armed: StructuredOutputArmed = { schema: contract.schema, maxRetries: contract.maxRetries }
    agent.session.append('structured-output/armed', armed)
    agent.inject(contractMessage(contract.schema))
    this.state(agent.session).pendingArm = contract
  }

  /** Validate one turn's final reply at its stop boundary. */
  private enforce(agent: Agent, turn: number): void {
    const session = agent.session
    const state = this.state(session)
    const contract = state.pendingArm ?? this.standing
    if (contract === undefined) return
    const text = finalAssistantText(session, turn)
    // A turn that produced no assistant text (an inbox-rejected empty turn,
    // a cancellation) has nothing to validate; the contract stays armed.
    if (text === undefined) return
    const attempts = (state.attempts.get(turn) ?? 0) + 1
    const extraction: JsonExtraction = extractJsonDocument(text)
    const violations = extraction.ok
      ? validateJsonSchemaValue(contract.schema, extraction.value, 'output')
      : [extraction.error]
    if (extraction.ok && violations.length === 0) {
      state.pendingArm = undefined
      this.settle(agent, turn, true, attempts, extraction.value, undefined)
      return
    }
    if (attempts - 1 < contract.maxRetries) {
      state.attempts.set(turn, attempts)
      agent.steer(feedbackMessage(violations))
      return
    }
    state.pendingArm = undefined
    this.settle(agent, turn, false, attempts, undefined, boundViolations(violations))
  }

  /** Append the durable outcome and emit the live decision. */
  private settle(
    agent: Agent,
    turn: number,
    valid: boolean,
    attempts: number,
    value: unknown,
    violations: readonly string[] | undefined,
  ): void {
    const state = this.state(agent.session)
    state.attempts.delete(turn)
    const outcome: StructuredOutputOutcome = {
      turn,
      valid,
      attempts,
      ...value === undefined ? {} : { value },
      ...violations === undefined ? {} : { violations },
    }
    agent.session.append('structured-output/outcome', outcome)
    agentEvents(this.ctx, agent).emit('structured-output/decided', {
      turn,
      valid,
      attempts,
      ...value === undefined ? {} : { value },
    })
  }

  /** The per-session process-local state. */
  private state(session: Session): SessionState {
    let state = this.states.get(session)
    if (state === undefined) {
      state = { pendingArm: undefined, attempts: new Map() }
      this.states.set(session, state)
    }
    return state
  }
}

/** Validate one retry budget at the boundary that receives it. */
function resolveMaxRetries(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('maxRetries must be a non-negative safe integer')
  }
  return value
}

/**
 * Resolve the latest durable armed contract in one session log.
 * @param events - the session events to scan, newest first internally.
 * @returns the latest `structured-output/armed` record, or `undefined` when none exists.
 */
export function latestArmedContract(events: readonly SessionEvent[]): StructuredOutputArmed | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    /* v8 ignore next -- descending indices over a live array never go out of range */
    if (event === undefined) continue
    if (event.type !== 'structured-output/armed') continue
    return event.data
  }
  return undefined
}

export default StructuredOutputService
