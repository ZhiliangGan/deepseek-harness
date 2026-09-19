# Notes

English | [中文](notes.zh.md)

The durable notes vocabulary owned by [`@deepseek-ai/dsh-tool-notes`](../../packages/notes/tool-notes/README.md). One agent session owns its note set; every mutation appends a whole-value `notes/change` event, so notes survive context compaction and process restarts. Tool behavior and configuration are on the [package README](../../packages/notes/tool-notes/README.md).

Source: [`packages/notes/tool-notes/src/types.ts`](../../packages/notes/tool-notes/src/types.ts)

## `NoteSnapshot` — one persistent note

```ts type-equiv
/**
 * Complete durable state of one note. Every upsert carries the whole post-change
 * note (whole-value rule, like `todo/write` and `goal/change`); replay is
 * last-wins per id.
 */
interface NoteSnapshot {
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
```

## `NotesChange` — one durable change

```ts type-equiv
/** One durable change to the note set, discriminated by `operation`. */
type NotesChange =
  | { readonly operation: 'upsert'; readonly note: NoteSnapshot }
  | { readonly operation: 'delete'; readonly id: string }
```
