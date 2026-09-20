---
description: "Bundled reasoning-discipline skills — program-first computation, decompose-first planning, best-of-n and tree-search sampling, and collaborative debate — for users enabling or tuning them."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-reasoning

English | [中文](README.zh.md)

## Summary

This bundled provider ships five reasoning-discipline skills for agents. `program-first` routes numeric and data-transformation work through executed programs; `decompose-first` sequences multi-constraint tasks into ordered subproblems; `best-of-n-sampling` and `tree-search` teach complete `workflow` tool patterns — parallel candidates with executable-check, vote, or judge selection, and score-driven iterative refinement — and `collaborative-debate` settles contested claims through cross-model debate with mechanically quote-verified evidence. The provider is enabled in the `dsh` base bundle, so every base-backed profile ships the disciplines.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable the plugin to add the four skills to the session skill catalog; the model loads them on demand like any other skill.

### When to choose it

Choose this provider when sessions do high-stakes numerical, analytical, or sampling work and the deployment wants the disciplines available without authoring skills locally. Skip it when sessions are short conversational tasks — the skills cost catalog lines until used, and the sampling skills multiply model calls when invoked.

### Enable the plugin

```yaml
- name: '@deepseek-ai/dsh-skill-reasoning'
```

The shipped base composition carries the row as `disabled: true`; enable it there through an overlay row (`$DSH_HOME/cordis.patch.yml` or `--patch <file>`). `assetRoot` exists for packaged applications that relocate assets.

### What the skills provide

- **`program-first`** — never report unexecuted arithmetic: write a program, run it, report printed values. One skill, one habit; the highest reliability gain per token of any discipline here.
- **`decompose-first`** — ordered, checkable subproblems for multi-hop and multi-constraint tasks, with premise verification between steps and a final check against every original constraint.
- **`best-of-n-sampling`** — worked `workflow` scripts for parallel candidate generation with three selection tiers (executable check, majority vote, independent judge), plus cost guidance.
- **`tree-search`** — a worked iterative-refinement script: best-so-far candidate, parallel improvements, same-judge scoring, strict-promotion and no-gain early stop.
- **`collaborative-debate`** — a worked two-debater script with cross-model routing, exact-quote evidence verified against the source in-script, and a judge that keeps disagreements alive; built against the two documented failure modes of debate (competitive rhetoric and consensus echo).

### Observable success and failures

With the plugin mounted, all five skills appear in the session catalog and are loadable by name (and by `/skill-name`); disabling the row keeps them out of every catalog. A broken asset tree — a missing `SKILL.md` or one without frontmatter or description — fails plugin load loudly instead of registering a partial catalog.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the bundled provider is wired; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The provider is an immutable skill source: it parses each packaged `assets/<name>/SKILL.md` frontmatter at load (fail-loud on a missing file, missing frontmatter, or missing description), registers the four candidates at the bundled skill rank (600) under provider name `dsh-reasoning`, and reads each body from its packaged file on every load. Sampling skills carry complete `workflow` scripts rather than tool code: the `workflow` tool already accepts arbitrary scripts, and a script the model can copy verbatim needs no new package surface or loop change.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: frontmatter parsing, the immutable four-candidate provider |
| — | No runtime invariant companion is published; the package owns one immutable provider registration, while the skill registry owns registration uniqueness and lifecycle checks. |
| [`assets/`](assets/) | Packaged skill bodies (`<name>/SKILL.md`), one directory per skill |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the registry this provider registers on to how sampling reaches the model.

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the registry and provider contract this provider implements.
- [tool-skill package](../tool-skill/README.md) — how the skills reach the session catalog and the model.
- [Workflow subsystem reference](../../../docs/subsystems/workflow.md) — the engine and script contract the two sampling skills program.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-skill`, which renders the provider's catalog entry and the selected skill body to the model.

#### KV Cache effect

The five catalog entries ride the durable skills reminder message; any loaded body follows as retained tool-result content. Both append after the reusable request prefix and do not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the bundled provider does not do. They are current package constraints, not a task backlog.

- **Sampling skills teach patterns, not policy** — the `workflow` tool's own prompt section restricts workflows to explicit user requests; the skills inherit that policy and cannot loosen it.
- **Judge diversity is prompt-borne** — the sampling scripts manufacture candidate diversity through framing and instructions; per-child sampling parameters (temperature, seed) are not exposed to workflow scripts.
- **Five fixed skills** — deployments needing other disciplines author their own skills instead of extending this provider.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
