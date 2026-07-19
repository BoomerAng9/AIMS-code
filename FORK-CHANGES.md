# FORK-CHANGES — FOAI governance delta over MoonshotAI/kimi-code

This repository (`BoomerAng9/AIMS-code`) is a downstream MIT fork of
[`MoonshotAI/kimi-code`](https://github.com/MoonshotAI/kimi-code). See `NOTICE`
for attribution and `LICENSE` (retained unmodified) for terms.

This file is the exact record of what FOAI changed and why. It is the map an
upstream-sync reviewer uses to re-apply the delta after `git merge upstream/main`.

## Why this fork exists

A prior integration (AIMS-Charlotte PR #72) governed kimi entirely through
external `config.toml` — provider binding, permission rules, and a static
decision-ID header injected via `KIMI_CODE_HOME`. That works until the config is
removed, hand-edited, or never provisioned; the binary would then run ungoverned
while still looking correct. And the vendor renders `custom_headers` once per
config file, so the Stage Zero decision ID was **session-scoped**: every internal
model call in a session shared one ID, and Stage Zero could not attribute an
individual call. PR #72 recorded that honestly as PARTIAL.

Owning the source removes both limits. Governance is now structural (the
ungoverned code path does not exist in the build) and the decision ID is minted
**per model call**. That per-call ID is the single highest-value reason to fork.

## The delta

All new FOAI code lives under one directory so the surface is greppable and the
upstream edits are minimal:

    packages/agent-core/src/foai/
      governance.ts        Fail-closed config resolution + gateway-origin check (INV-3).
      decision-id.ts       Per-call Stage Zero decision-ID minter + header set.
      receipts.ts          Receipt model + file/memory/null sinks (audit ledger).
      governed-provider.ts GovernedModelProvider — INV-3 enforced at the ModelProvider seam.
      governed-write.ts    GovernedWriteTool — refuses blind whole-file overwrite (CSP).
      runtime.ts           Process-wide wiring: governProvider(), writeToolFor().
      index.ts             Barrel.

    packages/agent-core/test/foai/   Full unit + CSP acceptance suite (28 tests).

### Upstream files touched (kept to one-liners for mergeability)

1. `packages/agent-core/src/rpc/core-impl.ts`
   - `resolveProviderManager()` now wraps the `ProviderManager` in
     `governProvider(base, sessionId)`. Return type widened to `ModelProvider`.
   - Added imports: `type ModelProvider`, `governProvider`.

2. `packages/agent-core/src/agent/tool/index.ts`
   - The `new b.WriteTool(...)` registration is replaced by
     `writeToolFor(kaos, workspace, this.agent.modelProvider)`.
   - Added import: `writeToolFor`.

3. `packages/agent-core/src/session/index.ts`
   - `SessionOptions.providerManager` type widened from `ProviderManager` to
     `ModelProvider | ProviderManager` so the governed decorator can be injected.

Nothing else in upstream source is modified. `LICENSE` is untouched.

## The four controls

- **INV-3 / Stage Zero** — `GovernedModelProvider.resolveProviderConfig()` verifies
  the resolved provider's `base_url` is an origin under `AIMS_GATEWAY_BASE_URL`
  (a provider with no base_url, or a different host/port/scheme, is refused, not
  rewritten), then mints a fresh decision ID and stamps it onto the outbound
  `defaultHeaders` **last**, so provider `custom_headers` cannot shadow it.

- **Per-call decision ID** — `DecisionIdMinter` mints `sz-<session>-<seq>-<uuid>`
  on every resolve. `resolveProviderConfig` is invoked per model request in
  agent-core, so granularity is **per model call**, not per session. It is
  deliberately not per-HTTP-request: a transport retry reuses the call's config
  and therefore its ID (the same Stage Zero decision). See `decision-id.ts`.

- **CSP** — under governance the real `WriteTool` is never constructed;
  `GovernedWriteTool` is registered in its place. It holds no `Kaos` handle,
  declares no filesystem access, and refuses at resolution. `Edit` (exact-string
  replacement) remains the sanctioned path and already leaves a file
  byte-identical when its anchor does not match. Acceptance test:
  `test/foai/csp-write.test.ts`.

- **Receipts** — every enforcement decision emits a JSON-Lines receipt to
  `FOAI_RECEIPT_SINK` for Charlotte's ledger. Emission never throws.

## Fail-closed

Governance is ON by default. `resolveGovernance()` throws `GovernanceStartupError`
unless `AIMS_GATEWAY_BASE_URL` is set. Disabling requires the exact acknowledgement
phrase in `FOAI_GOVERNANCE_DISABLED` (`i-accept-running-ungoverned-and-uncredentialed`);
any other value is treated as an error, not as governed-anyway. There is no
config-file switch — a disable must be a conscious act at the process boundary.

## Configuration (runtime)

| Variable | Meaning |
| --- | --- |
| `AIMS_GATEWAY_BASE_URL` | Required. Gateway OpenAI-compatible base URL every model call must originate from (e.g. `http://127.0.0.1:8317/v1`). |
| `FOAI_MISSION_ID` / `FOAI_TASK_ID` | Optional correlation stamped on receipts + headers. |
| `FOAI_RECEIPT_SINK` | Optional path; receipts appended as JSON Lines. |
| `FOAI_GOVERNANCE_DISABLED` | Set to the exact acknowledgement phrase to run ungoverned. |

The gateway binding still supplies the provider endpoint + key via `config.toml`
(`[providers.aims_gateway]`) exactly as PR #72 did — connectivity stays in config;
only enforcement (Write denial, per-call ID, fail-closed) moved to source.

## Syncing upstream

    git fetch upstream
    git merge upstream/main        # or rebase the FOAI branch

Conflicts, if any, will be in the three upstream files listed above. Re-apply the
one-line edits; the `foai/` directory itself does not conflict. `upstream`'s push
URL is disabled locally to prevent accidental pushes to Moonshot's repo.
