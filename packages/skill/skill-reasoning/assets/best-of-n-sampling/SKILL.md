---
name: best-of-n-sampling
description: Generate several independent candidate answers in parallel with the workflow tool, then select the best by executable check, majority vote, or an independent judge. Use when the user explicitly asks for multiple attempts, sampling, self-consistency, or high-confidence answers on one question.
---

# Best-of-n sampling

Generate N independent candidate answers to one question in parallel, then select one answer with an explicit selection rule. Independent samples catch errors a single pass makes, and the selection rule — not a fresh opinion — decides. Use this only when the user explicitly asks for a workflow, multiple attempts, sampling, or high confidence; otherwise answer directly.

## Choosing the selection rule

1. **Executable check (strongest).** When correctness can be checked by running code — a unit test, a build, a script's output — each candidate agent both produces the work and runs the check, reporting a structured pass/fail. Keep only candidates that pass.
2. **Majority vote.** When answers are short and comparable (a number, a choice, a name), the modal answer wins; exact string comparison is usually enough after trimming.
3. **Independent judge.** When answers are long-form free text, one judge agent — given only the question and the candidates — picks the single most consistent, well-supported candidate.

Use the strongest rule available; a check beats a judge whenever it applies.

## Worked script: vote with judge tiebreak

`args`: `{ "question": "<the question>" }`

```js
const n = args.candidates ?? 5
phase('Sample candidates')
const samples = await parallel(Array.from({ length: n }, (_, i) => () =>
  agent(args.question + '\n\nAnswer independently and completely. Candidate ' + (i + 1) + ' of ' + n + '.',
    { label: 'candidate ' + (i + 1) })))
const answers = samples.filter(answer => answer !== null)
if (answers.length === 0) return { status: 'no-candidates' }
phase('Select')
const tally = new Map()
for (const answer of answers) tally.set(answer, (tally.get(answer) ?? 0) + 1)
const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1])
const [topAnswer, topVotes] = ranked[0]
const tied = ranked.filter(([, votes]) => votes === topVotes).map(([answer]) => answer)
if (tied.length === 1) return { status: 'majority', answer: topAnswer, votes: topVotes, of: answers.length }
const judged = await agent(
  'You are an independent judge. Below is one question and several candidate answers that tied in a vote. '
  + 'Pick the single most accurate and well-supported answer. Reply with the index (1-based) of the best candidate.\n\n'
  + 'Question:\n' + args.question + '\n\nCandidates:\n' + tied.map((a, i) => (i + 1) + '. ' + a).join('\n\n'),
  { schema: { type: 'object', additionalProperties: false, required: ['pick'], properties: { pick: { type: 'number' } } }, label: 'judge' })
if (judged === null || judged.pick < 1 || judged.pick > tied.length) {
  return { status: 'tie-unresolved', tied }
}
return { status: 'judged-tie', answer: tied[judged.pick - 1], votes: topVotes, of: answers.length }
```

## Worked script: executable check (tests as the filter)

`args`: `{ "task": "<implementation task>" }` — each candidate writes the code, runs its own checks, and reports.

```js
const n = args.candidates ?? 4
const report = {
  type: 'object', additionalProperties: false,
  required: ['passed', 'summary'],
  properties: { passed: { type: 'boolean' }, summary: { type: 'string' } },
}
phase('Sample with checks')
const samples = await parallel(Array.from({ length: n }, (_, i) => () =>
  agent('Complete this task, then verify your own work by running it (build, tests, or an execution check): '
    + args.task + '\n\nCandidate ' + (i + 1) + ' of ' + n + '. Work independently.',
    { schema: report, label: 'candidate ' + (i + 1) })))
const passed = samples.map((r, i) => ({ report: r, index: i + 1 })).filter(s => s.report !== null && s.report.passed)
if (passed.length === 0) return { status: 'none-passed', reports: samples }
phase('Select')
const judged = await agent(
  'You are an independent judge. Several candidates each completed a task and passed their own checks. '
  + 'Read their summaries and pick the best completion by index (1-based).\n\nTask:\n' + args.task
  + '\n\nCandidate summaries:\n' + passed.map(s => s.index + '. ' + s.report.summary).join('\n'),
  { schema: { type: 'object', additionalProperties: false, required: ['pick'], properties: { pick: { type: 'number' } } }, label: 'judge' })
if (judged === null) return { status: 'pass-undecided', passed: passed.map(s => s.index) }
return { status: 'checked', pick: passed[judged.pick - 1]?.index ?? null, passed: passed.map(s => s.index) }
```

Candidate agents run with their own tools and workspace; each one sees only its own prompt, so candidates stay independent. Failed candidates resolve to `null` and drop out without failing the run.

## Cost discipline

N candidates cost roughly N times one answer plus one judge call. Choose N by stakes: 3–5 for ordinary high-confidence questions, more only when the user asks for it. Prefer the executable check: it removes most wrong candidates without a judge call, and a check that passes is stronger evidence than any judge opinion.
