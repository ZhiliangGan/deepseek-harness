# 笔记

[English](notes.md) | 中文

[`@deepseek-ai/dsh-tool-notes`](../../packages/notes/tool-notes/README.zh.md) 拥有的持久笔记词汇。一个 agent 会话拥有自己的笔记集合；每次变更追加一条整值 `notes/change` 事件，笔记因此跨上下文压缩与进程重启存活。工具行为与配置见[包 README](../../packages/notes/tool-notes/README.zh.md)。

来源：[`packages/notes/tool-notes/src/types.ts`](../../packages/notes/tool-notes/src/types.ts)

## `NoteSnapshot` — 一条持久笔记

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

## `NotesChange` — 一次持久变更

```ts type-equiv
/** One durable change to the note set, discriminated by `operation`. */
type NotesChange =
  | { readonly operation: 'upsert'; readonly note: NoteSnapshot }
  | { readonly operation: 'delete'; readonly id: string }
```
