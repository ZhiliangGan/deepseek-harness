/**
 * Drives the REAL guardian answerer through the REAL approval waterfall: a
 * scripted in-process LLM adapter serves the auxiliary review call, and
 * ApprovalService.request() runs the full asked/decided audit pair on a
 * genuine session log (only the reviewer wire is scripted).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as guardian from '../src/index.ts'

/** Serves one scripted review reply per call and records the requests. */
class ReviewAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly replies: readonly string[]) {
    super()
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const reply = this.replies[this.requests.length - 1]
    if (reply === undefined) throw new Error('review adapter exhausted')
    return this.streamReply(reply)
  }

  private async *streamReply(reply: string): AsyncGenerator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

interface Bench {
  ctx: Context
  agent: Agent
  adapter: ReviewAdapter
}

async function harness(replies: readonly string[]): Promise<Bench> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  const adapter = new ReviewAdapter(replies)
  ctx.llm.registerAdapter(['guardian'], adapter)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(guardian, { reviewerProvider: 'guardian', reviewerModel: 'guard-model', maxOutputTokens: 64, timeoutMs: 5000 })
  const session = Session.create(SessionId('guardian-spec'))
  const agent = { id: session.id, session } as Agent
  // The service requires an open turn for the audit pair.
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'refactor the parser and run the suite' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return { ctx, agent, adapter }
}

function ask(
  bench: Bench,
  over: { toolName?: string; reason?: string; signal?: AbortSignal; callId?: boolean } = {},
): Promise<ApprovalOutcome> {
  return bench.ctx.approval.request({
    agent: bench.agent,
    toolName: over.toolName ?? 'bash',
    ...over.reason === undefined ? {} : { reason: over.reason },
    ...over.signal === undefined ? {} : { signal: over.signal },
    ...over.callId === true ? { callId: ToolCallId('call-guardian-1') } : {},
  })
}

/** Harness with one custom adapter and an open turn carrying a user message. */
async function harnessTool(
  adapter: LlmAdapter,
  config: { timeoutMs?: number } = {},
): Promise<Bench> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['guardian'], adapter)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(guardian, {
    reviewerProvider: 'guardian', reviewerModel: 'guard-model',
    maxOutputTokens: 64, timeoutMs: config.timeoutMs ?? 5000,
  })
  const session = Session.create(SessionId('guardian-spec'))
  const agent = { id: session.id, session } as Agent
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'run the suite' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return { ctx, agent, adapter: adapter as unknown as ReviewAdapter }
}

function events<T extends SessionEvent['type']>(agent: Agent, type: T): Extract<SessionEvent, { type: T }>[] {
  return agent.session.snapshotEvents().filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type)
}

