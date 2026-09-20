import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as SessionBudget from '@deepseek-ai/dsh-session-budget'
import type { Config } from '@deepseek-ai/dsh-session-budget'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the session budget guard: turn-cap rejection without a
 * step, token-cap rejection from cumulative durable usage, turn-stopping
 * cancellation with a hook cause, per-session independence, fail-loud config,
 * HMR disposal, and the real Loader load path — all driven through a real
 * agent loop against a scripted mock adapter (no network).
 */

/** Boot the core spine plus the meter and the guard; the caller registers adapters. */
async function harness(config: Config): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionBudget, config)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}

function events(agent: Agent, type: SessionEvent['type']): SessionEvent[] {
  return agent.session.snapshotEvents().filter((event): event is SessionEvent<typeof type> => event.type === type)
}

function followup(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

describe('turn cap', () => {
  it('lets capped turns run, then rejects later turns before any model request', async () => {
    const ctx = await harness({ maxTurns: 1 })
    const adapter = new MockAdapter([textResponse('first answer')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('turns-1'), { provider: 'mock', model: 'mock' })
    followup(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(events(agent, 'assistant/message')).toHaveLength(1)
    expect(events(agent, 'turn/start')).toHaveLength(1)
    // The stop boundary of turn 1 met the cap: the loop cancelled with the guard's hook cause.
    const end = events(agent, 'turn/end')[0]!
    expect(JSON.stringify(end.data)).toContain('session-budget')
    expect(JSON.stringify(end.data)).toContain('1-turn limit')

    followup(agent, 'again')
    await waitForIdle(ctx, agent)
    // Turn 2 opened and closed with no step: no request, no assistant message.
    expect(events(agent, 'turn/start')).toHaveLength(2)
    expect(events(agent, 'step/start')).toHaveLength(1)
    expect(events(agent, 'assistant/message')).toHaveLength(1)
    expect(adapter.requests).toHaveLength(1)
  })

  it('counts turns per session: one capped session never blocks another', async () => {
    const ctx = await harness({ maxTurns: 1 })
    const adapter = new MockAdapter([
      textResponse('a1'),
      textResponse('b1'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agentA = await ctx.agentLoop.create(SessionId('sessions-a'), { provider: 'mock', model: 'mock' })
    const agentB = await ctx.agentLoop.create(SessionId('sessions-b'), { provider: 'mock', model: 'mock' })
    followup(agentA, 'go')
    await waitForIdle(ctx, agentA)
    followup(agentA, 'again') // over A's cap: rejected without a request
    await waitForIdle(ctx, agentA)
    followup(agentB, 'go') // B's own budget is untouched by A's cancellation
    await waitForIdle(ctx, agentB)

    expect(events(agentA, 'assistant/message')).toHaveLength(1)
    expect(events(agentA, 'turn/start')).toHaveLength(2)
    expect(events(agentB, 'assistant/message')).toHaveLength(1)
    expect(events(agentB, 'turn/start')).toHaveLength(1)
    expect(adapter.requests).toHaveLength(2)
  })
})

describe('token cap', () => {
  it('stops new work once cumulative usage reaches the cap, keeping an in-flight turn intact', async () => {
    // textResponse reports usage {inputTokens: 10, outputTokens: text.length};
    // 'first answer' (12 chars) spends 22 tokens, past the cap of 20.
    const ctx = await harness({ maxSessionTokens: 20 })
    const adapter = new MockAdapter([textResponse('first answer')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('tokens-1'), { provider: 'mock', model: 'mock' })
    followup(agent, 'go')
    await waitForIdle(ctx, agent)

    const end = events(agent, 'turn/end')[0]!
    expect(JSON.stringify(end.data)).toContain('20-token limit')

    followup(agent, 'again')
    await waitForIdle(ctx, agent)
    expect(events(agent, 'turn/start')).toHaveLength(2)
    expect(adapter.requests).toHaveLength(1)
  })

  it('admits followups while cumulative usage stays under the cap', async () => {
    const ctx = await harness({ maxSessionTokens: 100 })
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('tokens-2'), { provider: 'mock', model: 'mock' })
    followup(agent, 'go')
    await waitForIdle(ctx, agent)
    followup(agent, 'again')
    await waitForIdle(ctx, agent)

    expect(events(agent, 'assistant/message')).toHaveLength(2)
    expect(adapter.requests).toHaveLength(2)
  })
})

describe('config validation fails loud', () => {
  it('rejects a config where every limit is 0', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await expect(ctx.plugin(SessionBudget, { maxTurns: 0, maxSessionTokens: 0 })).rejects.toThrow(/at least one limit/)
  })

  it('rejects a negative or fractional limit at load', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await expect(ctx.plugin(SessionBudget, { maxTurns: -1 })).rejects.toThrow(/integer >= 0/)
    const ctx2 = new Context()
    await mountAgentLoopTestDependencies(ctx2)
    await ctx2.plugin(AgentLoop, { agents: [] })
    await expect(ctx2.plugin(SessionBudget, { maxSessionTokens: 1.5 })).rejects.toThrow(/integer >= 0/)
  })

  it('fails loud at first enforcement when the token projection is absent', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx) // no TokenMeter: no tokenUsage projection
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SessionBudget, { maxSessionTokens: 100 })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('one')]))
    const agent = await ctx.agentLoop.create(SessionId('no-projection'), { provider: 'mock', model: 'mock' })
    followup(agent, 'go')
    await waitForIdle(ctx, agent)
    const end = events(agent, 'turn/end')[0]!
    expect(JSON.stringify(end.data)).toContain('tokenUsage session projection')
  })
})

