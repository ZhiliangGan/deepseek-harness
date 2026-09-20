import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import VerifierService from '@deepseek-ai/dsh-verifier'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ToolVerifier from '@deepseek-ai/dsh-tool-verifier'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the verify_output tool: the model calls the tool, the
 * verdict returns as an ordinary tool result, the subject defaults to the
 * agent's latest answer text, explicit subjects pass through, and a call with
 * no candidate fails as a tool error — driven through a real agent loop with a
 * scripted main adapter and a scripted judge adapter (no network).
 */

/** A judge adapter that replies with one fixed verdict and records its prompts. */
class FixedJudge extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly reply: string) {
    super()
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    return this.streamReply()
  }

  private async *streamReply(): AsyncGenerator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.reply } }
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(judgeReply: string): Promise<{ ctx: Context; judge: FixedJudge }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(VerifierService, { judgeProvider: 'mock-judge', judgeModel: 'judge-model' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ToolVerifier)
  const judge = new FixedJudge(judgeReply)
  ctx.llm.registerAdapter(['mock-judge'], judge)
  return { ctx, judge }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}

function toolResults(agent: Agent): SessionEvent<'tool/result'>[] {
  return agent.session.snapshotEvents().filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
}

function followup(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

const PASS_REPLY = JSON.stringify({ verdict: 'pass', score: 0.9, rationale: 'checks out' })

describe('verify_output through the agent loop', () => {
  it('returns the judge verdict as a tool result and defaults the subject to the latest answer text', async () => {
    const { ctx, judge } = await harness(PASS_REPLY)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      textResponse('revenue grew 12 percent'), // the candidate the next turn verifies
      toolCallResponse('c1', 'verify_output', { task: 'state the revenue growth rate' }),
      textResponse('verified: revenue grew 12 percent'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('tool-v1'), { provider: 'mock', model: 'mock' })
    followup(agent, 'what was the growth rate?')
    await waitForIdle(ctx, agent)
    followup(agent, 'verify your answer')
    await waitForIdle(ctx, agent)

    const result = toolResults(agent)[0]!.data.message.content[0]
    expect(result.isError ?? false).toBe(false)
    expect(JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}')).toEqual({
      verdict: 'pass', score: 0.9, rationale: 'checks out',
      judge: { provider: 'mock-judge', model: 'judge-model' },
    })
    // The subject defaulted to the agent's latest assistant text.
    const prompt = judge.requests[0]!.messages[0]!.content[0]!
    expect(prompt).toMatchObject({ type: 'text' })
    if (prompt.type === 'text') expect(prompt.text).toContain('revenue grew 12 percent')
  })

  it('passes an explicit subject and criteria through to the judge', async () => {
    const { ctx, judge } = await harness(PASS_REPLY)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('c1', 'verify_output', { task: 't', subject: 'explicit candidate', criteria: 'no unsupported claims' }),
      textResponse('done'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('tool-v2'), { provider: 'mock', model: 'mock' })
    followup(agent, 'verify this candidate')
    await waitForIdle(ctx, agent)

    expect(judge.requests).toHaveLength(1)
    const prompt = judge.requests[0]!.messages[0]!.content[0]!
    expect(prompt).toMatchObject({ type: 'text' })
    if (prompt.type === 'text') {
      expect(prompt.text).toContain('explicit candidate')
      expect(prompt.text).toContain('no unsupported claims')
    }
  })

  it('fails as a tool error when no candidate can be resolved', async () => {
    const { ctx, judge } = await harness(PASS_REPLY)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('c1', 'verify_output', { task: 't' }), // no prior assistant text, no subject
      textResponse('moving on'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('tool-v3'), { provider: 'mock', model: 'mock' })
    followup(agent, 'verify')
    await waitForIdle(ctx, agent)

    expect(judge.requests).toHaveLength(0)
    const result = toolResults(agent)[0]!.data.message.content[0]
    expect(result.isError).toBe(true)
  })
  it('treats a whitespace-only subject as absent and falls back to the latest answer text', async () => {
    const { ctx, judge } = await harness(PASS_REPLY)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      textResponse('growth was 12 percent'),
      toolCallResponse('c1', 'verify_output', { task: 't', subject: '   ' }),
      textResponse('done'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('tool-v4'), { provider: 'mock', model: 'mock' })
    followup(agent, 'answer, then verify')
    await waitForIdle(ctx, agent)
    followup(agent, 'verify')
    await waitForIdle(ctx, agent)

    const prompt = judge.requests[0]!.messages[0]!.content[0]!
    expect(prompt).toMatchObject({ type: 'text' })
    if (prompt.type === 'text') expect(prompt.text).toContain('growth was 12 percent')
  })

  it('fails a direct execute without an agent context', async () => {
    const { ctx, judge } = await harness(PASS_REPLY)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('d1'),
      name: 'verify_output',
      arguments: { task: 't', subject: 's' },
    })
    expect(result.isError).toBe(true)
    expect(judge.requests).toHaveLength(0)
  })
})

describe('dsh-tool-verifier real-load-path guard', () => {
  it('has no default export and keeps name/inject through unwrapExports', () => {
    expect('default' in ToolVerifier).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(ToolVerifier) as Record<string, unknown>
    expect(unwrapped).toBe(ToolVerifier)
    expect(unwrapped.name).toBe('tool-verifier')
    expect(unwrapped.inject).toEqual(['tools', 'verifier'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
