/**
 * Pure types of the verifier domain: the review request, the review result,
 * and the judge routing record, free of host-side imports. One review asks an
 * independent auxiliary model whether a candidate output satisfies its task;
 * the answer is one bounded verdict that always settles, including on judge
 * failure.
 *
 * @module @deepseek-ai/dsh-verifier/types
 */

import type { Session } from '@deepseek-ai/dsh-session'

/** One judge verdict over a candidate output. */
export type VerifierVerdict = 'pass' | 'fail' | 'uncertain'

/** One request to verify a candidate output against its task. */
export interface VerifierReviewRequest {
  /** The task the candidate output claims to complete. */
  readonly task: string
  /** The candidate output to verify. */
  readonly subject: string
  /** Acceptance criteria the candidate must satisfy, beyond the task itself. */
  readonly criteria?: string
  /** The session the review belongs to; its id rides the judge call for routing and audit. */
  readonly session: Session
  /** Abort signal bounding the judge call, combined with the service's own timeout. */
  readonly signal?: AbortSignal
}

/** One completed review, whether judged or fail-closed. */
export interface VerifierReview {
  /** The judge's verdict, or `uncertain` when no usable verdict was reached. */
  readonly verdict: VerifierVerdict
  /** Judge confidence that the subject fully satisfies the task, 0 to 1. */
  readonly score: number
  /** Why the verdict holds; on a fail-closed outcome, why no verdict was reached. */
  readonly rationale: string
  /** The route that judged (or failed to judge) the subject. */
  readonly judge: { readonly provider: string; readonly model: string }
}
