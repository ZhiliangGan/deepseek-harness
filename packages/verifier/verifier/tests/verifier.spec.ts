import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import VerifierService from '@deepseek-ai/dsh-verifier'
import type { VerifierReview } from '@deepseek-ai/dsh-verifier'

/**
 * Behavior suite for the verifier service: verdict parsing (plain, fenced,
 * prose-wrapped), unusable-reply fail-closed outcomes (wrong shape, wrong
 * verdict, bad score, empty rationale, tool-call reply, timeout), bounded
 * prompts and rationales, request shape, and fail-loud construction — all
 * against a scripted in-process adapter (no network).
 */

/** One complete text reply as stream chunks. */
function replyChunks(reply: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: reply },
    { type: 'block-end', index: 0, block: { type: 'text', text: reply } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One scripted single-reply adapter; tests push each reply before the call. */
class ScriptedJudge extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  /** Pending entries; each model call consumes the first. */
  readonly script: (StreamChunk[] | 'hang' | { throw: string })[]

  constructor(script: (StreamChunk[] | 'hang' | { throw: string })[]) {
    super()
    this.script = script
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedJudge: script exhausted')
    if (entry === 'hang') {
      return this.hang(options)
    }
    if (typeof entry === 'object' && !Array.isArray(entry)) {
      return this.throwing(entry.throw)
    }
    return this.streamChunks(entry)
  }

  private async *hang(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    await new Promise<void>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
  }

  private throwing(message: string): AsyncGenerator<StreamChunk> {
    return (async function* fail(): AsyncGenerator<StreamChunk> {
      throw message
    })()
  }

  private async *streamChunks(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
    for (const chunk of chunks) yield chunk
  }
}

function verdictReply(verdict: string, score: number, rationale: string): string {
  return JSON.stringify({ verdict, score, rationale })
}

async function setup(config: { maxOutputTokens?: number; timeoutMs?: number } = {}): Promise<{ ctx: Context; adapter: ScriptedJudge }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  const adapter = new ScriptedJudge([])
  ctx.llm.registerAdapter(['mock-judge'], adapter)
  await ctx.plugin(VerifierService, {
    judgeProvider: 'mock-judge',
    judgeModel: 'judge-model',
    ...config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {},
    ...config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {},
  })
  return { ctx, adapter }
}

let sessionSeq = 0

async function review(ctx: Context, task = 'summarize the report', subject = 'the report says revenue grew 12%'): Promise<VerifierReview> {
  const session = ctx.sessions.create(SessionId(`v${++sessionSeq}`))
  return await ctx.verifier.review({ task, subject, session })
}

describe('verdict parsing', () => {
  it('returns a parsed pass verdict with route facts', async () => {
    const { ctx, adapter } = await setup()
    adapter.script.push(replyChunks(verdictReply('pass', 0.9, 'numbers match the source')))
    const result = await review(ctx)
    expect(result).toEqual({
      verdict: 'pass', score: 0.9, rationale: 'numbers match the source',
      judge: { provider: 'mock-judge', model: 'judge-model' },
    })
    expect(adapter.requests[0]!.system).toContain('independent verifier')
    expect(adapter.requests[0]!.purpose).toBe('guardian-review')
    expect(adapter.requests[0]!.temperature).toBe(0)
    expect(adapter.requests[0]!.maxTokens).toBe(512)
  })

  it('parses a fenced reply and a prose-wrapped reply', async () => {
    const { ctx, adapter } = await setup()
    adapter.script.push(replyChunks('```json\n' + verdictReply('fail', 0.1, 'missed the margin requirement') + '\n```'))
    expect(await review(ctx)).toMatchObject({ verdict: 'fail', score: 0.1 })

    adapter.script.push(replyChunks('Here you go: ' + verdictReply('pass', 1, 'ok') + ' as requested.'))
    expect(await review(ctx)).toMatchObject({ verdict: 'pass', score: 1 })
  })

  it('carries optional criteria into the prompt and bounds task, subject, and rationale', async () => {
    const { ctx, adapter } = await setup()
    adapter.script.push(replyChunks(verdictReply('uncertain', 0.5, 'x'.repeat(600))))
    const session = ctx.sessions.create(SessionId(`v-criteria-${++sessionSeq}`))
    const result = await ctx.verifier.review({
      task: 't'.repeat(3000),
      subject: 's'.repeat(9000),
      criteria: 'must cite the filing date',
      session,
    })
    const prompt = adapter.requests[0]!.messages[0]!.content[0]!
    expect(prompt).toMatchObject({ type: 'text' })
    if (prompt.type === 'text') {
      expect(prompt.text).toContain('must cite the filing date')
      expect(prompt.text).toContain('(+1000 more chars)')
      expect(prompt.text).not.toContain('s'.repeat(9000))
    }
    expect(result.rationale.length).toBeLessThanOrEqual(400)
    expect(result.rationale.endsWith('…')).toBe(true)
  })
})

