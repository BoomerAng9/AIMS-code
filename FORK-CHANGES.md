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

4. `packages/agent-core/src/session/provider-manager.ts`
   - `ModelProvider` interface gains one OPTIONAL method,
     `decorateGenerateOptions?(options)`. Non-governing providers omit it.

5. `packages/agent-core/src/agent/index.ts`
   - `Agent.generate`'s dispatch funnel calls
     `this.modelProvider?.decorateGenerateOptions?.(requestOptions)` immediately
     before `rawGenerate`. This is the once-per-model-call boundary where the
     per-call decision ID is injected. No-op for non-governing providers.

6. `packages/agent-core/src/index.ts` + `packages/node-sdk/src/index.ts`
   - Re-export the launch gate (`requireGovernedLaunch`, `GovernanceStartupError`).

7. `apps/kimi-code/src/main.ts`
   - Calls `requireGovernedLaunch()` before starting a session (fail-closed gate).

Nothing else in upstream source is modified. `LICENSE` is untouched.

## The four controls

- **INV-3 / Stage Zero** — enforced at TWO seams, deliberately separated:
  - `GovernedModelProvider.resolveProviderConfig()` (config-time) verifies the
    resolved provider's `base_url` is an origin under `AIMS_GATEWAY_BASE_URL`
    (a provider with no base_url, or a different host/port/scheme, is refused,
    not rewritten). This runs on every resolution, including metadata lookups,
    and is a pure check — no ID minted.
  - `GovernedModelProvider.decorateGenerateOptions()` (dispatch-time) runs once
    per real model call at `Agent.generate`, mints the decision ID, and injects
    it as a **request-scoped** header (`auth.headers`).

- **Per-call decision ID** — `DecisionIdMinter` mints `sz-<session>-<seq>-<uuid>`.
  Minting happens at the dispatch boundary (`decorateGenerateOptions`), NOT in
  `resolveProviderConfig`. This matters: an earlier version minted at
  resolve-time and stamped `defaultHeaders`; a live fake-gateway e2e proved that
  the OpenAI client bakes `defaultHeaders` at construction and the turn reuses
  one client across steps, so all HTTP calls carried a SINGLE id — no better than
  PR #72 at the wire — while the ledger over-emitted a receipt per metadata
  resolution. Using a request-scoped header at the dispatch boundary forces a
  per-request client rebuild (kosong `resolveAuthBackedClient` skips its cache
  when `auth` is present), so **each model call carries a distinct id ON THE
  WIRE**. Verified: a governed binary driven by a fake gateway emitted 12 model
  calls → 12 distinct wire decision IDs → 12 dispatch receipts (1:1). It is
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
