/** Package-owned durable guardian-review invariants. @module @deepseek-ai/dsh-guardian-approval/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-guardian-approval'
const MAX_RATIONALE_CHARS = 400

/** Cordis companion plugin name. */
export const name = 'guardian-approval-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate one durable review record's shape and bounds. */
function validateReview(event: SessionEvent, fail: InvariantFailure): void {
  const { decision, rationale, toolName, callId } = event.data as {
    decision: unknown
    rationale: unknown
    toolName: unknown
    callId?: unknown
  }
  if (decision !== 'allow' && decision !== 'deny') {
    fail(`guardian/review decision must be "allow" or "deny" (got ${JSON.stringify(String(decision))})`)
  }
  if (typeof rationale !== 'string' || rationale.trim().length === 0) {
    fail('guardian/review rationale must be a non-empty string')
  }
  if (rationale.length > MAX_RATIONALE_CHARS) {
    fail(`guardian/review rationale exceeds ${MAX_RATIONALE_CHARS} chars (got ${String(rationale.length)})`)
  }
  if (typeof toolName !== 'string' || toolName.length === 0) {
    fail('guardian/review toolName must be a non-empty string')
  }
  if (callId !== undefined && typeof callId !== 'string') {
    fail('guardian/review callId, when present, must be a string')
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Install validation for loaded and newly appended guardian reviews. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const validateEvent = (event: SessionEvent): void => {
    if (event.type === 'guardian/review') validateReview(event, fail)
  }

  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the guardian-review invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
