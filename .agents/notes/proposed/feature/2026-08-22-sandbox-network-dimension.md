# Agent Note: Sandbox network dimension

Status: proposed

English | [中文](2026-08-22-sandbox-network-dimension.zh.md)

## Problem

The sandbox seam's file-effect vocabulary is complete for its scope, and its JSDoc says so explicitly: "Network and process visibility are outside this vocabulary" ([`packages/sandbox/sandbox/src/index.ts`](../../../../packages/sandbox/sandbox/src/index.ts)). A confined process under `read-only` or `workspace-write` can open any network connection — exfiltrating the workspace it may read. OpenAI's Codex harness closes this with a local HTTP/SOCKS5 network proxy with per-host policy, optional TLS MITM under a managed CA, and a credential broker that injects secrets per host instead of into child environments (openai/codex `network-proxy/`). That proxy layer is the correct long-term shape but is a deployment-level component, not a seam vocabulary.

## Proposal

Extend `SandboxExecutionPolicy` with one explicit network field and enforce it per platform, landing in three independent steps:

### Step 1 — vocabulary and fail-closed resolution

- `network: 'denied' | 'allowed'` on `SandboxExecutionPolicy` (defaulting at the consumer's explicit resolve step, like mode; `danger-full-access` implies `allowed`).
- The policy vocabulary change updates the seam README, the `SandboxMode` JSDoc (the "outside this vocabulary" sentence moves to history), and the sandbox subsystem doc in the same change.

### Step 2 — enforcement per platform

- **macOS (Seatbelt)**: `packages/sandbox/sandbox-local/src/profiles.ts` appends `(deny network*)` (and the inverse) to the generated sbpl. Cheap and `full` enforcement.
- **Linux (Landlock)**: `native/landlock-run` gains ABI-4 `LANDLOCK_ACCESS_NET_{BIND,CONNECT}_TCP` rules when the probed ABI ≥ 4. Two honest limitations drive `partial` enforcement: TCP only (no UDP, hence DNS must fail or resolve before confinement), and kernels below 6.7 report no network enforcement. `SandboxEnforcement` already carries exactly this `full`/`partial` split.
- **Windows**: no enforced path initially; the backend reports `partial` and the policy still resolves (denial degrades to policy-honest metadata, never a silent allow).

### Step 3 — consumer wiring

`dsh-bash-sandbox` resolves the network field from its own config (`network: denied` default for confined profiles); the fs/subprocess providers thread it through; the runtime-context snapshot the model sees gains the network line so the model knows the boundary before it hits it.

## Alternatives considered

- **Local proxy now (the Codex shape)**: per-host allowlists and credential brokering are strictly more capable than syscall denial, but they are a deployment component with a lifecycle (process supervision, CA management, secret storage) — not a policy field. Land it after the vocabulary so the proxy has a seam to enforce through.
- **`sandbox-exec`/seccomp filter lists**: rejected as the primary mechanism; Landlock is already the in-tree Linux mechanism and keeps the native addon single-purpose.

## Consequences (if adopted)

- `SandboxPolicy` grows a field: every backend and the escalation vocabulary (`EscalationRequest` gains the network dimension for approved widenings) update together; `SCHEMA_VERSION`-style on-disk formats are unaffected (policies are per-call, never persisted).
- Enforcement honesty is the contract: a host that cannot deny network reports `partial`, and callers requiring an absolute boundary treat it as such.
- The runtime-context approval contribution (dsh-user-approval) states the network boundary in the same snapshot style it uses for file effects.

## Acceptance criteria

- Every confined execution resolves an explicit `network` field; nothing silently defaults to `allowed` under confinement.
- A host that cannot enforce the resolved network policy reports `partial` enforcement, and a caller requiring an absolute boundary never treats it as `full`.
- On each platform reporting `full` network enforcement, a denied confined process cannot complete an outbound TCP connection in a REAL-composition test.
- The model-visible runtime-context snapshot states the active network boundary.

## Risks

- The native Landlock change touches the vendored-source-of-record addon (`native/landlock-run`); its kernel-ABI matrix (including CI runners below 6.7) must stay green or gate net rules off.
- Denying DNS along with UDP breaks name resolution for allowed-by-mode workflows; the resolve step may need a documented loopback-resolver story before Linux `denied` is usable in practice.
- A vocabulary field every backend ignores at first risks policy theatre: land backends and `partial` reporting in the same change as the vocabulary, not after.

## Verification (when implemented)

- Platform tests: seatbelt profile strings pin the `(deny network*)` form; the native addon's ABI probe gates net rules with kernel-version skew cases; every backend's `enforcement()` answer is asserted against the policy.
- A REAL-composition test confines a bash call that curls a loopback listener: `denied` fails closed on each platform that reports `full`, and the resolved policy is visible in the request context.
