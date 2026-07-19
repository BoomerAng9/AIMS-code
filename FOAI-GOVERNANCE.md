# FOAI-code — governance, build, and gate verdict

Companion to `FORK-CHANGES.md`. This is the operator-facing record: how to build
and run the governed fork, the honest AIMS 8-gate verdict, and the Tool Warehouse
intake request. Nothing here is claimed live-ready that has not passed its gates.

## 1. Build & run (usable from a clean checkout)

Verified on Windows 11, Node 26.0.0, pnpm 10.33.0 (repo pins Node 24.15.0 via
`.nvmrc`; Node 26 built and ran clean).

```bash
git clone https://github.com/BoomerAng9/AIMS-code.git
cd AIMS-code
git remote add upstream https://github.com/MoonshotAI/kimi-code.git   # sync future fixes
pnpm install --frozen-lockfile        # lockfile-pinned deps
pnpm run build                        # builds packages + apps/kimi-code (dist/main.mjs, ~16 MB)

# The governed binary. Governance is ON by default and fail-closed:
node apps/kimi-code/dist/main.mjs --version         # -> 0.27.0 (gate bypassed for --version)
node apps/kimi-code/dist/main.mjs -p "hi"           # -> EXITS 78: refuses to launch ungoverned

# Governed launch (points every model call at the A.I.M.S. Gateway):
export AIMS_GATEWAY_BASE_URL="http://127.0.0.1:8317/v1"   # Stage Zero origin (INV-3)
export FOAI_RECEIPT_SINK="/var/lib/charlotte/receipts.jsonl"   # audit ledger (optional)
export FOAI_MISSION_ID="…"  FOAI_TASK_ID="…"                    # correlation (optional)
node apps/kimi-code/dist/main.mjs -p "…"
```

Provider connectivity (the gateway endpoint + key) is supplied via `config.toml`
under `$KIMI_CODE_HOME` exactly as AIMS-Charlotte PR #72 does — connectivity stays
in config; enforcement (Write denial, per-call ID, fail-closed) is in source.

### Build status: PASS (observed)

- `pnpm install --frozen-lockfile` — OK.
- `pnpm run build` — OK (all packages + `apps/kimi-code`).
- `pnpm --filter @moonshot-ai/agent-core run typecheck` — clean.
- Binary runs: `--version` → `0.27.0`; ungoverned `-p` → exit 78.