describe('fail-closed outcomes', () => {
  async function expectUncertain(adapter: ScriptedJudge, ctx: Context, cause: string): Promise<void> {
    void adapter
    const result = await review(ctx)
    expect(result.verdict).toBe('uncertain')
    expect(result.score).toBe(0.5)
    expect(result.rationale).toContain(cause)
    expect(result.judge).toEqual({ provider: 'mock-judge', model: 'judge-model' })
  }

  it('settles uncertain on a non-JSON reply', async () => {
    const { ctx, adapter } = await setup()
    adapter.script.push(replyChunks('looks fine to me'))
    await expectUncertain(adapter, ctx, 'not a usable verdict object')
  })

  it.each([
    ['wrong verdict value', verdictReply('maybe', 0.5, 'r')],
    ['out-of-range score', verdictReply('pass', 1.5, 'r')],
    ['non-numeric score', '{"verdict":"pass","score":"high","rationale":"r"}'],
    ['empty rationale', verdictReply('pass', 0.9, '  ')],
  ])('settles uncertain on %s', async (_label, reply) => {
    const { ctx, adapter } = await setup()
    adapter.script.push(replyChunks(reply))
    await expectUncertain(adapter, ctx, 'not a usable verdict object')
  })

  it('settles uncertain on a tool-call reply', async () => {
    const { ctx, adapter } = await setup()
    adapter.script.push([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: ToolCallId('c1'), name: 'probe', argumentsDelta: '{}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('c1'), name: 'probe', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await expectUncertain(adapter, ctx, 'tool call')
  })

  it('settles uncertain when the judge call times out', async () => {
    const { ctx, adapter } = await setup({ timeoutMs: 20 })
    adapter.script.push('hang')
    await expectUncertain(adapter, ctx, 'no verdict')
  })

  it('settles uncertain on a non-object JSON reply', async () => {
    const { ctx, adapter } = await setup()
    adapter.script.push(replyChunks('42'))
    await expectUncertain(adapter, ctx, 'not a usable verdict object')
  })

  it('settles uncertain when the transport fails mid-stream', async () => {
    const { ctx, adapter } = await setup()
    adapter.script.push({ throw: 'transport said no' })
    await expectUncertain(adapter, ctx, 'not a usable verdict object')
  })
})

describe('construction fails loud', () => {
  it('rejects a missing judge route on direct construction', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(VerifierService, { judgeModel: 'm' } as never)).rejects.toThrow(/judgeProvider/)
    const ctx2 = new Context()
    await ctx2.plugin(LlmRuntime)
    await expect(ctx2.plugin(VerifierService, { judgeProvider: 'p' } as never)).rejects.toThrow(/judgeModel/)
  })
})

describe('dsh-verifier load-path shape', () => {
  it('default-exports the service class and publishes the types', () => {
    expect(typeof VerifierService).toBe('function')
    expect(VerifierService.name).toBe('VerifierService')
  })
})
