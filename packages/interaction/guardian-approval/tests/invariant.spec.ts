import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import * as GuardianInvariant from '@deepseek-ai/dsh-guardian-approval/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(GuardianInvariant)
  return ctx
}

function review(data: Record<string, unknown>): SessionEvent {
  return { type: 'guardian/review', seq: 0, time: 0, data } as unknown as SessionEvent
}

describe('guardian review invariants', () => {
  it('accepts coherent reviews and their live continuation', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => {
      session.append('guardian/review', { decision: 'allow', rationale: 'routine work', toolName: 'bash', callId: 'call-1' })
      session.append('guardian/review', { decision: 'deny', rationale: 'exfiltration risk', toolName: 'web_fetch' })
    }).not.toThrow()
  })

  it('ignores unrelated dispatches and session events', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('tools/change')
      ctx.sessions.create().append('turn/start', { turn: 1 })
    }).not.toThrow()
  })

  it.each([
    ['unknown decision', review({ decision: 'maybe', rationale: 'r', toolName: 'bash' }), /decision must be "allow" or "deny"/],
    ['empty rationale', review({ decision: 'allow', rationale: '  ', toolName: 'bash' }), /non-empty string/],
    ['oversized rationale', review({ decision: 'allow', rationale: 'x'.repeat(401), toolName: 'bash' }), /exceeds 400 chars/],
    ['missing tool name', review({ decision: 'deny', rationale: 'r', toolName: '' }), /non-empty string/],
    ['non-string call id', review({ decision: 'deny', rationale: 'r', toolName: 'bash', callId: 7 }), /must be a string/],
  ])('rejects a review that %s on late registration', async (_label, event, message) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append(event.type, event.data)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(GuardianInvariant).then(() => undefined)).rejects.toThrow(message)
  })

  it('reports a live violation at append time, not only on load', async () => {
    const ctx = await setup()
    const session: Session = ctx.sessions.create()
    expect(() => {
      session.append('guardian/review', { decision: 'defer', rationale: 'r', toolName: 'bash' } as never)
    }).toThrow(/decision must be "allow" or "deny"/)
  })
})
