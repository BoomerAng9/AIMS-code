/**
 * FOAI governance configuration — resolved once, fail-closed.
 *
 * This is the root of the FOAI delta over upstream `MoonshotAI/kimi-code`.
 * Where the upstream CLI is a general-purpose coding agent, this fork is a
 * GOVERNED runtime: it refuses to execute unless it can prove, at source
 * level, that
 *
 *   INV-3  every model call traverses the A.I.M.S. Gateway (Stage Zero), and
 *   CSP    the blind file-overwrite path is unavailable.
 *
 * WHY SOURCE LEVEL AND NOT CONFIG
 * ───────────────────────────────
 * The prior integration (AIMS-Charlotte PR #72) achieved both controls through
 * external `config.toml` (`[[permission.rules]]`, `[providers.aims_gateway]`)
 * injected via `KIMI_CODE_HOME`. That works, but a config file can be removed,
 * hand-edited, or simply not provisioned — and the binary would then run
 * ungoverned while still looking correct. Source-level enforcement cannot be
 * un-configured: the ungoverned code path does not exist in this build.
 *
 * FAIL-CLOSED
 * ───────────
 * Governance is ON by default. Turning it off requires an explicit, loud,
 * non-default acknowledgement (`FOAI_GOVERNANCE_DISABLED` set to the exact
 * acknowledgement phrase). Anything else — unset, empty, "1", "true", "yes" —
 * leaves governance ON. There is deliberately no config-file switch: a
 * disable must be a conscious act at the process boundary, not a line in a
 * file someone else wrote.
 */

/** Exact phrase required to run this binary ungoverned. Deliberately awkward. */
export const GOVERNANCE_DISABLE_ACKNOWLEDGEMENT =
  'i-accept-running-ungoverned-and-uncredentialed';

/** Environment variable that carries the acknowledgement. */
export const GOVERNANCE_DISABLE_ENV = 'FOAI_GOVERNANCE_DISABLED';

/** Environment variable naming the A.I.M.S. Gateway base URL (INV-3). */
export const GATEWAY_BASE_URL_ENV = 'AIMS_GATEWAY_BASE_URL';

/** Environment variable naming the mission this process serves. */
export const MISSION_ID_ENV = 'FOAI_MISSION_ID';

/** Environment variable naming the task this process serves. */
export const TASK_ID_ENV = 'FOAI_TASK_ID';

/** Environment variable pointing at the receipt sink (Charlotte's ledger). */
export const RECEIPT_SINK_ENV = 'FOAI_RECEIPT_SINK';

/**
 * Provider names exempt from the INV-3 gateway-origin check.
 *
 * Empty by design. It exists as a named, greppable seam so that a future
 * exemption is a reviewed source change rather than an ambient config value.
 */
export const INV3_EXEMPT_PROVIDERS: readonly string[] = [];

export interface FoaiGovernance {
  /** True when governance is enforced. False only via explicit acknowledgement. */
  readonly enabled: boolean;
  /**
   * The A.I.M.S. Gateway base URL every model call must originate from.
   * `undefined` when governance is disabled.
   */
  readonly gatewayBaseUrl: string | undefined;
  /** Mission correlation for receipts. Empty string when not supplied. */
  readonly missionId: string;
  /** Task correlation for receipts. Empty string when not supplied. */
  readonly taskId: string;
  /** Where receipts are appended. `undefined` disables file emission. */
  readonly receiptSink: string | undefined;
}

/** Raised when the process cannot be brought up under governance. */
export class GovernanceStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernanceStartupError';
  }
}

/**
 * Normalise a base URL for origin comparison.
 *
 * INV-3 is an *origin* claim, not a string-equality claim: `/v1` vs `/v1/`
 * vs a deeper path under the same authority are the same gateway. Comparing
 * normalised origin + path prefix avoids both false negatives (trailing
 * slash) and false positives (a lookalike host).
 */
