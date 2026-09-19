/**
 * The `notes` projection unit: mounting tool-notes beside the registry serves
 * the current note set through the cold `restore` read; the pure fold keeps
 * first-creation order, replaces in place, and returns the same reference for
 * unrelated events and no-op deletes. A composition without tool-notes has no
 * `notes` key; unmounting tool-notes removes it (HMR safety).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as ToolNotes from '../src/index.ts'
import { applyNotesProjection } from '../src/index.ts'
import { applyNotesEvent } from '../src/fold.ts'
import type { NoteSnapshot } from '../src/types.ts'

function event(seq: number, data: unknown, type = 'notes/change'): SessionEvent {
  return { type, seq, time: 0, data } as SessionEvent
}

function note(id: string, content: string, revision = 1): NoteSnapshot {
  return { id, content, revision, createdAt: revision, updatedAt: revision }
}

describe('applyNotesProjection fold', () => {
  it('applyNotesEvent passes notes changes to the map fold and others through', () => {
    let state = applyNotesEvent({ notes: new Map() }, event(0, { turn: 1 }, 'turn/start'))
    expect(state.notes.size).toBe(0)
    state = applyNotesEvent(state, event(1, { operation: 'upsert', note: note('a', 'one') }))
    expect(state.notes.get('a')?.content).toBe('one')
    state = applyNotesEvent(state, event(2, { operation: 'delete', id: 'a' }))
    expect(state.notes.size).toBe(0)
  })

  it('stays null before the first change and ignores unrelated events', () => {
    const state = applyNotesProjection(null, event(0, { turn: 1 }, 'turn/start'))
    expect(state).toBeNull()
  })

  it('inserts on create, replaces in place, and keeps first-creation order', () => {
    let state = applyNotesProjection(null, event(0, { operation: 'upsert', note: note('a', 'one') }))
    state = applyNotesProjection(state, event(1, { operation: 'upsert', note: note('b', 'two') }))
    state = applyNotesProjection(state, event(2, { operation: 'upsert', note: note('a', 'one v2', 2) }))
    expect(state?.map(n => `${n.id}:${n.content}:${n.revision}`)).toEqual(['a:one v2:2', 'b:two:1'])
  })

  it('removes on delete and returns the same reference for a no-op delete', () => {
    let state = applyNotesProjection(null, event(0, { operation: 'upsert', note: note('a', 'one') }))
    state = applyNotesProjection(state, event(1, { operation: 'upsert', note: note('b', 'two') }))
    const removed = applyNotesProjection(state, event(2, { operation: 'delete', id: 'a' }))
    expect(removed?.map(n => n.id)).toEqual(['b'])
    expect(applyNotesProjection(removed, event(3, { operation: 'delete', id: 'a' }))).toBe(removed)
    // A delete before any change stays null rather than materializing [].
    expect(applyNotesProjection(null, event(0, { operation: 'delete', id: 'a' }))).toBeNull()
  })

  it('returns the same reference for every non-notes event once materialized', () => {
    let state = applyNotesProjection(null, event(0, { operation: 'upsert', note: note('a', 'one') }))
    const same = applyNotesProjection(state, event(1, { todos: [] }, 'todo/write'))
    expect(same).toBe(state)
    state = same
    expect(applyNotesProjection(state, event(2, { turn: 1 }, 'turn/end'))).toBe(state)
  })
})

describe('notes projection unit', () => {
  async function harness(withNotesTool: boolean) {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    let fiber: { dispose(): Promise<void> } | undefined
    if (withNotesTool) fiber = await ctx.plugin(ToolNotes, { maxNotes: 8, maxNoteChars: 200 })
    await ctx.plugin(SessionProjectionRegistry)
    return { ctx, fiber }
  }

  const CALL_SIGNAL = new AbortController().signal

  /** Write notes through the real tools onto one real session. */
  async function write(ctx: Context, sessionId: string, calls: readonly { name: string; args: unknown }[]) {
    const session = Session.create(SessionId(sessionId))
    const agent = { id: session.id, session } as never
    for (const [index, callSpec] of calls.entries()) {
      const result = await ctx.tools.execute({
        signal: CALL_SIGNAL,
        callId: `notes-proj-${index}` as never,
        name: callSpec.name,
        arguments: callSpec.args,
        agent,
      })
      if (result.isError) throw new Error(`tool ${callSpec.name} failed`)
    }
    return session
  }

  it('serves null before any write and the folded note set after writes', async () => {
    const { ctx } = await harness(true)
    const empty = Session.create(SessionId('empty'))
    const cold = ctx.sessionProjections.restore({}, empty.events, 0)
    expect(cold.snapshot.values.notes).toBeNull()

    const session = await write(ctx, 'writer', [
      { name: 'write_note', args: { id: 'decisions', content: 'ship it' } },
      { name: 'append_note', args: { id: 'findings', text: 'found the bug' } },
      { name: 'delete_note', args: { id: 'decisions' } },
    ])
    const folded = ctx.sessionProjections.restore({}, session.events, 0)
    const notes = folded.snapshot.values.notes
    expect(notes?.map(n => [n.id, n.content, n.revision])).toEqual([['findings', 'found the bug', 1]])
    expect(folded.checkpoint.notes?.ver).toBe(1)
  })

  it('exposes no notes key without tool-notes and removes the unit on disposal', async () => {
    const bare = await harness(false)
    const session = Session.create(SessionId('bare'))
    expect(bare.ctx.sessionProjections.restore({}, session.events, 0).snapshot.values.notes).toBeUndefined()
    await bare.ctx.fiber.dispose()

    const { ctx, fiber } = await harness(true)
    expect(ctx.sessionProjections.restore({}, Session.create(SessionId('x')).events, 0).snapshot.values).toHaveProperty('notes')
    await fiber!.dispose()
    expect(ctx.sessionProjections.restore({}, Session.create(SessionId('x')).events, 0).snapshot.values.notes).toBeUndefined()
  })
})
