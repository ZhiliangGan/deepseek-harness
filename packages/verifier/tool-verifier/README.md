---
description: "Model-facing verify_output tool over the ctx.verifier seam, for users mounting it and maintainers changing what the model can ask a judge to check."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-verifier

English | [中文](README.zh.md)

## Summary

This package is the model-facing Consumer of the `ctx.verifier` capability seam. It registers `verify_output`: the model passes a task (and optionally acceptance criteria and a candidate), one independent judge reviews the candidate, and the bounded verdict returns as an ordinary tool result. Without an explicit candidate, the tool verifies the agent's latest answer text, so self-checking a drafted answer costs one call. The `dsh` base bundle ships it enabled beside `dsh-verifier`.

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

Mount this tool when answers should be independently checked from inside the conversation — before finalizing a high-stakes reply, when the user asks for verification, or as the selection step of a sampling pattern.

### Configuration

The tool has none of its own; the base bundle mounts it beside the service. Disable the pair through an overlay when a deployment wants no judge in the loop:

```yaml
- id: tool-verifier
  disabled: true
```

### What the model sees

One new tool, `verify_output`: `task` (required), `subject` (defaults to the latest answer text in the conversation), and `criteria` (optional). The result is one JSON object — `verdict` (`pass`/`fail`/`uncertain`), `score` (0–1), `rationale`, and the judge route — returned as a tool result the model reads like any other.

### Observable success and failures

A judge reply returns its verdict verbatim. A call with no candidate to verify (no `subject`, no prior answer text) fails as a tool error, and judge failures settle `uncertain` with the failure named — see the [verifier package](../verifier/README.md) for the fail-closed contract.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the tool resolves its candidate; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The tool is a thin Consumer: argument validation through `defineTool`, candidate resolution, and one `ctx.verifier.review()` call. Defaulting the subject to the agent's latest answer text is a tail scan of the durable log for the newest non-empty `assistant/message` — the same source of truth the structured-output stop boundary reads, so the verified candidate is exactly what the model last said. Direct `ctx.tools.execute()` callers without an agent fail loud: the judge call rides the session for routing and there is nothing to default to.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `verify_output` tool: schema, candidate resolution, service delegation |
| — | No runtime invariant companion is published; the tool owns no durable state — verdicts surface as `tool/result` events whose invariants the tool pipeline owns. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the seam this tool consumes to the cookbook for authoring siblings.

- [verifier package](../verifier/README.md) — the service this tool consumes and its fail-closed contract.
- [Tool cookbook](../../../docs/cookbook/adding-a-tool.md) — the model-facing tool contract this Consumer follows.

-----

<a id="model-experience"></a>
## Model Experience

### verify_output tool

#### What the model sees

While mounted, the tool description below joins the session tool catalog; the model then sees the tool schema like any other and its verdicts as ordinary tool results.

##### Tool description

```markdown
verify_output: Run one independent judge to verify a candidate answer against its task before you commit
to it. Pass the task and, optionally, acceptance criteria; the candidate defaults to the latest answer
text in this conversation. Use before finalizing high-stakes answers, or when the user asks for
verification or double-checking.
```

#### Token effect

The tool schema joins prompt assembly while mounted. Each call costs one auxiliary judge request; the verdict returns as one short tool result.

#### KV Cache effect

The tool schema enters the request's tool section; the verdict appends after the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the tool does not do. They are current package constraints, not a task backlog.

- **Verifies text, not artifacts** — the candidate is the passed subject or the latest answer text; verifying a file or a diff means the model quotes it into `subject`, bounded by the service's 8000-char subject cap.
- **No UI presentation beyond the raw result** — presenters and Web cards derive from tool results today; a dedicated verdict card awaits product need.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
