import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal

/**
 * Drives the REAL plugin body: mounts `dsh-tool-notes` on a real `ToolRuntime`
 * and invokes the registered tools through `ctx.tools.execute`, with a fake
 * parent Agent carrying a real `Session` — so the appends the tools make are
 * observable on a genuine session log (only the agent wrapper is a stand-in;
 * the session and the tools are the shipping code).
 */

/** A parent Agent backed by a real Session — the tools read `agent.session`. */
function agentWithSession(id = 'parent-1'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

async function setup(overrides: Partial<tool.Config> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, { maxNotes: 64, maxNoteChars: 8000, ...overrides })
  return ctx
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, over: { agent?: Agent | undefined } = {}) {
  const agent = 'agent' in over ? over.agent : agentWithSession()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

const TOOL_NAMES = ['list_notes', 'read_note', 'write_note', 'append_note', 'delete_note']

describe('dsh-tool-notes', () => {
  it('registers the five notes tools', async () => {
    const ctx = await setup()
    const names = ctx.tools.schemas().map(s => s.name)
    for (const name of TOOL_NAMES) expect(names).toContain(name)
    const write = ctx.tools.schemas().find(s => s.name === 'write_note')!
    expect(write.description).toContain('survive context compaction')
    const props = (write.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['content', 'id'])
  })

  it('write_note creates a note and appends a whole-value notes/change event', async () => {
    const ctx = await setup()
    const agent = agentWithSession('writer')
    const result = await call(ctx, 'write_note', { id: 'decisions', content: 'use SQLite for the queue' }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected write_note success')
    expect(result.value).toEqual({ id: 'decisions', revision: 1, chars: 24, created: true })

    const events = agent.session.snapshotEvents().filter(e => e.type === 'notes/change')
    expect(events).toHaveLength(1)
    const note = (events[0]!.data as { note: { id: string; content: string; revision: number } }).note
    expect(note).toMatchObject({ id: 'decisions', content: 'use SQLite for the queue', revision: 1 })
  })

  it('write_note replaces the note, incrementing revision and keeping createdAt', async () => {
    const ctx = await setup()
    const agent = agentWithSession('replacer')
    await call(ctx, 'write_note', { id: 'a', content: 'first' }, { agent })
    await call(ctx, 'write_note', { id: 'a', content: 'second version' }, { agent })

    const events = agent.session.snapshotEvents().filter(e => e.type === 'notes/change')
    expect(events).toHaveLength(2)
    const first = (events[0]!.data as { note: { createdAt: number } }).note
    const second = (events[1]!.data as { note: { revision: number; createdAt: number; content: string } }).note
    expect(second.revision).toBe(2)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.content).toBe('second version')
  })

  it('append_note creates when absent and extends with newline-joined lines otherwise', async () => {
    const ctx = await setup()
    const agent = agentWithSession('appender')
    const created = await call(ctx, 'append_note', { id: 'findings', text: 'first finding' }, { agent })
    expect(created.isError).toBe(false)
    if (created.isError) throw new Error('expected append_note success')
    expect(created.value).toEqual({ id: 'findings', revision: 1, chars: 13, created: true })

    const extended = await call(ctx, 'append_note', { id: 'findings', text: 'second finding' }, { agent })
    expect(extended.isError).toBe(false)
    if (extended.isError) throw new Error('expected append_note success')
    expect(extended.value).toEqual({ id: 'findings', revision: 2, chars: 28, created: false })
    expect(text(extended)).toContain('Appended to note "findings"')

    const note = (agent.session.snapshotEvents().findLast(e => e.type === 'notes/change')!.data as { note: { content: string } }).note
    expect(note.content).toBe('first finding\nsecond finding')
  })

  it('list_notes reports creation order with first-line previews', async () => {
    const ctx = await setup()
    const agent = agentWithSession('lister')
    await call(ctx, 'write_note', { id: 'z-note', content: 'written first' }, { agent })
    await call(ctx, 'write_note', { id: 'a-note', content: 'line one\nline two' }, { agent })
    await call(ctx, 'write_note', { id: 'z-note', content: 'rewritten, still first' }, { agent })

    const result = await call(ctx, 'list_notes', {}, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected list_notes success')
    expect(result.value).toEqual({
      notes: [
        { id: 'z-note', preview: 'rewritten, still first', chars: 22, revision: 2 },
        { id: 'a-note', preview: 'line one', chars: 17, revision: 1 },
      ],
    })
    expect(text(result)).toBe('2 note(s): z-note, a-note')
  })

  it('list_notes caps a long first-line preview and reports an empty set before any write', async () => {
    const ctx = await setup()
    const empty = await call(ctx, 'list_notes', {})
    expect(empty.isError).toBe(false)
    if (empty.isError) throw new Error('expected list_notes success')
    expect(empty.value).toEqual({ notes: [] })
    expect(text(empty)).toBe('No notes yet.')

    const agent = agentWithSession('preview')
    const longLine = 'x'.repeat(200)
    const result = await call(ctx, 'write_note', { id: 'long', content: longLine }, { agent })
    expect(result.isError).toBe(false)
    const listed = await call(ctx, 'list_notes', {}, { agent })
    expect(listed.isError).toBe(false)
    if (listed.isError) throw new Error('expected list_notes success')
    const preview = (listed.value as { notes: { preview: string }[] }).notes[0]!.preview
    expect(preview).toHaveLength(80)
    expect(preview.endsWith('…')).toBe(true)
  })

  it('read_note returns the full content and rejects unknown ids', async () => {
    const ctx = await setup()
    const agent = agentWithSession('reader')
    await call(ctx, 'write_note', { id: 'decisions', content: 'ship on Friday is fine' }, { agent })
    const result = await call(ctx, 'read_note', { id: 'decisions' }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected read_note success')
    expect(result.value).toEqual({ id: 'decisions', content: 'ship on Friday is fine', revision: 1 })
    expect(text(result)).toContain('ship on Friday is fine')

    const missing = await call(ctx, 'read_note', { id: 'missing' }, { agent })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('unknown note id "missing"')
  })

  it('delete_note removes the note and a second delete fails loud', async () => {
    const ctx = await setup()
    const agent = agentWithSession('deleter')
    await call(ctx, 'write_note', { id: 'temp', content: 'scratch' }, { agent })
    const result = await call(ctx, 'delete_note', { id: 'temp' }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected delete_note success')
    expect(result.value).toEqual({ id: 'temp', deleted: true })

    const lastEvent = agent.session.snapshotEvents().findLast(e => e.type === 'notes/change')!.data
    expect(lastEvent).toEqual({ operation: 'delete', id: 'temp' })

    const again = await call(ctx, 'delete_note', { id: 'temp' }, { agent })
    expect(again.isError).toBe(true)
    expect(text(again)).toContain('unknown note id "temp"')
  })

  describe('capacity policy', () => {
    it('rejects a create beyond maxNotes, listing the current ids', async () => {
      const ctx = await setup({ maxNotes: 2 })
      const agent = agentWithSession('capped')
      await call(ctx, 'write_note', { id: 'one', content: 'a' }, { agent })
      await call(ctx, 'write_note', { id: 'two', content: 'b' }, { agent })
      const third = await call(ctx, 'write_note', { id: 'three', content: 'c' }, { agent })
      expect(third.isError).toBe(true)
      expect(text(third)).toContain('note limit reached (2)')
      expect(text(third)).toContain('one, two')
      expect(agent.session.snapshotEvents().filter(e => e.type === 'notes/change')).toHaveLength(2)

      // Replacing an existing id within the limit still succeeds.
      const replace = await call(ctx, 'write_note', { id: 'one', content: 'a2' }, { agent })
      expect(replace.isError).toBe(false)

      // append_note create path enforces the same limit.
      const appended = await call(ctx, 'append_note', { id: 'three', text: 'c' }, { agent })
      expect(appended.isError).toBe(true)
      expect(text(appended)).toContain('note limit reached (2)')
    })

    it('rejects content at and beyond the maxNoteChars boundary', async () => {
      const ctx = await setup({ maxNoteChars: 10 })
      const agent = agentWithSession('char-capped')
      const exact = await call(ctx, 'write_note', { id: 'exact', content: '0123456789' }, { agent })
      expect(exact.isError).toBe(false)

      const over = await call(ctx, 'write_note', { id: 'over', content: '01234567890' }, { agent })
      expect(over.isError).toBe(true)
      expect(text(over)).toContain('is 11 chars')
      expect(text(over)).toContain('within 10 chars')
      expect(agent.session.snapshotEvents().some(e => (e.data as { note?: { id: string } }).note?.id === 'over')).toBe(false)
    })

    it('bounds the complete note on append, not just the appended text', async () => {
      const ctx = await setup({ maxNoteChars: 10 })
      const agent = agentWithSession('append-capped')
      await call(ctx, 'append_note', { id: 'log', text: '01234567' }, { agent })
      const grows = await call(ctx, 'append_note', { id: 'log', text: '89' }, { agent })
      expect(grows.isError).toBe(true)
      expect(text(grows)).toContain('would grow note "log" to 11 chars')

      // '01234567' + '\n' + '8' is exactly 10 chars: the exact boundary fits.
      const fits = await call(ctx, 'append_note', { id: 'log', text: '8' }, { agent })
      expect(fits.isError).toBe(false)
    })
  })

  it.each([
    'Decisions',
    '1decisions',
    'decisions--log',
    'decisions-',
    '-decisions',
    '',
    'a'.repeat(65),
    'decisions.log',
  ])('rejects the malformed note id %s', async (id) => {
    const ctx = await setup()
    const result = await call(ctx, 'write_note', { id, content: 'x' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('invalid note id')
  })

  it('accepts honest multi-segment lower-kebab ids', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'write_note', { id: 'verify-steps-2', content: 'x' })
    expect(result.isError).toBe(false)
  })

  it.each(TOOL_NAMES)('rejects a non-agent caller for %s (no owning session)', async (name) => {
    const ctx = await setup()
    const args: Record<string, unknown> = name === 'list_notes'
      ? {}
      : name === 'append_note' ? { id: 'a', text: 'x' }
        : name === 'write_note' ? { id: 'a', content: 'x' }
          : { id: 'a' }
    const result = await call(ctx, name, args, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('owning agent session')
  })

  it('rejects whitespace-only content before any durable append', async () => {
    const ctx = await setup()
    const agent = agentWithSession('blank')
    const result = await call(ctx, 'write_note', { id: 'a', content: '   \n  ' }, { agent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('must be a non-empty string')
    expect(agent.session.snapshotEvents().some(e => e.type === 'notes/change')).toBe(false)
  })

  it('rejects a call missing a required argument at the registry schema boundary', async () => {
    const ctx = await setup()
    const agent = agentWithSession('missing-arg')
    const result = await call(ctx, 'write_note', { id: 'a' }, { agent })
    expect(result.isError).toBe(true)
    expect(agent.session.snapshotEvents().some(e => e.type === 'notes/change')).toBe(false)
  })

  it('presents each call with a stable generic card', async () => {
    const ctx = await setup()
    expect(ctx.tools.get('list_notes')!.presentCall?.({})).toEqual({ card: 'generic', title: 'List notes', kind: 'other' })
    expect(ctx.tools.get('read_note')!.presentCall?.({ id: 'a' })).toEqual({ card: 'generic', title: 'Read note', kind: 'other', rawInput: 'a' })
    expect(ctx.tools.get('write_note')!.presentCall?.({ id: 'a', content: 'x' })).toEqual({ card: 'generic', title: 'Write note', kind: 'other', rawInput: 'a' })
    expect(ctx.tools.get('append_note')!.presentCall?.({ id: 'a', text: 'x' })).toEqual({ card: 'generic', title: 'Append to note', kind: 'other', rawInput: 'a' })
    expect(ctx.tools.get('delete_note')!.presentCall?.({ id: 'a' })).toEqual({ card: 'generic', title: 'Delete note', kind: 'other', rawInput: 'a' })
  })

  it('unregisters the tools when the contributing fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(tool, { maxNotes: 8, maxNoteChars: 100 })
    expect(TOOL_NAMES.every(name => ctx.tools.schemas().some(s => s.name === name))).toBe(true)
    await fiber.dispose()
    expect(TOOL_NAMES.some(name => ctx.tools.schemas().some(s => s.name === name))).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    // A default export would make Loader unwrap only apply and drop `inject`.
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-notes')
    expect(tool.inject).toEqual(['tools'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tool) as Record<string, unknown>
    expect(unwrapped).toBe(tool)
    expect(unwrapped.name).toBe('tool-notes')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
