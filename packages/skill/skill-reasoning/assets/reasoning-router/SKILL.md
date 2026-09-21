---
name: reasoning-router
description: Route a task to the cheapest test-time-scaling strategy that can carry it. Triage the task first (executable? multi-constraint? contested? deep single-problem?), then climb the escalation ladder only as far as needed — plain answer, self-check, program-first, best-of-n, debate. Use at the start of any non-trivial task, or when the user asks for a general reasoning discipline.
---

# Reasoning router

Test-time scaling is not one technique; gains come from matching the mechanism to the task's error profile. Route deliberately, then escalate only on evidence of failure.

## Step 1 — Triage (one glance, no compute)

Ask: **what kind of error would a wrong answer contain?**

- Precision slips (arithmetic, dates, counting, aggregation) → **program-first**. Execute, never hand-compute.
- Structure misses (multi-hop question, many constraints that must ALL hold) → **decompose-first** into ordered checkable subproblems.
- A runnable check exists (tests, build, executable spec) → **best-of-n with the executable filter**; the check is the judge.
- Contested judgment, no ground truth, stakes high → **collaborative-debate** (cross-model when available) with quoted evidence.
- One hard problem worth deep search → **tree-search** iterative refinement with a fixed judge.
- Simple or already-saturated → **answer directly**. Spending compute here is pure waste.

Mixed profiles stack: decompose first, then route each subproblem.

## Step 2 — Escalation ladder (spend only what the failure proves necessary)

1. **Answer directly.** Fast path; note your confidence.
2. **Self-check** (cheap): restate the answer's premises; if any feels unverified, drop to 3.
3. **Execute or verify**: program-first for anything numeric; verify_output for claims against source material; a runnable test where one exists.
4. **Diversify**: best-of-n (3-5) with vote or executable filter — only when steps 1-3 disagree with themselves or the stakes demand redundancy.
5. **Contest**: collaborative debate between independent positions, judge reads every disagreement.

Stop at the first rung whose result you can defend: an executed program's printout, a passed test, a quote-verified claim. Never climb for show.

## Rules

- Confidence below your own bar at ANY rung → escalate one rung, do not skip to maximum.
- Never majority-vote arithmetic (voting cannot fix systematic slips — execute instead).
- Never debate a question a program can decide.
- Budgets bound everything: name your max calls before step 4, and stop when a rung adds nothing.
