---
name: tree-search
description: Improve one hard answer iteratively with the workflow tool — keep the best candidate so far, generate several improvements in parallel each round, score every candidate with an independent judge, and stop when a round produces no improvement. Use when the user explicitly asks for iterative refinement, search, or maximum quality on one problem.
---

# Iterative tree search

Refine one answer over several rounds instead of accepting the first draft: keep the best candidate so far, and each round generate several independent improvements in parallel, score every one with the same independent judge, and promote any candidate that beats the current best. Stop when a round improves nothing or the round budget ends. Use this only when the user explicitly asks for a workflow, search, or iterative refinement; otherwise answer directly.

## Worked script

`args`: `{ "task": "<the problem>" }`

```js
const rounds = args.rounds ?? 3
const width = args.width ?? 3
const scored = {
  type: 'object', additionalProperties: false,
  required: ['score', 'rationale'],
  properties: { score: { type: 'number' }, rationale: { type: 'string' } },
}
const judgePrompt = (task, candidate) =>
  'You are an independent judge. Score how well the candidate solves the task, 0 (wrong) to 10 (excellent). '
  + 'Be strict: reward correctness and completeness, penalize unsupported claims. Reply per the schema.\n\n'
  + 'Task:\n' + task + '\n\nCandidate:\n' + candidate
async function judgedScore(candidate) {
  const verdict = await agent(judgePrompt(args.task, candidate), { schema: scored, label: 'judge', phase: 'Judge' })
  return verdict === null ? -1 : verdict.score
}
phase('Seed')
let best = await agent(args.task, { label: 'seed' })
if (best === null) return { status: 'seed-failed' }
let bestScore = await judgedScore(best)
log('seed scored ' + bestScore)
for (let round = 1; round <= rounds; round++) {
  phase('Round ' + round)
  const improved = await parallel(Array.from({ length: width }, (_, i) => () =>
    agent('Improve the candidate answer below. Current best scores ' + bestScore + '/10. '
      + 'Fix what is wrong, add what is missing, and take a genuinely different angle from the other candidates.\n\n'
      + 'Task:\n' + args.task + '\n\nCurrent best:\n' + best,
      { label: 'improve ' + (i + 1) })))
  const valid = improved.filter(candidate => candidate !== null)
  const scores = await parallel(valid.map(candidate => () => judgedScore(candidate)))
  let promoted = false
  for (let i = 0; i < valid.length; i++) {
    if (scores[i] > bestScore) {
      best = valid[i]
      bestScore = scores[i]
      promoted = true
    }
  }
  log('round ' + round + ' best ' + bestScore + (promoted ? ' (promoted)' : ' (no gain)'))
  if (!promoted) return { status: 'converged', round, score: bestScore, answer: best }
}
return { status: 'rounds-exhausted', score: bestScore, answer: best }
```

## How it behaves

- The **judge is the same prompt every round**, so scores are comparable across rounds; a judge that varies per round makes "improvement" meaningless.
- **A candidate replaces the best only on a strictly higher score**; equal scores keep the earlier, cheaper answer.
- **Early stop on a no-gain round** is the point, not a shortcut: when three independent improvements all fail to beat the best, more rounds are usually wasted spend.
- Failed agents resolve to `null` and drop out; a round where every improvement fails simply fails to promote.

## Cost discipline

A run costs roughly `1 + rounds × width` solver agents plus `1 + rounds × width` judge calls. Start at `rounds: 2, width: 3`; raise only when the user asks for more search on a single high-stakes problem. For questions with a checkable answer, prefer best-of-n sampling with an executable check — search earns its cost when quality is scored, not merely checked.