export function normalizeGatewayUrl(raw: string): string {
  const url = new URL(raw);
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`.toLowerCase();
}

/**
 * True when `candidate` is served by the gateway at `gateway`.
 *
 * Accepts the gateway origin itself and any path beneath it, so a provider
 * configured at `.../v1/chat/completions` still satisfies a gateway declared
 * as `.../v1`. Rejects a different scheme, host, or port outright.
 */
export function isGatewayOrigin(candidate: string, gateway: string): boolean {
  let normalizedCandidate: string;
  let normalizedGateway: string;
  try {
    normalizedCandidate = normalizeGatewayUrl(candidate);
    normalizedGateway = normalizeGatewayUrl(gateway);
  } catch {
    return false;
  }
  if (normalizedCandidate === normalizedGateway) return true;
  return normalizedCandidate.startsWith(`${normalizedGateway}/`);
}

/**
 * Resolve governance from an environment.
 *
 * Pure over its `env` argument so it is testable without mutating the real
 * process environment.
 *
 * @throws GovernanceStartupError when governance is on but its preconditions
 *   are unmet. Refusing here is the point: an ungoverned launch must not be
 *   reachable by omission.
 */
export function resolveGovernance(env: Record<string, string | undefined>): FoaiGovernance {
  const disableRaw = env[GOVERNANCE_DISABLE_ENV];
  const disableRequested = disableRaw !== undefined && disableRaw.trim().length > 0;

  if (disableRequested) {
    if (disableRaw.trim() !== GOVERNANCE_DISABLE_ACKNOWLEDGEMENT) {
      // A half-hearted disable is treated as an error, not as "governed
      // anyway": someone plainly INTENDED to disable governance, and silently
      // ignoring that intent hides the situation from whoever set it.
      throw new GovernanceStartupError(
        `${GOVERNANCE_DISABLE_ENV} is set but does not carry the required ` +
          `acknowledgement. To run this build ungoverned — no Stage Zero routing, ` +
          `no CSP write protection, no receipts — set it to exactly:\n\n` +
          `    ${GOVERNANCE_DISABLE_ACKNOWLEDGEMENT}\n\n` +
          `Unset it to run governed (the default).`,
      );
    }
    return {
      enabled: false,
      gatewayBaseUrl: undefined,
      missionId: env[MISSION_ID_ENV] ?? '',
      taskId: env[TASK_ID_ENV] ?? '',
      receiptSink: undefined,
    };
  }

  const gatewayBaseUrl = env[GATEWAY_BASE_URL_ENV]?.trim();
  if (gatewayBaseUrl === undefined || gatewayBaseUrl.length === 0) {
    throw new GovernanceStartupError(
      `INV-3: ${GATEWAY_BASE_URL_ENV} is required. Every model call this ` +
        `runtime makes must traverse the A.I.M.S. Gateway so Stage Zero can ` +
        `record the decision. Set ${GATEWAY_BASE_URL_ENV} to the gateway's ` +
        `OpenAI-compatible base URL (e.g. http://127.0.0.1:8317/v1).`,
    );
  }

  try {
    normalizeGatewayUrl(gatewayBaseUrl);
  } catch {
    throw new GovernanceStartupError(
      `INV-3: ${GATEWAY_BASE_URL_ENV} is not a valid absolute URL: ${gatewayBaseUrl}`,
    );
  }

  // An empty or whitespace-only sink path means "no sink", not "" — so map it
  // to undefined explicitly (nullish coalescing would keep the empty string).
  const receiptSinkRaw = env[RECEIPT_SINK_ENV]?.trim();
  const receiptSink =
    receiptSinkRaw !== undefined && receiptSinkRaw.length > 0 ? receiptSinkRaw : undefined;

  return {
    enabled: true,
    gatewayBaseUrl,
    missionId: env[MISSION_ID_ENV] ?? '',
    taskId: env[TASK_ID_ENV] ?? '',
    receiptSink,
  };
}

let cached: FoaiGovernance | undefined;

/**
 * Process-wide governance, resolved once.
 *
 * Cached so every call site sees one consistent verdict — a later mutation of
 * `process.env` must not be able to flip governance mid-session.
 *
 * @throws GovernanceStartupError when governance is on but unconfigured. Callers
 *   that must not abort (library wiring) should catch it; the CLI launch gate
 *   (`requireGovernedLaunch`) lets it propagate.
 */
export function governance(): FoaiGovernance {
  cached ??= resolveGovernance(process.env);
  return cached;
}

/**
 * The fail-closed LAUNCH gate. Call once at the CLI entrypoint, before any
 * session is created.
 *
 * Unlike `foaiRuntime()` (library-safe, non-throwing), this REFUSES to proceed
 * when governance cannot be established: the `GovernanceStartupError` propagates
 * so the caller prints it and exits non-zero. Running ungoverned must be a loud,
 * deliberate act — this is where that is enforced. On success it primes the
 * cache so every later `governance()` / `foaiRuntime()` sees the same verdict.
 *
 * @throws GovernanceStartupError when the launch is not governed and not
 *   explicitly, correctly acknowledged as ungoverned.
 */
export function requireGovernedLaunch(
  env: Record<string, string | undefined> = process.env,
): FoaiGovernance {
  const verdict = resolveGovernance(env);
  cached = verdict;
  return verdict;
}

/** Test-only reset of the cached verdict. */
export function resetGovernanceForTest(): void {
  cached = undefined;
}
