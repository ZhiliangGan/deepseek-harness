/**
 * Model-facing Consumer of the `ctx.verifier` capability seam. The tool runs
 * one independent judge over a candidate output and feeds the bounded verdict
 * back into the agent loop as an ordinary tool result — the durable record the
 * model and the log both see.
 *
 * @module @deepseek-ai/dsh-tool-verifier
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-verifier'

export const name = 'tool-verifier'
export const inject = ['tools', 'verifier']

const description = 'Run one independent judge to verify a candidate answer against its task before you commit to it. '
  + 'Pass the task and, optionally, acceptance criteria; the candidate defaults to the latest answer text in this conversation. '
  + 'Use before finalizing high-stakes answers, or when the user asks for verification or double-checking.'

/** The latest non-empty assistant text in one session, from the durable log. */
function latestAssistantText(session: Session): string | undefined {
  // oxlint-disable-next-line typescript/no-deprecated -- Tail scan at tool-call time; projection migration deferred.
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    /* v8 ignore next -- descending indices over a live array never go out of range */
    if (event === undefined || event.type !== 'assistant/message') continue
    const text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text.trim().length === 0) continue
    return text
  }
  return undefined
}

/** Resolve the candidate to verify: the explicit subject, else the agent's latest answer text. */
function resolveSubject(args: { subject?: string }, agent: Agent): string {
  if (args.subject !== undefined && args.subject.trim().length > 0) return args.subject
  const latest = latestAssistantText(agent.session)
  if (latest === undefined) {
    throw new Error('verify_output: no candidate to verify — pass `subject`, or run the tool after producing an answer')
  }
  return latest
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'verify_output',
    description,
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: 'The task the candidate answer claims to complete.',
      },
      subject: {
        type: 'string',
        description: 'The candidate output to verify. Defaults to the latest answer text in this conversation.',
      },
      criteria: {
        type: 'string',
        description: 'Optional acceptance criteria the candidate must satisfy, beyond the task itself.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verdict: { type: 'string', required: true, enum: ['pass', 'fail', 'uncertain'], description: 'The judge verdict over the candidate.' },
          score: { type: 'number', required: true, description: 'Confidence the candidate fully satisfies the task, 0 to 1.' },
          rationale: { type: 'string', required: true, description: 'Why the verdict holds, or why no verdict was reached.' },
          judge: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              provider: { type: 'string', required: true },
              model: { type: 'string', required: true },
            },
            description: 'The route that judged the candidate.',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new Error('verify_output: requires an agent conversation context — the judge call rides the session for routing')
      }
      const agent = exec.agent
      return await ctx.verifier.review({
        task: args.task,
        subject: resolveSubject(args, agent),
        ...args.criteria !== undefined ? { criteria: args.criteria } : {},
        session: agent.session,
        signal: exec.signal,
      })
    },
  }))
}
