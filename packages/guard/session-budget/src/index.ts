/**
 * Session budget guard. Two caps bound what one session may spend: a turn cap
 * rejects any proposed turn beyond the limit before its first model request,
 * and a token cap stops new work once cumulative uncached input plus output
 * tokens reach the limit. Both caps also cancel the active turn at its stop
 * boundary when the limit is met, so chained continuation (steering, goal
 * rounds) cannot spend past the budget. The loop durably logs the
 * `{kind:'hook'}` cancel cause; the guard adds no session event of its own.
 * @module @deepseek-ai/dsh-session-budget
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
// Side-effect type imports: load the Context augmentation for
// ctx.sessionProjections and the SessionProjectionMap entry this guard reads.
import '@deepseek-ai/dsh-session-projection'
import '@deepseek-ai/dsh-token-meter'

export const name = 'session-budget'
/** The projection registry the token cap reads. */
export const inject = ['sessionProjections']

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: a non-integer or
 * negative limit, or a config where every limit is 0 — a guard that bounds
 * nothing — throws at plugin load, never a silent fall-back).
 */
export interface Config {
  /** Maximum turns per session; a proposed turn beyond the cap is rejected without a step (default 0, no turn cap). */
  maxTurns?: number
  /** Maximum cumulative session tokens — uncached input plus output — before new work stops (default 0, no token cap). */
  maxSessionTokens?: number
}

export const Config: z<Config> = z.object({
  maxTurns: z.number().default(0),
  maxSessionTokens: z.number().default(0),
})

/** The two `tokenUsage` projection buckets the token cap counts. */
interface UsageBuckets {
  uncachedInputTokens: number
  outputTokens: number
}

/** Head-truncate a session id for cancel-cause strings. */
function sessionLabel(agent: Agent): string {
  return agent.session.id.length <= 12 ? agent.session.id : `${agent.session.id.slice(0, 12)}…`
}

/**
 * Install the budget listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; limits are re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the fields are set after validation.
  const maxTurns = config.maxTurns as number
  const maxSessionTokens = config.maxSessionTokens as number
  for (const [field, value] of [['maxTurns', maxTurns], ['maxSessionTokens', maxSessionTokens]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`session-budget: invalid ${field} ${value} — must be an integer >= 0`)
    }
  }
  if (maxTurns === 0 && maxSessionTokens === 0) {
    throw new Error('session-budget: configure at least one limit greater than 0 — a guard that bounds nothing is a misconfiguration')
  }

  /** Cumulative uncached-input-plus-output tokens of one session, from the `tokenUsage` projection. */
  function spentTokens(session: Session): number {
    const usage = ctx.sessionProjections.snapshot(session, ['tokenUsage']).values['tokenUsage'] as UsageBuckets | undefined
    if (usage === undefined) {
      throw new Error('session-budget: maxSessionTokens requires the tokenUsage session projection — mount @deepseek-ai/dsh-token-meter')
    }
    return usage.uncachedInputTokens + usage.outputTokens
  }

  function tokenLimitReached(agent: Agent): boolean {
    return maxSessionTokens > 0 && spentTokens(agent.session) >= maxSessionTokens
  }

  // Reject over-budget turns at their first step, before any model request:
  // the claimed input ends unlogged and the turn closes with no spend. The
  // `step === 1` guard leaves an in-flight turn's continuation steps alone —
  // the token cap's overshoot is bounded by the turn-stopping cancel.
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next): Promise<PreStepDecision> => {
    if (maxTurns > 0 && turn > maxTurns) return { kind: 'reject' }
    if (step === 1 && tokenLimitReached(agent)) return { kind: 'reject' }
    return next()
  }, { global: true })

  // At the stop boundary of a turn that meets a limit, cancel so chained
  // continuation (steered retries, goal rounds) cannot open further turns of
  // spend; a later followup that slips through is caught by the pre-step
  // rejection above.
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const turnLimitReached = maxTurns > 0 && turn >= maxTurns
    const tokenReached = tokenLimitReached(agent)
    if (!turnLimitReached && !tokenReached) return
    const reason = turnLimitReached
      ? `session-budget: session ${sessionLabel(agent)} reached its ${maxTurns}-turn limit`
      : `session-budget: session ${sessionLabel(agent)} reached its ${maxSessionTokens}-token limit`
    agent.cancel({ kind: 'hook', reason })
  }, { global: true })
}
