// Proves `maxNotes`/`maxNoteChars` are real configurability and not constants:
// the caps are set in a cordis.yml booted through the real Loader, and the
// durable tool behavior follows them end to end against a real session log.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolNotes from '@deepseek-ai/dsh-tool-notes'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('notes-loader-agent')
  const session = Session.create(id)
  const value: Agent = {
    id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a cordis.yml carrying the given tool-notes config block.
 * @param configLines - YAML lines nested under the tool's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-notes-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-notes'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-notes', ToolNotes],
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

describe('tool-notes real Loader composition through cordis.yml', () => {
  it('applies defaults when the config block is omitted', async () => {
    const ctx = await boot([])
    const owner = agent(ctx)
    // One write below the default caps succeeds and lands on the durable log.
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('notes-default'),
      name: 'write_note',
      arguments: { id: 'decisions', content: 'default caps apply' },
      agent: owner,
    })
    expect(result.isError).toBe(false)
    expect(owner.session.events.findLast(e => e.type === 'notes/change')).toBeDefined()
  }, 30_000)

  it('honors maxNotes set through cordis.yml end to end', async () => {
    const ctx = await boot(['    maxNotes: 1'])
    const owner = agent(ctx)
    const first = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('notes-one'),
      name: 'write_note',
      arguments: { id: 'one', content: 'fits' },
      agent: owner,
    })
    expect(first.isError).toBe(false)

    const second = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('notes-two'),
      name: 'write_note',
      arguments: { id: 'two', content: 'over' },
      agent: owner,
    })
    expect(second.isError).toBe(true)
    expect(resultText(second)).toContain('note limit reached (1)')
    expect(resultText(second)).toContain('one')
    expect(owner.session.events.filter(e => e.type === 'notes/change')).toHaveLength(1)
  }, 30_000)

  it('honors maxNoteChars set through cordis.yml end to end', async () => {
    const ctx = await boot(['    maxNoteChars: 5'])
    const owner = agent(ctx)
    const over = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('notes-chars'),
      name: 'append_note',
      arguments: { id: 'log', text: '0123456789' },
      agent: owner,
    })
    expect(over.isError).toBe(true)
    expect(resultText(over)).toContain('is 10 chars')
    expect(owner.session.events.some(e => e.type === 'notes/change')).toBe(false)
  }, 30_000)

  it.each([
    { label: 'is zero', configLines: ['    maxNotes: 0'], failure: 'expected number >= 1' },
    { label: 'is fractional', configLines: ['    maxNoteChars: 1.5'], failure: 'expected number multiple of 1' },
    { label: 'is not a number', configLines: ['    maxNotes: "many"'], failure: 'expected number' },
  ])('fails loading when a cap $label', async ({ configLines, failure }) => {
    // The policy is self-contained, so misconfiguration fails at load: the
    // entry's apply rejects and boot never reaches a running tool.
    await expect(boot(configLines)).rejects.toThrow(failure)
  }, 30_000)
})