describe('dsh-guardian-approval', () => {
  it('claims an allow decision with a durable review record', async () => {
    const bench = await harness(['{"decision":"allow","rationale":"Routine test run; reversible and workspace-scoped."}'])
    const outcome = await ask(bench, { toolName: 'bash', reason: 'command not on the saved prefix list' })
    expect(outcome).toBe('allowed-once')

    const reviews = events(bench.agent, 'guardian/review')
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.data).toEqual({
      decision: 'allow',
      rationale: 'Routine test run; reversible and workspace-scoped.',
      toolName: 'bash',
    })
    const decided = events(bench.agent, 'approval/decided')
    expect(decided[0]!.data.outcome).toBe('allowed-once')
  })

  it('claims a deny decision', async () => {
    const bench = await harness(['```json\n{"decision":"deny","rationale":"Sends the workspace to an unknown endpoint."}\n```'])
    const outcome = await ask(bench, { toolName: 'web_fetch' })
    expect(outcome).toBe('rejected')
    expect(events(bench.agent, 'guardian/review')[0]!.data.decision).toBe('deny')
  })

  it('defers a malformed review to the remaining chain (fail toward the human)', async () => {
    const bench = await harness(['looks fine to me, let it through'])
    const outcome = await ask(bench)
    // No other answerer composed: the chain settles fail-closed unavailable.
    expect(outcome).toBe('unavailable')
    expect(events(bench.agent, 'guardian/review')).toHaveLength(0)
  })

  it('defers an unknown decision vocabulary', async () => {
    const bench = await harness(['{"decision":"maybe","rationale":"unclear"}'])
    expect(await ask(bench)).toBe('unavailable')
  })

  it('defers a rationale-less decision', async () => {
    const bench = await harness(['{"decision":"allow"}'])
    expect(await ask(bench)).toBe('unavailable')
  })

  it('defers a tool-call-shaped review reply', async () => {
    class ToolCallAdapter extends LlmAdapter {
      override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        return (async function * (): AsyncGenerator<StreamChunk> {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield {
            type: 'block-end', index: 0,
            block: { type: 'tool-call', id: ToolCallId('call_x'), name: 'x', arguments: '{}' },
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        })()
      }
    }
    const bench = await harnessTool(new ToolCallAdapter())
    expect(await ask(bench)).toBe('unavailable')
    expect(events(bench.agent, 'guardian/review')).toHaveLength(0)
  })

  it('defers when the review call aborts by timeout', async () => {
    class HangingAdapter extends LlmAdapter {
      override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        // The adapter contract requires honoring options.signal: a real
        // transport aborts the request; this script hangs until it fires.
        return (async function * (): AsyncGenerator<StreamChunk> {
          await new Promise<void>((resolve) => {
            options.signal?.addEventListener('abort', () => {
              resolve()
            }, { once: true })
          })
          options.signal?.throwIfAborted()
        })()
      }
    }
    const bench = await harnessTool(new HangingAdapter(), { timeoutMs: 50 })
    expect(await ask(bench)).toBe('unavailable')
    expect(events(bench.agent, 'guardian/review')).toHaveLength(0)
  }, 15_000)

  it('defers immediately when the request signal is already aborted', async () => {
    const bench = await harness([])
    const controller = new AbortController()
    controller.abort()
    expect(await ask(bench, { signal: controller.signal })).toBe('cancelled')
    expect(bench.adapter.requests).toHaveLength(0)
  })

  it('bounds the recorded rationale and the intent quote in the prompt', async () => {
    const bench = await harness(['{"decision":"allow","rationale":"' + 'x'.repeat(900) + '"}'])
    await ask(bench)
    const review = events(bench.agent, 'guardian/review')[0]!.data
    expect(review.rationale.length).toBe(400)
    expect(review.rationale.endsWith('…')).toBe(true)
    const prompt = bench.adapter.requests[0]!.messages[0]
    expect(JSON.stringify(prompt)).toContain('refactor the parser')
  })

  it('reviews with the guardian purpose and configured route', async () => {
    const bench = await harness(['{"decision":"deny","rationale":"risky"}'])
    await ask(bench)
    const options = bench.adapter.requests[0]
    expect(options?.purpose).toBe('guardian-review')
    expect(options?.provider).toBe('guardian')
    expect(options?.model).toBe('guard-model')
    expect(options?.maxTokens).toBe(64)
  })

  it('reviews without a user intent when the turn has none yet', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    const adapter = new ReviewAdapter(['{"decision":"allow","rationale":"fine"}'])
    ctx.llm.registerAdapter(['guardian'], adapter)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    await ctx.plugin(guardian, { reviewerProvider: 'guardian', reviewerModel: 'guard-model', maxOutputTokens: 64, timeoutMs: 5000 })
    const session = Session.create(SessionId('guardian-no-intent'))
    const agent = { id: session.id, session } as Agent
    session.append('turn/start', { turn: 1 })
    const outcome = await ctx.approval.request({ agent, toolName: 'bash' })
    expect(outcome).toBe('allowed-once')
    expect(JSON.stringify(adapter.requests[0]!.messages[0])).toContain('no user request recorded yet')
  })

  it('records the call id on the review when the asker had one', async () => {
    const bench = await harness(['{"decision":"allow","rationale":"routine"}'])
    await ask(bench, { callId: true })
    expect(events(bench.agent, 'guardian/review')[0]!.data.callId).toBe('call-guardian-1')
  })

  it('defers a scalar JSON review reply', async () => {
    const bench = await harness(['42'])
    expect(await ask(bench)).toBe('unavailable')
    expect(events(bench.agent, 'guardian/review')).toHaveLength(0)
  })

  it('skips plugin-source and empty user messages when quoting intent', async () => {
    const bench = await harness(['{"decision":"allow","rationale":"fine"}'])
    // A later injected context row and an empty user message must not replace
    // the real intent quote.
    bench.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    bench.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'injected context noise' }],
      source: { kind: 'plugin', plugin: 'other', form: 'notice', summary: 'noise' },
    }), { surfaceOp: 'append' })
    await ask(bench)
    const prompt = JSON.stringify(bench.adapter.requests[0]!.messages[0])
    expect(prompt).toContain('refactor the parser')
    expect(prompt).not.toContain('noise')
  })

  it('bounds the quoted intent when the latest user message is huge', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    const adapter = new ReviewAdapter(['{"decision":"allow","rationale":"fine"}'])
    ctx.llm.registerAdapter(['guardian'], adapter)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    await ctx.plugin(guardian, { reviewerProvider: 'guardian', reviewerModel: 'guard-model', maxOutputTokens: 64, timeoutMs: 5000 })
    const session = Session.create(SessionId('guardian-long-intent'))
    const agent = { id: session.id, session } as Agent
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'y'.repeat(3000) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await ctx.approval.request({ agent, toolName: 'bash' })
    const text = (adapter.requests[0]!.messages[0] as { content: { type: string; text?: string }[] }).content
      .find(block => block.type === 'text')?.text ?? ''
    expect(text).toContain('\u2026')
    expect(text.length).toBeLessThan(3000)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    expect('default' in guardian).toBe(false)
    expect(guardian.name).toBe('guardian-approval')
    expect(guardian.inject).toEqual(['llm'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(guardian) as Record<string, unknown>
    expect(unwrapped).toBe(guardian)
    expect(typeof unwrapped.apply).toBe('function')
  })
})
