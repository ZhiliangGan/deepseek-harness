/**
 * Verifier service (`ctx.verifier`): one auxiliary model call reviews a
 * candidate output against its task and optional criteria and returns one
 * bounded verdict — `pass`, `fail`, or `uncertain` with a confidence score and
 * a rationale. Every unusable outcome (malformed judge reply, tool-call reply,
 * timeout, abort, transport error) settles fail-closed as `uncertain` naming
 * the failure; the service never claims `pass` it cannot support. Reviews
 * reach the conversation as tool results through the Consumer package, which
 * the durable log already records; the service adds no session event of its
 * own.
 * @module @deepseek-ai/dsh-verifier
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { VerifierReview, VerifierReviewRequest, VerifierVerdict } from './types.ts'

// The domain vocabulary lives in src/types.ts (its one home); this re-export
// keeps the module edge in the emitted index.d.ts so aggregate programs
// consuming the service still receive the types.
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    verifier: VerifierService
  }
}

/** Verifier service configuration: the judge route and reply budgets. */
export interface Config {
  /** Provider route serving the judge calls. */
  judgeProvider: string
  /** Model serving the judge calls. */
  judgeModel: string
  /** Output-token cap for one judge reply. */
  maxOutputTokens?: number
  /** Wall-clock budget for one judge call; expiry settles the review `uncertain`. */
  timeoutMs?: number
}

/** Bounds applied to the judge exchange. */
const MAX_TASK_CHARS = 2000
const MAX_CRITERIA_CHARS = 1000
const MAX_SUBJECT_CHARS = 8000
const MAX_RATIONALE_CHARS = 400

/** Abort code carried by the review deadline. */
const TIMEOUT_CODE = 'VERIFIER_REVIEW_TIMEOUT'

const SYSTEM_PROMPT = [
  'You are an independent verifier judging one candidate answer produced by another agent.',
  'Check the candidate against the task and any stated criteria. Hunt concrete errors: wrong facts, unsupported claims, missed requirements, arithmetic that does not hold.',
  'Reply with ONLY one JSON object: {"verdict":"pass"|"fail"|"uncertain","score":<number 0.0-1.0>,"rationale":"<one paragraph>"} — no prose, no code fences.',
  'Score is your confidence that the candidate fully satisfies the task: 1.0 certain pass, 0.0 certain fail.',
  'Use "uncertain" when the candidate cannot be checked from the given material; do not guess either way.',
].join('\n')

