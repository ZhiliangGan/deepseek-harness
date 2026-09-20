---
name: decompose-first
description: Break a complex task into an ordered list of concrete subproblems before solving it, then solve them in sequence, feeding each answer into the next, and check the final answer against every original constraint. Use for multi-hop questions and multi-constraint problems whose parts depend on each other.
---

# Decompose-first problem solving

Before solving a complex task, decompose it: list the concrete subproblems, order them so each solved subproblem feeds the next, and only then start solving. Work the list in order and finish by checking the result against every original requirement.

## When to use

- the question needs several facts or steps where later steps depend on earlier answers
- the task carries multiple constraints that must all hold at once
- a plan, migration, or refactor touches several parts whose order matters
- the task looks overwhelming as one jump but each piece is answerable

Do not use it for single-step questions; solve those directly.

## How to work

1. **Decompose.** Write down the subproblems as concrete questions with checkable answers — not vague areas to "look into".
2. **Order.** Arrange them so that the easiest, most independent question comes first and each later question can use earlier answers. Where two subproblems are independent, they can be answered in any order or in parallel.
3. **Solve in sequence.** Answer each subproblem explicitly before starting the next; carry earlier answers forward instead of re-deriving them.
4. **Verify premises.** Before building on a step, check the step's premise still holds; when a step invalidates later assumptions, revise the remaining plan instead of forcing the old sequence.
5. **Re-assemble.** Combine the subanswers into one final answer, then re-read the original request and confirm the answer satisfies every stated constraint — not just the last subproblem solved.

State intermediate answers explicitly in your work; an implicit intermediate result cannot be checked and will silently propagate errors.
