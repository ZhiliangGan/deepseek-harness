/**
 * Pure types of the notes domain: the ONE home of the `notes` projection-key
 * declaration plus the durable `notes/change` vocabulary it folds, free of
 * host-side imports. A note is one model-authored persistent working document
 * identified by a lower-kebab-case id; notes survive context compaction and
 * process restarts because their whole state lives in the owning session log.
 *
 * @module @deepseek-ai/dsh-tool-notes/types
 */

/**
 * Complete durable state of one note. Every upsert carries the whole post-change
 * note (whole-value rule, like `todo/write` and `goal/change`); replay is
 * last-wins per id.
 */
export interface NoteSnapshot {
  /** Lower-kebab-case identity chosen by the model (for example `decisions`). */
  readonly id: string
  /** Full current text of the note. */
  readonly content: string
  /** 1 on create, one past the previous revision on every later upsert. */
  readonly revision: number
  /** Epoch milliseconds of the creating upsert; stable across later upserts. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest upsert, clamped to never move backward. */
  readonly updatedAt: number
}

/** One durable change to the note set, discriminated by `operation`. */
export type NotesChange =
  | { readonly operation: 'upsert'; readonly note: NoteSnapshot }
  | { readonly operation: 'delete'; readonly id: string }

/** Browsable summary of one note for list output and UIs. */
export interface NoteSummary {
  /** Note identity. */
  readonly id: string
  /** First line of the content, trimmed, capped for display. */
  readonly preview: string
  /** Length of the full content in UTF-16 code units. */
  readonly chars: number
  /** Current revision of the note. */
  readonly revision: number
}

/** The value carried by one note. */
export interface NoteContent {
  /** Note identity. */
  readonly id: string
  /** Full current text of the note. */
  readonly content: string
  /** Current revision of the note. */
  readonly revision: number
}

/** Acknowledgement of one note-writing operation. */
export interface NoteWriteResult {
  /** Note identity. */
  readonly id: string
  /** Revision after the write. */
  readonly revision: number
  /** Length of the full content in UTF-16 code units. */
  readonly chars: number
  /** Whether the write created the note rather than replacing it. */
  readonly created: boolean
}

/** Acknowledgement of one note deletion. */
export interface NoteDeleteResult {
  /** Identity of the deleted note. */
  readonly id: string
  /** Always true; a deletion acknowledgement exists only for a deleted note. */
  readonly deleted: true
}

/**
 * The `notes` projection value: the current notes in first-creation order,
 * exactly as the latest `notes/change` per id carries them, or `null` before
 * the session's first notes change.
 */
export type NotesProjection = NoteSnapshot[] | null

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One whole-note upsert or one deletion. Log-only state; never derived
     * history. The latest change per id wins on replay; a delete of an absent
     * id changes nothing.
     */
    'notes/change': NotesChange
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's current notes in first-creation order (each id's latest
     * `notes/change` value), or `null` before any notes change.
     */
    notes: NotesProjection
  }
}
