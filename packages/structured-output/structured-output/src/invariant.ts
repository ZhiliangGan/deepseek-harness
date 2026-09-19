/** Package-owned durable structured-output-stream invariants. @module @deepseek-ai/dsh-structured-output/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'

const PACKAGE_NAME = '@deepseek-ai/dsh-structured-output'

/** Cordis companion plugin name. */
export const name = 'structured-output-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate one durable armed record.
 *
 * Deliberately silent on schema size and retry budget ceilings. Those are the
 * deployment's capacity policy (`Config.maxSchemaChars` / arming-time
 * defaults), not durable-shape rules: a log written under a looser deployment
 * must still replay after the policy tightens.
 */
function validateArmed(event: SessionEvent, fail: InvariantFailure): JsonSchemaNode | undefined {
  const { schema, maxRetries } = event.data as { schema: unknown; maxRetries: unknown }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    fail('structured-output/armed schema must be a JSON object')
    return undefined
  }
  if (typeof maxRetries !== 'number' || !Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    fail('structured-output/armed maxRetries must be a non-negative safe integer')
  }
  return schema
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Install validation for loaded and newly appended structured-output events. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, JsonSchemaNode | undefined>()
  const staged = new WeakMap<SessionEvent, { session: Session; schema: JsonSchemaNode | undefined }>()

  /** Validate one event against the governing schema and return the next governing schema. */
  const applyChecked = (schema: JsonSchemaNode | undefined, event: SessionEvent): JsonSchemaNode | undefined => {
    if (event.type === 'structured-output/armed') return validateArmed(event, fail)
    if (event.type !== 'structured-output/outcome') return schema
    const { turn, valid, attempts, value, violations } = event.data
    if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 1) {
      fail('structured-output/outcome turn must be a positive safe integer')
    }
    if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 1) {
      fail('structured-output/outcome attempts must be a positive safe integer')
    }
    if (typeof valid !== 'boolean') {
      fail('structured-output/outcome valid must be a boolean')
      return schema
    }
    if (valid) {
      if (value === undefined) {
        fail('structured-output/outcome valid settlement lacks its value')
      } else if (schema !== undefined) {
        const offenses = validateJsonSchemaValue(schema, value, 'outcome')
        if (offenses.length > 0) fail(`structured-output/outcome value violates its governing schema: ${offenses[0]}`)
      }
    } else if (!Array.isArray(violations) || violations.length === 0
      || violations.some(violation => typeof violation !== 'string' || violation.length === 0)) {
      fail('structured-output/outcome invalid settlement requires a non-empty violations string array')
    }
    return schema
  }

  const seed = (session: Session): JsonSchemaNode | undefined => {
    let schema: JsonSchemaNode | undefined
    for (const event of session.events) schema = applyChecked(schema, event)
    states.set(session, schema)
    return schema
  }
  /* v8 ignore next -- session/event always follows list() or session/created seeding */
  const stateFor = (session: Session): JsonSchemaNode | undefined => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    staged.set(event, { session, schema: applyChecked(stateFor(session), event) })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching structured-output-fold validation')
    }
    staged.delete(event)
    states.set(session, candidate.schema)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the structured-output invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
