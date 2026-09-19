/** Package-owned durable notes-stream invariants. @module @deepseek-ai/dsh-tool-notes/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-notes'

const NOTE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const MAX_NOTE_ID_LENGTH = 64

/** Cordis companion plugin name. */
export const name = 'tool-notes-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Durable per-id facts the cross-event relations check against. */
interface NoteFacts {
  revision: number
  createdAt: number
  updatedAt: number
}

/**
 * Validate one whole-value note snapshot against its durable predecessor.
 *
 * Deliberately silent on content length and note count. Those are the tool's
 * per-deployment capacity policy (`Config.maxNotes` / `Config.maxNoteChars`),
 * not durable-shape rules: a log written under a looser deployment must still
 * replay after the policy tightens, so tying the invariant to the current
 * config would reject history that was valid when it was written.
 */
function validateUpsert(note: unknown, previous: NoteFacts | undefined, fail: InvariantFailure): void {
  if (typeof note !== 'object' || note === null) fail('notes/change upsert note must be an object')
  const { id, content, revision, createdAt, updatedAt } = note as Record<string, unknown>
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_NOTE_ID_LENGTH || !NOTE_ID_PATTERN.test(id)) {
    fail(`notes/change note id ${JSON.stringify(id)} must be 1-${MAX_NOTE_ID_LENGTH} chars of lower-kebab-case`)
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    fail('notes/change note content must be a non-empty string')
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    fail(`notes/change note "${id}" revision must be a positive safe integer`)
  }
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') {
    fail(`notes/change note "${id}" requires numeric createdAt and updatedAt`)
  }
  if (previous === undefined) {
    if (revision !== 1) fail(`notes/change creates note "${id}" at revision ${revision}; a create must be revision 1`)
  } else {
    if (revision !== previous.revision + 1) {
      fail(`notes/change moves note "${id}" from revision ${previous.revision} to ${revision}; every upsert must increment by exactly one`)
    }
    if (createdAt !== previous.createdAt) {
      fail(`notes/change changes note "${id}" createdAt; createdAt is stable after the create`)
    }
    if (updatedAt < previous.updatedAt) {
      fail(`notes/change moves note "${id}" updatedAt backward; updatedAt never decreases`)
    }
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Install an independent incremental fold over every attached session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, Map<string, NoteFacts>>()
  const staged = new WeakMap<SessionEvent, { session: Session; state: Map<string, NoteFacts> }>()

  /** Fold one event into a fresh candidate map, validating as it applies. */
  const applyChecked = (facts: Map<string, NoteFacts>, event: SessionEvent): Map<string, NoteFacts> => {
    const next = new Map(facts)
    if (event.type === 'notes/change') {
      const change = event.data
      if (change.operation === 'upsert') {
        validateUpsert(change.note, next.get(change.note.id), fail)
        next.set(change.note.id, { revision: change.note.revision, createdAt: change.note.createdAt, updatedAt: change.note.updatedAt })
      } else {
        if (typeof change.id !== 'string' || change.id.length === 0 || change.id.length > MAX_NOTE_ID_LENGTH || !NOTE_ID_PATTERN.test(change.id)) {
          fail(`notes/change delete id ${JSON.stringify(change.id)} must be 1-${MAX_NOTE_ID_LENGTH} chars of lower-kebab-case`)
        }
        next.delete(change.id)
      }
    }
    return next
  }

  const seed = (session: Session): Map<string, NoteFacts> => {
    let facts: Map<string, NoteFacts> = new Map()
    for (const event of session.events) facts = applyChecked(facts, event)
    states.set(session, facts)
    return facts
  }
  /* v8 ignore next -- session/event always follows list() or session/created seeding */
  const stateFor = (session: Session): Map<string, NoteFacts> => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    staged.set(event, { session, state: applyChecked(stateFor(session), event) })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching notes-fold validation')
    }
    staged.delete(event)
    states.set(session, candidate.state)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the notes invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
