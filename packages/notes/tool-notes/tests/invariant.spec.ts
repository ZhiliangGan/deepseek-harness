import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type SessionEvent } from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolNotes from '@deepseek-ai/dsh-tool-notes'
import * as NotesInvariant from '@deepseek-ai/dsh-tool-notes/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ToolNotes, { maxNotes: 8, maxNoteChars: 200 })
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(NotesInvariant)
  return ctx
}

interface UpsertPayload {
  id: string
  content: string
  revision: number
  createdAt: number
  updatedAt: number
}

function upsert(seq: number, note: UpsertPayload): SessionEvent {
  return { type: 'notes/change', seq, time: 0, data: { operation: 'upsert', note } }
}

function deleteEvent(seq: number, id: string): SessionEvent {
  return { type: 'notes/change', seq, time: 0, data: { operation: 'delete', id } }
}

function coherentStream(): SessionEvent[] {
  return [
    upsert(0, { id: 'decisions', content: 'first', revision: 1, createdAt: 10, updatedAt: 10 }),
    upsert(1, { id: 'decisions', content: 'first\nsecond', revision: 2, createdAt: 10, updatedAt: 20 }),
    deleteEvent(2, 'decisions'),
    upsert(3, { id: 'fresh', content: 'recreated at revision 1', revision: 1, createdAt: 30, updatedAt: 30 }),
  ]
}

describe('notes stream invariants', () => {
  it('accepts a coherent durable stream and its live continuation through the real tool', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => {
      for (const event of coherentStream()) session.append(event.type, event.data)
    }).not.toThrow()

    const agent = { id: session.id, session } as never
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'notes-inv-live' as never,
      name: 'write_note',
      arguments: { id: 'live-note', content: 'written through the tool' },
      agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) {
      const message = result.content.filter(b => (b as { type: string }).type === 'text').map(b => (b as { text?: string }).text).join('')
      throw new Error(`write_note failed: ${message}`)
    }

    // A re-delete of the already-deleted id stays a coherent no-op.
    expect(() => { session.append('notes/change', { operation: 'delete', id: 'decisions' }) }).not.toThrow()
  })

  it('ignores unrelated dispatches and session events', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('tools/change')
      // An unrelated real append rides the same dispatch/publication path.
      ctx.sessions.create().append('turn/start', { turn: 1 })
    }).not.toThrow()
  })

  it.each([
    ['skips the create revision', [upsert(0, { id: 'a', content: 'x', revision: 2, createdAt: 1, updatedAt: 1 })], /creates note "a" at revision 2/],
    ['increments by more than one', [
      upsert(0, { id: 'a', content: 'x', revision: 1, createdAt: 1, updatedAt: 1 }),
      upsert(1, { id: 'a', content: 'y', revision: 3, createdAt: 1, updatedAt: 2 }),
    ], /from revision 1 to 3/],
    ['moves createdAt', [
      upsert(0, { id: 'a', content: 'x', revision: 1, createdAt: 1, updatedAt: 1 }),
      upsert(1, { id: 'a', content: 'y', revision: 2, createdAt: 9, updatedAt: 2 }),
    ], /changes note "a" createdAt/],
    ['moves updatedAt backward', [
      upsert(0, { id: 'a', content: 'x', revision: 1, createdAt: 1, updatedAt: 5 }),
      upsert(1, { id: 'a', content: 'y', revision: 2, createdAt: 1, updatedAt: 2 }),
    ], /updatedAt backward/],
    ['carries a malformed id', [upsert(0, { id: 'Not-Kebab', content: 'x', revision: 1, createdAt: 1, updatedAt: 1 })], /lower-kebab-case/],
    ['carries empty content', [upsert(0, { id: 'a', content: '   ', revision: 1, createdAt: 1, updatedAt: 1 })], /content must be a non-empty string/],
    ['carries a non-integer revision', [upsert(0, { id: 'a', content: 'x', revision: 1.5, createdAt: 1, updatedAt: 1 })], /revision must be a positive safe integer/],
    ['carries a non-note upsert payload', [{ type: 'notes/change', seq: 0, time: 0, data: { operation: 'upsert', note: 42 } } as SessionEvent], /upsert note must be an object/],
    ['carries missing timestamps', [{ type: 'notes/change', seq: 0, time: 0, data: { operation: 'upsert', note: { id: 'a', content: 'x', revision: 1, createdAt: 'soon', updatedAt: 1 } } } as unknown as SessionEvent], /numeric createdAt and updatedAt/],
    ['carries a malformed delete id', [deleteEvent(0, 'BAD_ID')], /lower-kebab-case/],
  ])('rejects an invalid existing stream on late registration when it %s', async (_label, events, message) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    for (const event of events) session.append(event.type, event.data)
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(NotesInvariant).then(() => undefined)).rejects.toThrow(message)
  })

  it('reports a live violation at append time, not only on load', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => {
      session.append('notes/change', {
        operation: 'upsert',
        note: { id: 'a', content: 'x', revision: 7, createdAt: 1, updatedAt: 1 },
      })
    }).toThrow(/creates note "a" at revision 7/)
  })
})
