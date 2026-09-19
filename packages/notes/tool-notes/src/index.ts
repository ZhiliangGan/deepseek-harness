/**
 * Model-facing persistent working notes. Each tool call appends one `notes/change`
 * event to the calling agent's session; notes survive context compaction and
 * process restarts because the durable log — not the live context — owns them.
 * A non-agent caller has no owning session and is rejected. Named exports
 * preserve loader injection metadata.
 * @module @deepseek-ai/dsh-tool-notes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: resolves ctx.sessionProjections for the optional unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
import { applyNotesEvent, applyNotesProjection, emptyNotesFoldState } from './fold.ts'
import type { NotesFoldState } from './fold.ts'
import type {
  NoteContent,
  NoteDeleteResult,
  NoteSnapshot,
  NoteSummary,
  NoteWriteResult,
  NotesProjection,
} from './types.ts'

// The `notes` projection-key declaration lives in src/types.ts (its one home);
// this re-export projects the type face onto the package root AND keeps the
// module edge in the emitted index.d.ts, so aggregate programs consuming the
// declarations still receive the SessionProjectionMap merge.
export type * from './types.ts'
export { applyNotesProjection } from './fold.ts'
export type { NotesFoldState } from './fold.ts'

export const name = 'tool-notes'
export const inject = ['tools']

/** Model-facing notes tool configuration. */
export interface Config {
  /** Maximum number of notes one session may hold; a create beyond it fails loud. */
  maxNotes: number
  /** Maximum UTF-16 code units of one note's complete content; a longer write fails loud. */
  maxNoteChars: number
}

/** Schemastery configuration for the notes tool consumer. */
export const Config: z<Config> = z.object({
  maxNotes: z.number().step(1).min(1).default(64),
  maxNoteChars: z.number().step(1).min(1).default(8000),
})

/** Lower-kebab-case note identity, 1–64 characters. */
const NOTE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const MAX_NOTE_ID_LENGTH = 64
const PREVIEW_MAX_CHARS = 80

/**
 * Validate one model-authored note id at the operation boundary.
 * @param id - the raw id from tool arguments.
 * @returns the validated id.
 */
function resolveNoteId(id: string): string {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_NOTE_ID_LENGTH || !NOTE_ID_PATTERN.test(id)) {
    throw new Error(
      `invalid note id ${JSON.stringify(id)}: use 1-${MAX_NOTE_ID_LENGTH} chars of lower-kebab-case (letters and digits separated by single hyphens), for example "decisions"`,
    )
  }
  return id
}

/**
 * Validate one note text at the operation boundary. Stored verbatim; only
 * all-whitespace text is rejected.
 * @param text - the raw text from tool arguments.
 * @param maxNoteChars - the configured complete-content cap.
 * @param what - the field name for the error message.
 * @returns the validated text.
 */
function resolveText(text: string, maxNoteChars: number, what: string): string {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error(`${what} must be a non-empty string`)
  }
  if (text.length > maxNoteChars) {
    throw new Error(`${what} is ${text.length} chars; the complete note must stay within ${maxNoteChars} chars`)
  }
  return text
}

/**
 * Derive the bounded first-line preview of one note for list output.
 * @param content - the note's full content.
 * @returns the trimmed first line, capped at {@link PREVIEW_MAX_CHARS} display chars.
 */
function previewOf(content: string): string {
  const firstLine = (content.split('\n', 1)[0] ?? '').trim()
  return firstLine.length <= PREVIEW_MAX_CHARS ? firstLine : `${firstLine.slice(0, PREVIEW_MAX_CHARS - 1)}…`
}

/** Process-local incremental fold cache for one live session. */
interface NotesCache {
  state: NotesFoldState
  observedSeq: number
}

/** Wire payload schema of the `notes` projection (note list or pre-first-change null). */
const notesProjectionSchema = zod.union([
  zod.array(zod.object({
    id: zod.string().min(1),
    content: zod.string(),
    revision: zod.number().int().positive(),
    createdAt: zod.number(),
    updatedAt: zod.number(),
  })),
  zod.null(),
])

const SURVIVAL_CLAUSE =
  'Notes persist in the session log — they survive context compaction and restarts, unlike the conversation itself.'

const noteSummarySchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    id: { type: 'string' as const, required: true as const },
    preview: { type: 'string' as const, required: true as const },
    chars: { type: 'integer' as const, required: true as const },
    revision: { type: 'integer' as const, required: true as const },
  },
}

const noteWriteResultSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    id: { type: 'string' as const, required: true as const },
    revision: { type: 'integer' as const, required: true as const },
    chars: { type: 'integer' as const, required: true as const },
    created: { type: 'boolean' as const, required: true as const },
  },
}

/**
 * Register the five notes tools on `ctx.tools` and, when the session-projection
 * seam is composed, the `notes` unit.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's note capacity policy.
 */
export function apply(ctx: Context, config: Config): void {
  const maxNotes = config.maxNotes
  const maxNoteChars = config.maxNoteChars

  const caches = new WeakMap<Session, NotesCache>()

  /** Fold the session log up to its current tail and return the durable note state. */
  function stateFor(session: Session): NotesFoldState {
    let cache = caches.get(session)
    if (cache === undefined) {
      cache = { state: emptyNotesFoldState(), observedSeq: 0 }
      caches.set(session, cache)
    }
    // oxlint-disable-next-line typescript/no-deprecated -- Incremental fold over the durable log; projection-driven state read deferred.
    for (const event of session.snapshotEvents().slice(cache.observedSeq)) {
      cache.state = applyNotesEvent(cache.state, event)
      cache.observedSeq += 1
    }
    return cache.state
  }

  /**
   * Commit one upsert: build the whole-value snapshot (clamped timestamps,
   * incremented revision) and append the durable change.
   */
  function commitUpsert(session: Session, id: string, content: string): NoteWriteResult {
    const notes = stateFor(session).notes
    const previous = notes.get(id)
    if (previous === undefined && notes.size >= maxNotes) {
      throw new Error(`note limit reached (${maxNotes}); delete one first or reuse an existing id: ${[...notes.keys()].join(', ')}`)
    }
    const now = Date.now()
    const note: NoteSnapshot = {
      id,
      content,
      revision: previous === undefined ? 1 : previous.revision + 1,
      createdAt: previous === undefined ? now : previous.createdAt,
      updatedAt: Math.max(now, previous === undefined ? now : previous.updatedAt),
    }
    session.append('notes/change', { operation: 'upsert', note })
    return { id, revision: note.revision, chars: content.length, created: previous === undefined }
  }

  /** Resolve the durable note one operation addresses, failing loud on unknown ids. */
  function expectNote(session: Session, id: string): NoteSnapshot {
    const note = stateFor(session).notes.get(id)
    if (note === undefined) {
      throw new Error(`unknown note id ${JSON.stringify(id)}; call list_notes for the current ids`)
    }
    return note
  }

  // The unit child activates only when a projection registry is composed
  // (headless assemblies without the seam stay unaffected).
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'notes', NotesProjection>({
      key: 'notes',
      stateSchema: notesProjectionSchema,
      init: () => null,
      apply: applyNotesProjection,
      wire: {
        viewSchema: notesProjectionSchema,
        view: state => state,
      },
      stateVersion: 1,
    })
  })

  ctx.tools.register(defineTool({
    name: 'list_notes',
    description: `List this session's persistent working notes (id, preview, size, revision). ${SURVIVAL_CLAUSE}`,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          notes: { type: 'array', required: true, items: noteSummarySchema },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.notes.length === 0
          ? 'No notes yet.'
          : `${value.notes.length} note(s): ${value.notes.map(note => note.id).join(', ')}`,
      }],
    },
    execute(_args, exec) {
      if (!exec.agent) {
        throw new Error('list_notes requires an owning agent session')
      }
      const summaries: NoteSummary[] = [...stateFor(exec.agent.session).notes.values()]
        .map(note => ({ id: note.id, preview: previewOf(note.content), chars: note.content.length, revision: note.revision }))
      return Promise.resolve({ notes: summaries })
    },
    presentCall: () => ({ card: 'generic', title: 'List notes', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'read_note',
    description: 'Read one persistent note by id. After context compaction, re-read notes instead of trusting your memory of them.',
    parameters: {
      id: { type: 'string', required: true, description: 'The note id, as shown by list_notes.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          content: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Note "${value.id}" (revision ${value.revision}):\n${value.content}`,
      }],
    },
    execute(args, exec) {
      const id = resolveNoteId(args.id)
      if (!exec.agent) {
        throw new Error('read_note requires an owning agent session')
      }
      const note = expectNote(exec.agent.session, id)
      const content: NoteContent = { id: note.id, content: note.content, revision: note.revision }
      return Promise.resolve(content)
    },
    presentCall: args => ({ card: 'generic', title: 'Read note', kind: 'other', rawInput: (args as { id?: string }).id }),
  }))

  ctx.tools.register(defineTool({
    name: 'write_note',
    description: `Create or replace one persistent working note identified by a short id (for example "decisions", "verify-steps"). Record exact facts you must not lose. ${SURVIVAL_CLAUSE} Store decisions with reasons, constraints, paths, commands, and verification steps. The content replaces the whole note.`,
    parameters: {
      id: { type: 'string', required: true, description: 'Stable lower-kebab-case note id you will re-read later.' },
      content: { type: 'string', required: true, description: 'The complete new content of the note.' },
    },
    output: {
      schema: noteWriteResultSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `${value.created ? 'Wrote' : 'Replaced'} note "${value.id}" (revision ${value.revision}, ${value.chars} chars).`,
      }],
    },
    execute(args, exec) {
      const id = resolveNoteId(args.id)
      const content = resolveText(args.content, maxNoteChars, 'note content')
      if (!exec.agent) {
        throw new Error('write_note requires an owning agent session')
      }
      return Promise.resolve(commitUpsert(exec.agent.session, id, content))
    },
    presentCall: args => ({ card: 'generic', title: 'Write note', kind: 'other', rawInput: (args as { id?: string }).id }),
  }))

  ctx.tools.register(defineTool({
    name: 'append_note',
    description: `Append one line to a persistent note, creating it when absent — a running log (findings, attempts, decisions) without rewriting the note. ${SURVIVAL_CLAUSE}`,
    parameters: {
      id: { type: 'string', required: true, description: 'Stable lower-kebab-case note id.' },
      text: { type: 'string', required: true, description: 'The line to append (stored verbatim, no reformatting).' },
    },
    output: {
      schema: noteWriteResultSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `${value.created ? 'Created note' : 'Appended to note'} "${value.id}" (revision ${value.revision}, ${value.chars} chars).`,
      }],
    },
    execute(args, exec) {
      const id = resolveNoteId(args.id)
      const text = resolveText(args.text, maxNoteChars, 'appended text')
      if (!exec.agent) {
        throw new Error('append_note requires an owning agent session')
      }
      const previous = stateFor(exec.agent.session).notes.get(id)
      const combined = previous === undefined ? text : `${previous.content}\n${text}`
      // The complete resulting note — not just the appended text — must fit the cap.
      if (combined.length > maxNoteChars) {
        throw new Error(
          `appending ${text.length} chars would grow note "${id}" to ${combined.length} chars; the complete note must stay within ${maxNoteChars} chars`,
        )
      }
      return Promise.resolve(commitUpsert(exec.agent.session, id, combined))
    },
    presentCall: args => ({ card: 'generic', title: 'Append to note', kind: 'other', rawInput: (args as { id?: string }).id }),
  }))

  ctx.tools.register(defineTool({
    name: 'delete_note',
    description: 'Delete one persistent note by id once it is no longer useful, keeping the note set browsable.',
    parameters: {
      id: { type: 'string', required: true, description: 'The note id, as shown by list_notes.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          deleted: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Deleted note "${value.id}".`,
      }],
    },
    execute(args, exec) {
      const id = resolveNoteId(args.id)
      if (!exec.agent) {
        throw new Error('delete_note requires an owning agent session')
      }
      expectNote(exec.agent.session, id)
      const result: NoteDeleteResult = { id, deleted: true }
      exec.agent.session.append('notes/change', { operation: 'delete', id })
      return Promise.resolve(result)
    },
    presentCall: args => ({ card: 'generic', title: 'Delete note', kind: 'other', rawInput: (args as { id?: string }).id }),
  }))
}
