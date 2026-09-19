# structured-output/ — structured-output capability family

English | [中文](README.zh.md)

The structured-output contract: one JSON Schema the conversation's final reply must satisfy, enforced on the agent turn lifecycle.

| Package | Role | ctx key |
|---|---|---|
| [`structured-output/`](structured-output/README.md) | Arms contracts, validates final replies, steers retries | `ctx.structuredOutput` |

The child README owns the arming, enforcement, events, and configuration contract.
