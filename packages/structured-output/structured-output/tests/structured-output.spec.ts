/**
 * Drives the REAL enforcement body: a scripted in-process LLM adapter feeds
 * the real AgentLoop, so arming, injection, stop-boundary validation, steering
 * retries, and durable outcomes are observed on genuine agents and session
 * logs (only the model wire is scripted).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import StructuredOutput, { boundViolations, latestArmedContract } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { agentEvents } from '@deepseek-ai/dsh-agent'

const STATUS_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string' as const, enum: ['ok', 'error'] } },
}

/** Pops one scripted text reply per model call. */
class ScriptedAdapter extends LlmAdapter {
  private calls = 0

  constructor(private readonly replies: readonly string[]) {
    super()
  }

  /** Count of model calls served so far. */
  get served(): number {
    return this.calls
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = this.replies[this.calls]
    this.calls += 1
    if (reply === undefined) throw new Error('scripted adapter exhausted')
    return this.streamReply(reply)
  }

  private async *streamReply(reply: string): AsyncGenerator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Bench {
  ctx: Context
  agent: Agent
  adapter: ScriptedAdapter
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function harness(replies: readonly string[], config: Partial<Config> = {}): Promise<Bench> {
  const ctx = new Context()
  context = ctx
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new ScriptedAdapter(replies)
  ctx.llm.registerAdapter(['scripted'], adapter)
  await ctx.plugin(StructuredOutput, { maxRetries: 2, maxSchemaChars: 16384, ...config })
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = await ctx.agentLoop.create(SessionId('structured-spec'), { provider: 'scripted', model: 'scripted-model' })
  await agent.whenIdle()
  return { ctx, agent, adapter }
}

function run(agent: Agent, text = 'classify the build'): Promise<void> {
  const idle = agent.whenIdle()
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  return idle
}

function events<T extends SessionEvent['type']>(agent: Agent, type: T): Extract<SessionEvent, { type: T }>[] {
  return agent.session.snapshotEvents().filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type)
}

function pluginTexts(agent: Agent, form: string): string[] {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'structured-output'
      && event.data.source.form === form)
    .map(event => event.type === 'user/message'
      ? event.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
      : '')
}

