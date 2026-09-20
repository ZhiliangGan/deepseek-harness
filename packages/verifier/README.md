---
description: "Package map for the verifier capability family: the ctx.verifier judge service and its model-facing verify_output Consumer, for users composing them and maintainers extending the seam."
kind: "package-group"
---

# verifier/ — independent verification family

English | [中文](README.zh.md)

## Summary

The `verifier/` group owns one capability: an independent judge reviews a candidate output against its task and returns a bounded verdict. `verifier` provides the `ctx.verifier` service — one auxiliary LLM call with strict verdict parsing and fail-closed settlement — and `tool-verifier` exposes it to the model as `verify_output`, so an agent can check its own answer before committing to it. The `dsh` base bundle ships both enabled, with the judge riding the product-default route.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Two packages cover the two roles of the capability seam.

| Package | What it provides |
|---|---|
| [`verifier/`](verifier/README.md) | `ctx.verifier`: one judge call per review, verdict/score/rationale, fail-closed on every unusable outcome |
| [`tool-verifier/`](tool-verifier/README.md) | The model-facing `verify_output` tool; verdicts return as ordinary tool results |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the LLM streaming seam the judge rides, then each package's README for mounting and contracts.

- [LLM streaming subsystem](../../docs/subsystems/llm-streaming.md) — the `ctx.llm` adapter seam and `GenerateOptions` every judge call uses.
- [guardian-approval package](../interaction/guardian-approval/README.md) — the judge-call precedent the service follows.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-verifier) — every accepted config field of the service.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The seam is one service plus one Consumer today; a second Consumer (goal-round certification) or a second provider (rule-based judge) is the split trigger recorded in the capability-seams note. This is explicitly non-authoritative — shipped behavior lives in the package READMEs and code.

</details>
