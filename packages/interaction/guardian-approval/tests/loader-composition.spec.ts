// Proves the config surface is real configurability through a cordis.yml
// booted by the real Loader: the reviewer route set in config reaches the
// auxiliary review call, and self-contained misconfiguration fails at load.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as Guardian from '@deepseek-ai/dsh-guardian-approval'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Serves one scripted review reply per call. */
class ScriptedAdapter extends LlmAdapter {
  private calls = 0

  constructor(private readonly reply: string) {
    super()
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    expect(options.provider).toBe('review-route')
    return this.streamReply()
  }

  private async *streamReply(): AsyncGenerator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Boot a cordis.yml carrying the given guardian config block.
 * @param configLines - YAML lines nested under the plugin's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-guardian-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-user-approval'",
    "- name: '@deepseek-ai/dsh-guardian-approval'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-user-approval', ApprovalService],
    ['@deepseek-ai/dsh-guardian-approval', Guardian],
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
  return ctx
}

describe('guardian-approval real Loader composition through cordis.yml', () => {
  it('routes the review call through the configured reviewer route', async () => {
    const ctx = await boot([
      '    reviewerProvider: review-route',
      '    reviewerModel: review-model',
      '    maxOutputTokens: 128',
      '    timeoutMs: 5000',
    ])
    ctx.llm.registerAdapter(['review-route'], new ScriptedAdapter('{"decision":"allow","rationale":"routine"}'))
    const session = Session.create(SessionId('guardian-loader'))
    const agent = { id: session.id, session } as never
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'run tests' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const outcome = await ctx.approval.request({ agent, toolName: 'bash', reason: 'unsaved prefix' })
    expect(outcome).toBe('allowed-once')
    const review = session.snapshotEvents().find(event => event.type === 'guardian/review')
    expect(review).toBeDefined()
  }, 30_000)

  it.each([
    { label: 'omits the reviewer provider', lines: ['    reviewerModel: m'], failure: /reviewerProvider/ },
    { label: 'omits the reviewer model', lines: ['    reviewerProvider: p'], failure: /reviewerModel/ },
    { label: 'sets a zero timeout', lines: ['    reviewerProvider: p', '    reviewerModel: m', '    timeoutMs: 0'], failure: /expected number >= 1/ },
  ])('fails loading when the config $label', async ({ lines, failure }) => {
    await expect(boot(lines)).rejects.toThrow(failure)
  }, 30_000)
})