describe('session-budget disposal (HMR safety)', () => {
  it('removes both listeners when the plugin fiber disposes', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(AgentLoop, { agents: [] })
    const fiber = await ctx.plugin(SessionBudget, { maxTurns: 1 })
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('dispose-1'), { provider: 'mock', model: 'mock' })
    followup(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(events(agent, 'assistant/message')).toHaveLength(1)
    await fiber.dispose()
    followup(agent, 'again')
    await waitForIdle(ctx, agent)
    expect(events(agent, 'assistant/message')).toHaveLength(2)
  })
})

describe('dsh-session-budget real-load-path guard', () => {
  it('has no default export and keeps name/inject through unwrapExports', () => {
    expect('default' in SessionBudget).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(SessionBudget) as Record<string, unknown>
    expect(unwrapped).toBe(SessionBudget)
    expect(unwrapped.name).toBe('session-budget')
    expect(unwrapped.inject).toEqual(['sessionProjections'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})

describe('session-budget real Loader composition through cordis.yml', () => {
  it('caps turns in a composition booted through the Loader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-budget-loader-'))
    const ctx = new Context()
    try {
      const configPath = join(root, 'cordis.yml')
      await writeFile(configPath, [
        "- name: '@deepseek-ai/dsh-agent'",
        "- name: '@deepseek-ai/dsh-llm'",
        "- name: '@deepseek-ai/dsh-session'",
        "- name: '@deepseek-ai/dsh-system-prompt'",
        "- name: '@deepseek-ai/dsh-tools'",
        "- name: '@deepseek-ai/dsh-session-projection'",
        "- name: '@deepseek-ai/dsh-token-meter'",
        "- name: '@deepseek-ai/dsh-session-budget'",
        '  config:',
        '    maxTurns: 1',
        "- name: '@deepseek-ai/dsh-agent-loop'",
        '',
      ].join('\n'))
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      const modules = new Map<string, unknown>([
        ['@deepseek-ai/dsh-agent', AgentRegistry],
        ['@deepseek-ai/dsh-llm', LlmRuntime],
        ['@deepseek-ai/dsh-session', SessionStore],
        ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
        ['@deepseek-ai/dsh-tools', ToolRuntime],
        ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
        ['@deepseek-ai/dsh-token-meter', TokenMeter],
        ['@deepseek-ai/dsh-session-budget', SessionBudget],
        ['@deepseek-ai/dsh-agent-loop', AgentLoop],
      ])
      ctx.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
          return modules.get(specifier)
        },
      } as unknown as NonNullable<typeof ctx.loader.internal>
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
      await ctx.loader.await()
      for (const entry of ctx.loader.entries()) await entry.fiber?.await()

      ctx.llm.registerAdapter(['scripted'], new MockAdapter([textResponse('one')]))
      const agent = await ctx.agentLoop.create(SessionId('budget-loader'), { provider: 'scripted', model: 'm' })
      await agent.whenIdle()
      const idle = agent.whenIdle()
      followup(agent, 'classify')
      await idle
      const second = agent.whenIdle()
      followup(agent, 'again')
      await second
      const messages = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(messages).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
