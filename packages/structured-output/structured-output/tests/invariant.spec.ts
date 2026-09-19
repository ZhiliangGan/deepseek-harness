import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import * as StructuredInvariant from '@deepseek-ai/dsh-structured-output/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(StructuredInvariant)
  return ctx
}

const STATUS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string', enum: ['ok', 'error'] } },
}

function armed(seq: number, schema: unknown = STATUS_SCHEMA, maxRetries = 2): SessionEvent {
  return { type: 'structured-output/armed', seq, time: 0, data: { schema, maxRetries } } as unknown as SessionEvent
}

function outcome(seq: number, data: Record<string, unknown>): SessionEvent {
  return { type: 'structured-output/outcome', seq, time: 0, data } as unknown as SessionEvent
}

/** A coherent stream: arm, then one valid settlement. */
function coherentStream(): SessionEvent[] {
  return [
    armed(0),
    outcome(1, { turn: 1, valid: true, attempts: 1, value: { status: 'ok' } }),
  ]
}

describe('structured-output stream invariants', () => {
  it('accepts a coherent durable stream and its live continuation', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => {
      for (const event of coherentStream()) session.append(event.type, event.data)
    }).not.toThrow()
    expect(() => {
      session.append('structured-output/armed', { schema: STATUS_SCHEMA, maxRetries: 0 })
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
    ['arms a non-object schema', [armed(0, 42)], /schema must be a JSON object/],
    ['arms a negative retry budget', [armed(0, STATUS_SCHEMA, -1)], /maxRetries must be a non-negative safe integer/],
    ['settles valid without a value', [armed(0), outcome(1, { turn: 1, valid: true, attempts: 1 })], /lacks its value/],
    ['settles a value violating the governing schema', [
      armed(0),
      outcome(1, { turn: 1, valid: true, attempts: 1, value: { status: 'maybe' } }),
    ], /violates its governing schema/],
    ['settles invalid without violations', [
      armed(0),
      outcome(1, { turn: 1, valid: false, attempts: 1 }),
    ], /requires a non-empty violations string array/],
    ['settles with a non-integer turn', [
      armed(0),
      outcome(1, { turn: 0, valid: true, attempts: 1, value: { status: 'ok' } }),
    ], /turn must be a positive safe integer/],
    ['settles with a non-boolean valid flag', [
      armed(0),
      outcome(1, { turn: 1, valid: 'yes', attempts: 1 }),
    ], /valid must be a boolean/],
    ['settles with a non-integer attempts count', [
      armed(0),
      outcome(1, { turn: 1, valid: true, attempts: 1.5, value: { status: 'ok' } }),
    ], /attempts must be a positive safe integer/],
  ])('rejects an invalid existing stream on late registration when it %s', async (_label, events, message) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    for (const event of events) session.append(event.type, event.data)
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(StructuredInvariant).then(() => undefined)).rejects.toThrow(message)
  })

  it('accepts a valid settlement that predates any armed contract', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('structured-output/outcome', {
      turn: 1, valid: true, attempts: 1, value: { status: 'ok' },
    })
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(StructuredInvariant)
  })

  it('reports a live violation at append time, not only on load', async () => {
    const ctx = await setup()
    const session: Session = ctx.sessions.create()
    session.append('structured-output/armed', { schema: STATUS_SCHEMA, maxRetries: 1 })
    expect(() => {
      session.append('structured-output/outcome', { turn: 1, valid: true, attempts: 1, value: { nope: 1 } })
    }).toThrow(/violates its governing schema/)
  })
})
