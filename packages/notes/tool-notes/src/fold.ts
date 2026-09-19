/**
 * Pure replay fold of the notes domain: the durable note set as a map keyed by
 * id plus the whole-event and projection folds built on it. Insertion order is
 * first-creation order (a `Map.set` of an existing key keeps its position), so
 * the fold is deterministic on replay.
 *
 * @module @deepseek-ai/dsh-tool-notes/fold
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { NoteSnapshot, NotesChange, NotesProjection } from './types.ts'

/** Durable note state: every current note keyed by id. */
export interface NotesFoldState {
  readonly notes: ReadonlyMap<string, NoteSnapshot>
}

/**
 * The empty fold state, before any notes change.
 * @returns the empty fold state (a fresh `Map` every call).
 */
export function emptyNotesFoldState(): NotesFoldState {
  return { notes: new Map() }
}

/**
 * Apply one notes change to a fold state, returning a fresh state.
 * @param state - the fold state covering all prior changes.
 * @param change - the next durable change.
 * @returns the post-change state (a new `Map` every call).
 */
export function applyNotesChange(state: NotesFoldState, change: NotesChange): NotesFoldState {
  const notes = new Map(state.notes)
  if (change.operation === 'upsert') {
    notes.set(change.note.id, change.note)
  } else {
    notes.delete(change.id)
  }
  return { notes }
}

/**
 * Apply one session event to a fold state.
 * @param state - the fold state covering all prior events.
 * @param event - the next committed session event.
 * @returns the post-event state (the same reference when the event is not a notes change).
 */
export function applyNotesEvent(state: NotesFoldState, event: SessionEvent): NotesFoldState {
  if (event.type !== 'notes/change') return state
  return applyNotesChange(state, event.data)
}

/**
 * Projection fold of the `notes` unit: the note list or `null` before the first
 * change. Non-notes events and a delete of an absent id return the same
 * reference (the registry's Object.is gate); every other change returns a new
 * array in first-creation order.
 * @param state - the projection covering all prior events (`null` before the first change).
 * @param event - the next committed session event.
 * @returns the next projection.
 */
export function applyNotesProjection(state: NotesProjection, event: SessionEvent): NotesProjection {
  if (event.type !== 'notes/change') return state
  const change = event.data
  if (change.operation === 'delete') {
    if (state === null) return state
    const next = state.filter(note => note.id !== change.id)
    return next.length === state.length ? state : next
  }
  const current = state ?? []
  const previousIndex = current.findIndex(note => note.id === change.note.id)
  if (previousIndex === -1) return [...current, change.note]
  return current.map(note => note.id === change.note.id ? change.note : note)
}
