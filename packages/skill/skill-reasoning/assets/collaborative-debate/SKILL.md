---
name: collaborative-debate
description: Settle contested or high-stakes claims with a two-debater collaborative debate driven by the workflow tool — independent cross-model positions, exact-quote evidence verified against the source, rounds that complement missing points instead of winning or forcing consensus, and a judge that reads every disagreement. Use for contested verification, safety review, or when the user explicitly asks for debate or dual review.
---

# Collaborative debate

Two debaters — preferably **different model families** — independently check one claim against grounding material, then debate collaboratively: each round they quote exact evidence, name what the other missed, self-audit their own weakest point, and concede correct opposing points. A judge reads the full transcript, weights only quote-verified evidence, and never forces consensus. Use this only when the user explicitly asks for debate, dual review, or contested verification; otherwise answer directly.

## Why this exact protocol

Debate fails in two well-documented ways, and this protocol is built against both:

- **Competitive debate degenerates into rhetoric.** Debaters assigned opposing positions learn to fabricate evidence and overclaim to persuade the judge; a judge reading persuasion learns nothing.
- **Consensus-seeking debate degenerates into echo.** Debaters converge early and filter out the disagreements — which are exactly the informative part.
- **Same-model debate mostly re-derives self-consistency.** The real gain comes from cross-family diversity: different model families rarely err on the same sample.

So: debaters collaborate instead of competing, every evidence claim must be an exact quote from the source (verified mechanically in the script — unverified quotes reach the judge marked as carrying no evidence value), and disagreements survive to the judge.

## When to use it

- a contested factual or analytical claim where two independent readings genuinely differ
- high-stakes verification: safety review, consequential advice, a number that must be right
- reviewing another model's output for errors

Skip it when a runnable check exists (an executable test beats any debate), when the task is easy or saturated (simple majority voting is cheaper), or when one model already answers reliably.

## Worked script

`args`: `{ "question": "<what to settle>", "subject": "<the claim or answer under review>", "context": "<grounding material every quote must come from>", "providerA": "<optional>", "modelA": "<optional>", "providerB": "<optional>", "modelB": "<optional>", "rounds": 2 }` — pass `modelA`/`modelB` from different families whenever a second route exists; that is where the gain lives.

```js
const rounds = args.rounds ?? 2
const names = ['A', 'B']
const position = {
  type: 'object', additionalProperties: false,
  required: ['position', 'evidence', 'argument'],
  properties: {
    position: { type: 'string', enum: ['support', 'refute', 'uncertain'] },
    evidence: { type: 'array', items: { type: 'string' } },
    argument: { type: 'string' },
  },
}
const opts = (provider, model, label) => {
  const o = { label }
  if (provider !== undefined) o.provider = provider
  if (model !== undefined) o.model = model
  return o
}
const route = (i) => opts(i === 0 ? args.providerA : args.providerB, i === 0 ? args.modelA : args.modelB, 'debater ' + names[i])
const base = 'You are a debater checking a claim.\n'
  + 'Question to settle:\n' + args.question + '\n\nClaim under review:\n' + args.subject + '\n\n'
  + 'Grounding material (every piece of evidence MUST be an exact quote copied from it):\n' + args.context + '\n\n'
  + 'Collaborative rules — you are NOT trying to win and NOT seeking quick agreement:\n'
  + '1. List evidence as exact quotes from the grounding material.\n'
  + '2. State the strongest point the other debater missed.\n'
  + '3. Name the weakest point of your own position and check it yourself.\n'
  + '4. Explicitly concede any correct point made against you.\n'
  + 'Disagreement is information: keep it visible.'
const verified = (p) => p === null ? null : {
  position: p.position,
  argument: p.argument,
  verifiedEvidence: p.evidence.filter(quote => args.context.includes(quote)),
  unverifiedEvidence: p.evidence.filter(quote => !args.context.includes(quote)),
}
phase('Independent positions')
let views = (await parallel([0, 1].map(i => () => agent(base, { ...route(i), schema: position })))).map(verified)
for (let round = 1; round <= rounds; round++) {
  phase('Debate round ' + round)
  const next = await parallel([0, 1].map(i => () => agent(
    base + '\n\nYour previous position (quotes checked against the source):\n' + JSON.stringify(views[i], null, 2)
    + '\n\nThe other debater\'s position (quotes checked; UNVERIFIED quotes carry no evidence value):\n' + JSON.stringify(views[1 - i], null, 2)
    + '\nUpdate your position: complement what is missing, concede what is correct, keep genuine disagreements open.',
    { ...route(i), schema: position })))
  views = next.map(verified)
}
phase('Judge')
const judged = await agent(
  'You are the judge. Two debaters from different backgrounds independently checked one claim over ' + (rounds + 1) + ' rounds.\n'
  + 'Rules: weight only verifiedEvidence; unverifiedEvidence is rhetoric; disagreements are information, not noise; do not force consensus.\n'
  + 'Question:\n' + args.question + '\n\nClaim:\n' + args.subject + '\n\nFinal positions:\n' + JSON.stringify(views, null, 2),
  { schema: {
    type: 'object', additionalProperties: false, required: ['verdict', 'confidence', 'rationale'],
    properties: {
      verdict: { type: 'string', enum: ['support', 'refute', 'uncertain'] },
      confidence: { type: 'number' },
      rationale: { type: 'string' },
    },
  }, label: 'judge' })
if (judged === null) return { status: 'judge-failed', positions: views }
return {
  status: 'judged',
  ...judged,
  unresolvedDisagreement: views[0] !== null && views[1] !== null && views[0].position !== views[1].position,
  rounds: rounds + 1,
}
```

## How it behaves

- **Quote verification is mechanical.** The script checks every claimed quote against `context` by exact match; debaters and the judge both see which evidence survived, so fabricated quotes cannot win.
- **Disagreement survives to the judge.** The result reports `unresolvedDisagreement`, and the judge is told not to force consensus — an honest `uncertain` beats a forced agreement.
- **Cross-model is the point.** With `modelA`/`modelB` from different families the debaters bring uncorrelated errors; with one model the run mostly re-derives self-consistency at several times the cost.
- Failed debaters resolve to `null` and the debate continues with the surviving side's record.

## Cost discipline

A run costs `(rounds + 1) × 2` debater calls plus one judge call, and every call carries the grounding material. Start at `rounds: 1` for ordinary contested claims; raise only when the disagreement is unresolved and the stakes justify it. Never use debate where a program can decide: an executable check is cheaper and stronger.