describe('dsh-structured-output', () => {
  it('steers one retry after a rejected reply and settles a valid outcome', async () => {
    const bench = await harness(['the build looks fine overall', '{"status":"ok"}'], { schema: STATUS_SCHEMA })
    await run(bench.agent)

    expect(events(bench.agent, 'structured-output/armed')).toHaveLength(1)
    const contract = pluginTexts(bench.agent, 'instructions')
    expect(contract[0]).toContain('single')
    expect(contract[0]).toContain('"status"')
    expect(pluginTexts(bench.agent, 'notice')[0]).toContain('rejected')
    expect(pluginTexts(bench.agent, 'notice')[0]).toContain('no JSON object or array')

    const outcomes = events(bench.agent, 'structured-output/outcome')
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.data).toEqual({ turn: 1, valid: true, attempts: 2, value: { status: 'ok' } })
    expect(bench.adapter.served).toBe(2)
  })

  it('accepts a fenced reply on the first attempt', async () => {
    const bench = await harness(['```json\n{"status":"error"}\n```'], { schema: STATUS_SCHEMA })
    await run(bench.agent)
    expect(events(bench.agent, 'structured-output/outcome')[0]!.data)
      .toEqual({ turn: 1, valid: true, attempts: 1, value: { status: 'error' } })
    expect(pluginTexts(bench.agent, 'notice')).toHaveLength(0)
  })

  it('accepts a JSON document embedded in prose', async () => {
    const bench = await harness(['Sure — here it is:\n{"status":"ok"}\nhope that helps'], { schema: STATUS_SCHEMA })
    await run(bench.agent)
    expect(events(bench.agent, 'structured-output/outcome')[0]!.data.valid).toBe(true)
  })

  it('closes the turn with an invalid outcome when the retry budget is exhausted', async () => {
    const bench = await harness(['just some words'], { schema: STATUS_SCHEMA, maxRetries: 0 })
    await run(bench.agent)
    const outcome = events(bench.agent, 'structured-output/outcome')[0]!.data
    expect(outcome.valid).toBe(false)
    expect(outcome.attempts).toBe(1)
    expect(outcome.violations?.[0]).toContain('no JSON object or array')
    expect(pluginTexts(bench.agent, 'notice')).toHaveLength(0)
  })

  it('reports schema violations, not just parse failures', async () => {
    const bench = await harness(['{"status":"maybe"}'], { schema: STATUS_SCHEMA, maxRetries: 0 })
    await run(bench.agent)
    const outcome = events(bench.agent, 'structured-output/outcome')[0]!.data
    expect(outcome.valid).toBe(false)
    expect(outcome.violations?.join('\n')).toContain('status')
  })

  it('arms one next-turn contract through the service API without standing config', async () => {
    const bench = await harness(['{"status":"ok"}'])
    bench.ctx.structuredOutput.arm(bench.agent, { schema: STATUS_SCHEMA })
    await run(bench.agent)
    expect(events(bench.agent, 'structured-output/armed')).toHaveLength(1)
    expect(events(bench.agent, 'structured-output/outcome')[0]!.data).toEqual({
      turn: 1, valid: true, attempts: 1, value: { status: 'ok' },
    })

    // The one-shot arm is consumed: the next turn runs unvalidated.
    await run(bench.agent, 'one more thing')
    expect(events(bench.agent, 'structured-output/outcome')).toHaveLength(1)
  })

  it('emits the live decided notification beside the durable outcome', async () => {
    const bench = await harness(['{"status":"ok"}'], { schema: STATUS_SCHEMA })
    const seen: unknown[] = []
    bench.ctx.on('structured-output/decided', (payload) => {
      seen.push(payload)
    })
    await run(bench.agent)
    expect(seen).toEqual([{ agent: bench.agent, turn: 1, valid: true, attempts: 1, value: { status: 'ok' } }])
  })

  it('leaves contract-free turns completely untouched', async () => {
    const bench = await harness(['plain answer'])
    await run(bench.agent)
    expect(events(bench.agent, 'structured-output/armed')).toHaveLength(0)
    expect(events(bench.agent, 'structured-output/outcome')).toHaveLength(0)
    expect(pluginTexts(bench.agent, 'notice')).toHaveLength(0)
  })

  it('rejects a malformed arm at the operation boundary', async () => {
    const bench = await harness(['{"status":"ok"}'])
    expect(() => {
      bench.ctx.structuredOutput.arm(bench.agent, { schema: [{ type: 'object' }] })
    })
      .toThrow(/schema/)
    expect(() => {
      bench.ctx.structuredOutput.arm(bench.agent, { schema: STATUS_SCHEMA, maxRetries: -1 })
    })
      .toThrow(/non-negative safe integer/)
  })

  it('bounds the schema size at arm time', async () => {
    const bench = await harness(['{"status":"ok"}'])
    expect(() => {
      bench.ctx.structuredOutput.arm(bench.agent, { schema: STATUS_SCHEMA })
    }).not.toThrow()
    const tight = await harness(['{}'], { maxSchemaChars: 8 })
    expect(() => {
      tight.ctx.structuredOutput.arm(tight.agent, { schema: STATUS_SCHEMA })
    })
      .toThrow(/the bound is 8/)
  })

  it('rejects arming an agent that is not the registry live instance', async () => {
    const bench = await harness(['{"status":"ok"}'])
    const stale = { ...bench.agent, id: SessionId('not-live') }
    expect(() => {
      bench.ctx.structuredOutput.arm(stale, { schema: STATUS_SCHEMA })
    })
      .toThrow(/not live/)
  })

  it('does not re-arm a standing contract that the durable log already carries', async () => {
    const bench = await harness(['{"status":"ok"}'], { schema: STATUS_SCHEMA })
    await run(bench.agent)
    expect(events(bench.agent, 'structured-output/armed')).toHaveLength(1)

    // A resume re-fires session-start; the matching durable armed record
    // suppresses a second append or injection.
    agentEvents(bench.ctx, bench.agent).emit('agent/created', { source: 'resume' })
    expect(events(bench.agent, 'structured-output/armed')).toHaveLength(1)
    expect(pluginTexts(bench.agent, 'instructions')).toHaveLength(1)
  })

  it('leaves a text-less turn unenforced instead of steering', async () => {
    const bench = await harness(['{"status":"ok"}'], { schema: STATUS_SCHEMA })
    await bench.agent.whenIdle()
    agentEvents(bench.ctx, bench.agent).emit('agent/turn-stopping', {
      turn: 9, signal: new AbortController().signal,
    })
    expect(events(bench.agent, 'structured-output/outcome')).toHaveLength(0)
    expect(pluginTexts(bench.agent, 'notice')).toHaveLength(0)
  })

  it('treats an assistant message with no text blocks as no reply', async () => {
    const bench = await harness(['{"status":"ok"}'], { schema: STATUS_SCHEMA })
    await bench.agent.whenIdle()
    bench.agent.session.append('assistant/message', {
      turn: 7, step: 1, stream: [], message: createAssistantMessage({ content: [], source: { provider: 'scripted', model: 'scripted-model' } }),
    }, { surfaceOp: 'append' })
    agentEvents(bench.ctx, bench.agent).emit('agent/turn-stopping', {
      turn: 7, signal: new AbortController().signal,
    })
    expect(events(bench.agent, 'structured-output/outcome')).toHaveLength(0)
  })

  it('bounds violation lists to three entries of 200 chars', () => {
    const long = 'x'.repeat(300)
    const bounded = boundViolations([long, 'short', 'y'.repeat(250), 'dropped'])
    expect(bounded).toHaveLength(3)
    expect(bounded[0]).toHaveLength(200)
    expect(bounded[0]?.endsWith('…')).toBe(true)
    expect(bounded[1]).toBe('short')
    expect(bounded[2]).toHaveLength(200)
  })

  it('resolves documented defaults when mounted with an empty config', async () => {
    const ctx = new Context()
    context = ctx
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(StructuredOutput, {})
    expect(ctx.structuredOutput.resolved).toEqual({ maxRetries: 2, maxSchemaChars: 16384 })
    expect(ctx.structuredOutput.standing).toBeUndefined()
  })

  it('latestArmedContract returns the latest armed record or undefined', async () => {
    const bench = await harness(['{"status":"ok"}'], { schema: STATUS_SCHEMA })
    await run(bench.agent)
    const log = bench.agent.session.snapshotEvents()
    expect(latestArmedContract(log)?.maxRetries).toBe(2)
    expect(latestArmedContract([])).toBeUndefined()
    expect(latestArmedContract(log.slice(0, events(bench.agent, 'structured-output/armed')[0]!.seq)))
      .toBeUndefined()
  })
})
