/**
 * Pure types of the guardian-approval domain: the durable review vocabulary
 * and its session-event declaration, free of host-side imports. A guardian
 * review is one auxiliary model call that decides whether an on-request
 * approval may settle automatically (`allow`/`deny`) or must defer to the
 * remaining answerer chain (typically a human).
 *
 * @module @deepseek-ai/dsh-guardian-approval/types
 */

/** The closed set of decisions a guardian review may return. */
export type GuardianDecision = 'allow' | 'deny'

/** Durable record of one guardian review, appended before the claim it informs. */
export interface GuardianReview {
  /** The review's decision; `defer` is never recorded (it claims nothing). */
  readonly decision: GuardianDecision
  /** The reviewer's one-paragraph justification, bounded at append time. */
  readonly rationale: string
  /** The tool the approval question was about. */
  readonly toolName: string
  /** The exact tool call being decided, when the asker had one. */
  readonly callId?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One guardian review settled (the auxiliary model returned a usable
     * allow/deny). Log-only audit, appended BEFORE the guardian claims the
     * approval waterfall; `defer` outcomes (malformed, timeout, aborted,
     * error) record nothing and the remaining answerer chain decides.
     */
    'guardian/review': GuardianReview
  }
}
