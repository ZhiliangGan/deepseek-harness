---
name: program-first
description: Solve numeric, symbolic, and data-transformation tasks by writing a short program and running it, instead of computing in your head. Use for any non-trivial arithmetic, aggregation, counting, date or unit math, percentages, and financial figures — whenever exact numbers will be reported.
---

# Program-first computation

For any task whose answer depends on numbers, dates, or data transformation beyond single-step arithmetic, produce the answer by writing a program, running it, and reading the printed output. Never report a computed number you have not seen a machine print.

## When to use

Apply this discipline whenever the task involves:

- arithmetic with more than one operation, or any multiplication/division of non-trivial numbers
- counting, summing, averaging, or ranking over a set of items
- percentages, ratios, growth rates, or unit and currency conversion
- date arithmetic (durations, business days, calendar boundaries)
- parsing structured data and extracting statistics from it

Single trivial arithmetic ("2 + 2") needs no program. Everything else does.

## How to work

1. Write one short script that computes the answer end to end. Prefer batching all needed computations into a single run over several fragmentary runs.
2. Run it and read the exact output. Report numbers exactly as printed, with units; do not round or reformat them silently.
3. When inputs change, rerun the script rather than adjusting the previous answer by hand.
4. When precision matters, have the script print intermediate values so each step is checkable.

Sanity-check orders of magnitude: if the program prints a number wildly unlike your rough estimate, find the bug before reporting. Mental arithmetic remains useful for estimates and sanity checks — never as the source of reported values.

## Why

Language-model arithmetic is unreliable at exactly the precision tasks ask for, and a wrong digit in a reported figure is a silent failure. An executed program makes every reported number reproducible, and the script itself documents the computation for review.