Test-suite note (honest): the full `agent-core` vitest suite has ~119 pre-existing
failures on this Windows/Node-26 environment (path-separator `\` vs `/`, native
image deps, `additionalDirs`/snapshot). These are NOT introduced by the FOAI
layer — a pristine base-commit run of the same files showed 37 failures vs 35 on
this branch (fewer, within noise). The FOAI suite itself is 35/35 green.

## 2. Acceptance — governed binary refuses a denied Write

Two independent proofs, both PASS:

- **In-process, automated** (`packages/agent-core/test/foai/denied-write.e2e.test.ts`):
  drives the REAL agent loop with a scripted adversary model that emits one
  `Write`; asserts the target file is byte-identical and a `csp.tool.refused`
  receipt is recorded. Runs in CI (no binary/creds needed).

- **Against the built binary** (manual, reproducible via
  `packages/agent-core/test/foai/fixtures/fake-gateway.mjs`): a fake
  OpenAI-compatible gateway emits `Write` calls; the governed `dist/main.mjs`
  runs headless against it. Observed: **12 model calls → 12 `csp.tool.refused`
  → `protected.py` byte-identical**, and **12 DISTINCT per-call Stage Zero
  decision IDs on the wire** (sequences 1–12) → **12 dispatch receipts** (1:1).

Relationship to PR #72's skipped test: PR #72's
`test_live_denied_write_is_refused_end_to_end` is gated on
`KimiCodeAdapter().configured` (the `kimi` binary on PATH) and, in full form,
needs the DEPLOYED gateway. This fork provides the equivalent proof at the
agent-core + built-binary layers; the Charlotte-side `skipif` flips once this
fork's `dist/main.mjs` is on PATH. The full live path (Charlotte spawning the
binary against the deployed A.I.M.S. Gateway) remains **UNVERIFIED** — the
gateway is not deployed on this machine (owner-gated infra).

## 3. AIMS OSS Hardening 8-gate verdict (honest, per gate)

This is a **CLI runtime with no listening network surface**, so several gates are
N/A by construction; deploy-posture gates are UNVERIFIED-pending-deploy, not FAIL.

| # | Gate | Verdict | Basis |
|---|------|---------|-------|
| 1 | WAN seal v4+v6 | **N/A** | CLI opens no listening port. Applies only if run as `kimi web`/server — then UNVERIFIED-pending-deploy. |
| 2 | Reverse-proxy + TLS + edge auth | **N/A / UNVERIFIED-pending-deploy** | No public surface in CLI mode. Required when exposed as a service (owner-gated deploy). |
| 3 | No default/weak creds | **PASS** | Fork introduces no credentials and no admin/first-run surface. Gateway auth is the operator's key from config, never a default. |
| 4 | Secret hygiene | **PASS** | FOAI receipts/logs never emit the gateway `api_key` — dispatch/session receipts carry only the gateway URL + decision/mission/task IDs (verified in source). `process.env` is read for governance, never echoed. Config-file `chmod 600` is the provisioner's step (Charlotte PR #72). |
| 5 | No docker.sock exposure | **N/A** | Not containerized; no socket mounts. |
| 6 | Image/dependency pinning | **PARTIAL PASS / N/A** | No container image to digest-pin (N/A). JS deps are lockfile-pinned; `--frozen-lockfile` install is deterministic. Trivy/Grype scan cadence = deploy-side, UNVERIFIED. |
| 7 | Data classification | **PASS** | Receipts are operational metadata (IDs, URLs), not paid/PII artifacts; written to an operator-controlled local file sink. No public store. |
| 8 | Monitoring | **UNVERIFIED-pending-deploy** | The fork EMITS the receipt stream that IS the audit-monitoring input; exposure-drift alerting, telemetry review, and restore-tested backups are deploy-time/owner-side. |

**Overall:** No gate FAILs. But the checklist is not a full PASS — gates 2, 6, 8
are UNVERIFIED-pending-deploy and 1/2/5 are N/A only because nothing is deployed.
**Per AIMS canon, without a full 8-gate PASS AND a certified Tool Warehouse
record, this runtime is SANDBOX-ONLY / NOT cleared for live use.** The governance
controls themselves are proven (CSP + per-call ID + fail-closed + receipts); the
open items are deployment posture, which is out of scope here and owner-gated.

## 4. Tool Warehouse intake request (routes through Chicken Hawk per canon)

```yaml
tool_warehouse_record_request:
  name: AIMS-code (governed kimi-code fork)
  repo: BoomerAng9/AIMS-code
  branch: feat/foai-governance-layer
  upstream: MoonshotAI/kimi-code @ 0.27.0 (MIT)
  classification: coding-runtime
  governance:
    inv3_stage_zero: enforced (config-time origin check + per-call wire decision id)
    csp: enforced (blind Write unavailable; Edit exact-match only)
    fail_closed: enforced at CLI launch (exit 78 without AIMS_GATEWAY_BASE_URL)
    receipts: governance.session.started, stage_zero.call.dispatched,
              stage_zero.call.refused, csp.tool.refused (JSON Lines)
  gate_verdict: NO-FAIL; not full-PASS (gates 2/6/8 UNVERIFIED-pending-deploy)
  live_status: SANDBOX-ONLY until 8-gate PASS + certified record
  intake_route: Chicken Hawk (canon)
  blockers_to_live:
    - deploy A.I.M.S. Gateway (owner-gated) and verify live Stage Zero round-trip
    - run PR #72 live denied-Write with binary on PATH against deployed gateway
    - deploy-posture gates (edge auth if exposed, scan cadence, drift monitoring, backups)
```

## 5. What production deployment would require (out of scope here)

1. Deploy the A.I.M.S. Gateway (`BoomerAng9/A.I.M.S.-CLIProxyAPI`) and confirm a
   live Stage Zero round-trip carries the per-call decision ID end-to-end.
2. Publish/pin the governed binary and put it on PATH for Charlotte's
   `KimiCodeAdapter`; then un-skip and run PR #72's live denied-Write test.
3. Provision `config.toml` with the gateway key at `chmod 600`; wire
   `FOAI_RECEIPT_SINK` into Charlotte's ledger tail.
4. Satisfy the deploy-posture gates (2/6/8) for the surface it runs on.
