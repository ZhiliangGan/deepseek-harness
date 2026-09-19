/**
 * Pure types of the structured-output domain: the ONE home of the durable
 * `structured-output/*` event vocabulary plus the live decision payload, free
 * of host-side imports. One structured-output contract asks the model for a
 * final reply that is a single JSON value satisfying a JSON Schema; the
 * enforcement loop validates the turn's final assistant text, steers the
 * conversation for another conforming attempt while a retry budget remains,
 * and records one durable outcome per validated turn.
 *
 * @module @deepseek-ai/dsh-structured-output/types
 */

import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'

/** The contract governing one validation cycle. */
export interface StructuredOutputContract {
  /** The JSON Schema (dsh-tools supported subset) the final reply must satisfy. */
  readonly schema: JsonSchemaNode
  /** Rejections that may steer one extra attempt after the first try. */
  readonly maxRetries: number
}

/** Durable record of one armed contract, appended at arm time. */
export interface StructuredOutputArmed {
  readonly schema: JsonSchemaNode
  readonly maxRetries: number
}

/** Durable record of one turn's validation settlement. */
export interface StructuredOutputOutcome {
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

/** Live decision notification after one turn's validation settles. */
export interface StructuredOutputDecided {
  /** The turn whose final reply was validated. */
  readonly turn: number
  /** Whether the final reply parsed and satisfied the schema. */
  readonly valid: boolean
  /** Total validation attempts made (1 before any retry). */
  readonly attempts: number
  /** The parsed JSON value, present exactly when {@link valid} is true. */
  readonly value?: unknown
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One contract became active: appended when a deployment standing schema
     * or a per-turn arm arms validation. Log-only state; never derived
     * history. The latest armed event governs until the next outcome settles
     * its turn.
     */
    'structured-output/armed': StructuredOutputArmed
    /**
     * One turn's validation settled (valid value or exhausted retries).
     * Log-only state; never derived history.
     */
    'structured-output/outcome': StructuredOutputOutcome
  }
}