/** Head-truncate one prompt input, marking how much was omitted. */
function boundInput(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}… (+${text.length - cap} more chars)`
}

/** Assemble the judge user prompt. */
function judgePrompt(request: VerifierReviewRequest): string {
  return [
    `Task:\n${boundInput(request.task, MAX_TASK_CHARS)}`,
    ...request.criteria === undefined ? [] : [`Acceptance criteria:\n${boundInput(request.criteria, MAX_CRITERIA_CHARS)}`],
    `Candidate to verify:\n${boundInput(request.subject, MAX_SUBJECT_CHARS)}`,
    'Judge the candidate per the system instructions.',
  ].join('\n\n')
}

/** Bound one judge rationale for the returned review. */
function boundRationale(rationale: string): string {
  return rationale.length <= MAX_RATIONALE_CHARS ? rationale : `${rationale.slice(0, MAX_RATIONALE_CHARS - 1)}…`
}

/** The shape the judge is instructed to reply with. */
interface ParsedVerdict {
  verdict: VerifierVerdict
  score: number
  rationale: string
}

/* jscpd:ignore-start -- sibling of guardian-approval's parseDecision:
 * one strict JSON-object reply parser per judge protocol; validated fields differ. */
/**
 * Extract the verdict object from one judge reply; whole-text parse, then one
 * stripped code fence, then the first balanced object in prose.
 * @param text - the judge's complete text reply.
 * @returns the parsed verdict record, or `undefined` when unusable.
 */
function parseVerdict(text: string): ParsedVerdict | undefined {
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
    const { verdict, score, rationale } = parsed as Record<string, unknown>
    if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'uncertain') continue
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) continue
    if (typeof rationale !== 'string' || rationale.trim().length === 0) continue
    return { verdict, score, rationale: rationale.trim() }
  }
  return undefined
}
/* jscpd:ignore-end */

/** The neutral score carried by a fail-closed review: no confidence was established. */
const UNCERTAIN_SCORE = 0.5

/** One fail-closed review naming why no verdict was reached. */
function failedReview(judge: { provider: string; model: string }, cause: string): VerifierReview {
  return { verdict: 'uncertain', score: UNCERTAIN_SCORE, rationale: boundRationale(`no verdict: ${cause}`), judge }
}

/**
 * The independent verifier.
 */
export class VerifierService extends Service {
  static inject = ['llm']

  static Config: z<Config> = z.object({
    judgeProvider: z.string().required(),
    judgeModel: z.string().required(),
    maxOutputTokens: z.number().step(1).min(1).default(512),
    timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  })

  /** Resolved and validated judge routing and budgets. */
  readonly resolved: {
    readonly judgeProvider: string
    readonly judgeModel: string
    readonly maxOutputTokens: number
    readonly timeoutMs: number
  }

  constructor(ctx: Context, config: Config) {
    super(ctx, 'verifier')
    // Static-Config schemastery validation guarantees the required judge
    // route on every loader path; typed direct construction carries it too.
    /* v8 ignore next 2 */
    const maxOutputTokens = config.maxOutputTokens ?? 512
    /* v8 ignore next */
    const timeoutMs = config.timeoutMs ?? 30_000
    this.resolved = { judgeProvider: config.judgeProvider, judgeModel: config.judgeModel, maxOutputTokens, timeoutMs }
  }

  /**
   * Verify one candidate output against its task.
   * @param request - the task, candidate, optional criteria, and the session the review belongs to.
   * @returns the settled review; judge failures settle `uncertain`, never `pass`.
   */
  async review(request: VerifierReviewRequest): Promise<VerifierReview> {
    const route = { provider: this.resolved.judgeProvider, model: this.resolved.judgeModel }
    try {
      using callDeadline = deadline(request.signal, this.resolved.timeoutMs, TIMEOUT_CODE)
      const options: GenerateOptions = deepFreeze({
        provider: route.provider,
        model: route.model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: judgePrompt(request) }],
          source: { kind: 'plugin', plugin: 'dsh-verifier' },
        })],
        system: SYSTEM_PROMPT,
        temperature: 0,
        maxTokens: this.resolved.maxOutputTokens,
        sessionId: request.session.id,
        purpose: 'guardian-review',
        signal: callDeadline.signal,
      })
      const assembler = new BlockAssembler()
      for await (const chunk of this.ctx.llm.stream(options)) {
        callDeadline.signal.throwIfAborted()
        assembler.push(chunk)
      }
      callDeadline.signal.throwIfAborted()
      const blocks = assembler.blocks()
      if (blocks.some(block => block.type === 'tool-call')) {
        return failedReview(route, 'judge reply contained a tool call')
      }
      const text = blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      const verdict = parseVerdict(text)
      if (verdict === undefined) {
        return failedReview(route, `judge reply was not a usable verdict object: ${boundRationale(text)}`)
      }
      return {
        verdict: verdict.verdict,
        score: verdict.score,
        rationale: boundRationale(verdict.rationale),
        judge: route,
      }
    } catch (error) {
      // ctx.llm.stream rejections are Error-typed at the adapter seam; the
      // String arm is the fail-closed floor, not an expected path.
      /* v8 ignore next -- covered by the Error path above */
      return failedReview(route, error instanceof Error ? error.message : String(error))
    }
  }
}

export default VerifierService
