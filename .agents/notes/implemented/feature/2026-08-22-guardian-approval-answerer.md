# Agent Note: Guardian approval answerer

Status: implemented

English | [中文](2026-08-22-guardian-approval-answerer.zh.md)

## Problem

On-request approvals interrupt a human for every unsaved action: routine work (running tests, reading files) and genuinely consequential work wait equally. OpenAI's Codex harness ships a "guardian" — a dedicated review session that decides whether an on-request approval may settle automatically, failing closed on any doubt. dsh already had the right seam (`ctx.approval`'s `approval/request` waterfall with composed answerers and a fail-closed default) but every shipped answerer was a human.

## Decision

One opt-in package, [`packages/interaction/guardian-approval/`](../../../../packages/interaction/guardian-approval/README.md), registering one answerer on the waterfall. No service, no registry — the seam already owns requests, audit, and the fail-closed default.

- **Review call**: one auxiliary LLM call (`purpose: 'guardian-review'`, a new member of the `GenerateOptions` purpose union in `dsh-llm`) on a required deployment-configured reviewer route. The prompt carries the agent's latest user intent (bounded 2000 chars, skipping plugin-source and empty rows), the tool name, and the asker's reason. The policy line is deliberately conservative: allow routine reversible work, deny consequential or irreversible risk, deny when uncertain.
- **Claims**: a parsed `allow` claims `allowed-once`, a parsed `deny` claims `rejected` — each preceded by one log-only `guardian/review` event (`{ decision, rationale ≤400, toolName, callId? }`) so every automatic settlement carries its WHY beside the service-owned `approval/asked`/`approval/decided` audit pair.
- **Defers everything else**: malformed output, unknown decision vocabulary, missing rationale, tool-call-shaped replies, timeout (`timeoutMs`, honoring the approval's own abort signal), transport error — the answerer calls `next()` and the remaining chain (the human UI) decides. Defer-fail is toward the human, never toward a silent grant: the guardian can narrow human workload but never widens what an unanswered approval does. Deferrals record nothing.

## Alternatives considered

### Why a waterfall answerer, not a policy change

The approval policy vocabulary (`ask`/`never`) is a session-level switch; the guardian is a per-decision reviewer that must coexist with the human answerer and any future answerer. The waterfall's documented claim-or-`next()` contract is exactly this shape, and load order composes the chain deterministically (guardian first, human behind it).

### What a denial means

A guardian `rejected` ends that request, but the durable `guardian/review` rationale tells the human why; a human can re-run the action and approve it in the UI. This matches Codex's explicit allow/deny posture while keeping the human override path intact.

## Consequences

- `guardian/review` joins `SessionEventMap` (log-only, merge-extensible; no `SESSION_FORMAT_VERSION` bump); the package invariant validates its shape and bounds.
- `'guardian-review'` extends the auxiliary-purpose union; adapters may map it to transport metadata like the existing purposes.
- No shipped bundle composes the guardian; deployments that want it compose it before their human answerer.

## Verification

- `packages/interaction/guardian-approval/tests/` — the real waterfall through `ApprovalService.request()` with a scripted reviewer adapter (claims, defers, timeout, abort, bounds, purpose/route assertions), Loader composition over cordis.yml, and stream invariants; 100% per-file coverage under the CI gate.
- Approval flows have no keyless snapshot scenario yet (recorded as a Known Limitation); the real-waterfall spec and the Loader test carry coverage until one exists.
