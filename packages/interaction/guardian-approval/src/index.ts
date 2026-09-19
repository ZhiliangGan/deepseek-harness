/**
 * Guardian approval: an LLM-review answerer on the `approval/request`
 * waterfall. When an on-request approval fires, one auxiliary model call
 * reviews the planned action and may claim it (`allow` → `allowed-once`,
 * `deny` → `rejected`); every other outcome — malformed output, timeout,
 * abort, transport error — defers to the remaining answerer chain (typically
 * the human UI), so the guardian never widens what an unanswered approval
 * would do. Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-guardian-approval
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { GuardianDecision, GuardianReview } from './types.ts'

// The durable event declaration lives in src/types.ts (its one home); this
// re-export keeps the module edge in the emitted index.d.ts so aggregate
// programs consuming the declarations still receive the SessionEventMap merge.
export type * from './types.ts'

export const name = 'guardian-approval'
export const inject = ['llm']

const TIMEOUT_CODE = 'GUARDIAN_REVIEW_TIMEOUT'

/** Bounds applied to the review exchange. */
const MAX_INTENT_CHARS = 2000
const MAX_RATIONALE_CHARS = 400

/** Guardian approval configuration. */
export interface Config {
  /** Provider route serving the auxiliary review calls. */
  reviewerProvider: string
  /** Model serving the auxiliary review calls. */
  reviewerModel: string
  /** Output-token cap for one review reply. */
  maxOutputTokens: number
  /** Wall-clock budget for one review call; expiry defers to the chain. */
  timeoutMs: number
}

/** Schemastery configuration for the guardian approval answerer. */
export const Config: z<Config> = z.object({
  reviewerProvider: z.string().required(),
  reviewerModel: z.string().required(),
  maxOutputTokens: z.number().step(1).min(1).default(256),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
})

const SYSTEM_PROMPT = [
  'You are the guardian reviewing one planned action of a coding agent before it runs.',
  'Decide whether the action is safe enough to proceed without a human.',
  'Reply with ONLY one JSON object: {"decision":"allow"|"deny","rationale":"<one paragraph>"} — no prose, no code fences.',
  'Allow routine, reversible work (reading files, running tests, editing the workspace).',
  'Deny consequential or irreversible risk (credential exfiltration, deleting data outside the workspace, installing daemons, sending content to unknown endpoints).',
  'When genuinely uncertain, deny — a denial defers the action to a human reviewer who can override.',
].join('\n')

/**
 * Extract the decision object from one review reply; whole-text parse, then
 * one stripped code fence, then the first balanced object in prose.
 * @param text - the reviewer's complete text reply.
 * @returns the parsed decision record, or `undefined` when unusable.
 */
function parseDecision(text: string): { decision: GuardianDecision; rationale: string } | undefined {
  const trimmed = text.trim()
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed)
  const candidates = [fenced?.[1] ?? trimmed]
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch (_malformedJson) {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const { decision, rationale } = parsed as Record<string, unknown>
    if (decision !== 'allow' && decision !== 'deny') continue
    if (typeof rationale !== 'string' || rationale.trim().length === 0) continue
    return { decision, rationale: rationale.trim() }
  }
  return undefined
}

/** The agent's latest user-role intent text, bounded for the review prompt. */
function latestIntent(session: Session): string {
  // oxlint-disable-next-line typescript/no-deprecated -- Tail scan; projection migration deferred.
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    /* v8 ignore next -- descending indices over a live array never go out of range */
    if (event === undefined || event.type !== 'user/message') continue
    if (event.data.source.kind !== 'user') continue
    const text = event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text.trim().length === 0) continue
    return text.length <= MAX_INTENT_CHARS ? text : `${text.slice(0, MAX_INTENT_CHARS - 1)}…`
  }
  return '(no user request recorded yet)'
}

/** Assemble the review user prompt. */
function reviewPrompt(agent: Agent, toolName: string, reason: string | undefined): string {
  return [
    `User intent (latest user message):\n${latestIntent(agent.session)}`,
    '',
    `Planned action: tool "${toolName}".`,
    reason === undefined ? '' : `Why approval was requested: ${reason}`,
    '',
    'Decide allow or deny per the system instructions.',
  ].filter(part => part !== '').join('\n')
}

/** Bound one review rationale for the durable record. */
function boundRationale(rationale: string): string {
  return rationale.length <= MAX_RATIONALE_CHARS ? rationale : `${rationale.slice(0, MAX_RATIONALE_CHARS - 1)}…`
}

/**
 * Register the guardian answerer on the approval waterfall.
 * @param ctx - registrant context carrying the LLM runtime.
 * @param config - the deployment's reviewer routing and budgets.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('approval/request', (req, next) => {
    /* v8 ignore next -- the service settles an already-aborted request 'cancelled' before waterfall dispatch */
    if (req.signal?.aborted === true) return next()
    return review(ctx, config, req.agent, req.toolName, req.callId, req.reason, req.signal)
      .then((outcome): ApprovalOutcome | undefined => outcome)
      .catch(() => undefined)
      .then(outcome => outcome ?? next())
  })
}

/**
 * Run one review call and map it onto a claimable approval outcome.
 * @returns the claimed outcome, or `undefined` to defer to the chain.
 */
async function review(
  ctx: Context,
  config: Config,
  agent: Agent,
  toolName: string,
  callId: string | undefined,
  reason: string | undefined,
  upstream: AbortSignal | undefined,
): Promise<ApprovalOutcome | undefined> {
  using callDeadline = deadline(upstream, config.timeoutMs, TIMEOUT_CODE)
  const options: GenerateOptions = deepFreeze({
    provider: config.reviewerProvider,
    model: config.reviewerModel,
    messages: [createUserMessage({
      content: [{ type: 'text', text: reviewPrompt(agent, toolName, reason) }],
      source: { kind: 'plugin', plugin: 'dsh-guardian-approval' },
    })],
    system: SYSTEM_PROMPT,
    maxTokens: config.maxOutputTokens,
    sessionId: agent.session.id,
    purpose: 'guardian-review',
    signal: callDeadline.signal,
  })
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) return undefined
  const text = blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  const decision = parseDecision(text)
  if (decision === undefined) return undefined
  const record: GuardianReview = {
    decision: decision.decision,
    rationale: boundRationale(decision.rationale),
    toolName,
    ...callId === undefined ? {} : { callId },
  }
  agent.session.append('guardian/review', record)
  return decision.decision === 'allow' ? 'allowed-once' : 'rejected'
}
