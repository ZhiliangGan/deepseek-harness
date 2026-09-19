// Proves the config surface is real configurability and not a constant: the
// standing schema and retry budget set in a cordis.yml booted through the real
// Loader change the enforcement the agent actually runs, and self-contained
// misconfiguration fails at load.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as StructuredOutput from '@deepseek-ai/dsh-structured-output'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** One deterministic scripted reply pair: invalid text first, JSON second. */
class RetryAdapter extends LlmAdapter {
  private served = false

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = this.served ? '{"status":"ok"}' : 'definitely not json'
    this.served = true
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

/**
 * Boot a cordis.yml carrying the given structured-output config block.
 * @param configLines - YAML lines nested under the plugin's `config:` key.
 * @returns the booted context with the loader-mounted services.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-structured-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-structured-output'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-structured-output', StructuredOutput],
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
  return ctx
}

describe('structured-output real Loader composition through cordis.yml', () => {
  it('arms a standing schema from config and enforces it end to end', async () => {
    const ctx = await boot([
      '    schema:',
      '      type: object',
      '      required: [status]',
      '      additionalProperties: false',
      '      properties:',
      '        status:',
      '          type: string',
      '          enum: [ok, error]',
      '    maxRetries: 1',
    ])
    ctx.llm.registerAdapter(['scripted'], new RetryAdapter())
    const agent = ctx.agentLoop.create(SessionId('structured-loader'), { provider: 'scripted', model: 'm' })
    await agent.whenIdle()
    const idle = agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'classify' }], source: { kind: 'user' } }))
    await idle

    const outcomes = agent.session.events.filter(event => event.type === 'structured-output/outcome')
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.data).toEqual({ turn: 1, valid: true, attempts: 2, value: { status: 'ok' } })
  }, 30_000)

  it.each([
    { label: 'is not a JSON Schema object', lines: ['    schema: 42'], failure: /schema/ },
    { label: 'is a negative retry budget', lines: ['    maxRetries: -1'], failure: /number/ },
  ])('fails loading when the config $label', async ({ lines, failure }) => {
    await expect(boot(lines)).rejects.toThrow(failure)
  }, 30_000)
})
