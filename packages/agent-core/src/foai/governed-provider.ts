/**
 * GovernedModelProvider — INV-3 enforced at the `ModelProvider` seam, with a
 * genuinely per-model-call Stage Zero decision ID.
 *
 * TWO SEAMS, DELIBERATELY SEPARATED
 * ─────────────────────────────────
 * 1. `resolveProviderConfig` (config-time) — VERIFIES the resolved provider
 *    routes through the A.I.M.S. Gateway. This runs on every resolution,
 *    including the many metadata lookups agent-core makes (capabilities,
 *    protocol props, …). It is a pure check: no ID minted, no receipt emitted,
 *    because most of these calls never become an HTTP request.
 *
 * 2. `decorateGenerateOptions` (dispatch-time) — runs ONCE per actual model
 *    call, at `Agent.generate`'s dispatch funnel. It mints a fresh decision ID,
 *    injects it as a REQUEST-SCOPED header (kosong `auth.headers`, which
 *    override constructor-level defaults and force the OpenAI client to be
 *    rebuilt per request), and emits exactly one `stage_zero.call.dispatched`
 *    receipt.
 *
 * WHY THIS SPLIT MATTERS (learned from the live e2e)
 * ──────────────────────────────────────────────────
 * An earlier version minted in `resolveProviderConfig` and stamped the ID onto
 * the provider's `defaultHeaders`. The fake-gateway e2e disproved it: the
 * OpenAI client bakes `defaultHeaders` at construction and the turn reuses one
 * client across steps, so all HTTP calls carried a SINGLE id — no better than
 * PR #72's session-static header at the wire — while the ledger over-emitted a
 * dispatch receipt for every metadata resolution. Minting at the real dispatch
 * boundary with a request-scoped header fixes both: distinct id per model call
 * ON THE WIRE, and one receipt per real call.
 */

import type { GenerateOptions } from '@moonshot-ai/kosong';

import type { Logger } from '#/logging/types';
import type { ModelProvider, ResolvedRuntimeProvider } from '../session/provider-manager';
import { DecisionIdMinter, decisionHeaders } from './decision-id';
import { type FoaiGovernance, INV3_EXEMPT_PROVIDERS, isGatewayOrigin } from './governance';
import { type ReceiptContext, type ReceiptSink, receipt } from './receipts';

/** Raised when a model call would leave the governed path. */
export class Inv3ViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Inv3ViolationError';
  }
}

export class GovernedModelProvider implements ModelProvider {
  private readonly minter: DecisionIdMinter;
  private readonly context: ReceiptContext;

  constructor(
    private readonly inner: ModelProvider,
    private readonly config: FoaiGovernance,
    sessionId: string,
    private readonly sink: ReceiptSink,
    minter?: DecisionIdMinter,
  ) {
    this.minter = minter ?? new DecisionIdMinter(sessionId);
    this.context = {
      sessionId,
      missionId: config.missionId,
      taskId: config.taskId,
    };
  }

  get defaultModel(): string | undefined {
    return this.inner.defaultModel;
  }

  /** Receipt envelope for this session, so CSP refusals share its correlation. */
  get receiptContext(): ReceiptContext {
    return this.context;
  }

  /** Model calls dispatched so far. Surfaced for receipts and tests. */
  get callCount(): number {
    return this.minter.callCount;
  }

  resolveProviderConfig(model: string): ResolvedRuntimeProvider {
    const resolved = this.inner.resolveProviderConfig(model);
    if (!this.config.enabled) return resolved;

    // Config-time INV-3 check only. No minting here — this runs for metadata
    // lookups too, which never reach the wire.
    this.assertGatewayOrigin(model, resolved, this.gateway());
    return resolved;
  }

  resolveAuth(
    model: string,
    options?: { readonly log?: Logger },
  ): ReturnType<NonNullable<ModelProvider['resolveAuth']>> {
    return this.inner.resolveAuth?.(model, options);
  }

  /**
   * Dispatch-time hook: called once per real model call by `Agent.generate`.
   * Mints a per-call decision ID, records the dispatch, and injects the ID as a
   * request-scoped header so it reaches the gateway on THIS call's HTTP request.
   */
  decorateGenerateOptions(options: GenerateOptions | undefined): GenerateOptions | undefined {
    if (!this.config.enabled) return options;

    const decision = this.minter.mint();
    const stamped = decisionHeaders(decision, {
      missionId: this.config.missionId,
      taskId: this.config.taskId,
    });

    this.sink.emit(
      receipt('stage_zero.call.dispatched', this.context, {
        decisionId: decision.value,
        sequence: decision.sequence,
        gateway: this.config.gatewayBaseUrl,
      }),
    );

    return {
      ...options,
      auth: {
        ...options?.auth,
        // Request-scoped headers override constructor-level defaults and force
        // a per-request client rebuild, so each model call carries its own ID.
        headers: { ...options?.auth?.headers, ...stamped },
      },
    };
  }

  private gateway(): string {
    const gateway = this.config.gatewayBaseUrl;
    /* c8 ignore next 4 -- unreachable: resolveGovernance guarantees a URL when enabled. */
    if (gateway === undefined) {
      throw new Inv3ViolationError(
        'INV-3: governance is enabled but no gateway base URL was resolved.',
      );
    }
    return gateway;
  }

  private assertGatewayOrigin(
    model: string,
    resolved: ResolvedRuntimeProvider,
    gateway: string,
  ): void {
    if (INV3_EXEMPT_PROVIDERS.includes(resolved.providerName)) return;

    const baseUrl = resolved.provider.baseUrl;

    // A provider with no explicit baseUrl falls back to the vendor's own
    // default endpoint inside kosong — which is exactly the ungoverned path
    // INV-3 exists to prevent. Absence is a violation, not a pass.
    if (baseUrl === undefined || baseUrl.trim().length === 0) {
      this.refuse(model, resolved, gateway, 'provider declares no base_url');
    }

    if (!isGatewayOrigin(baseUrl, gateway)) {
      this.refuse(model, resolved, gateway, `provider base_url is ${baseUrl}`);
    }
  }

  private refuse(
    model: string,
    resolved: ResolvedRuntimeProvider,
    gateway: string,
    reason: string,
  ): never {
    this.sink.emit(
      receipt('stage_zero.call.refused', this.context, {
        model,
        providerName: resolved.providerName,
        gateway,
        reason,
      }),
    );
    throw new Inv3ViolationError(
      `INV-3 violation: model "${model}" resolves to provider ` +
        `"${resolved.providerName}" which does not route through the A.I.M.S. ` +
        `Gateway (${reason}; expected an endpoint under ${gateway}).\n\n` +
        `Every model call from this runtime must traverse Stage Zero. Point ` +
        `the provider's base_url at the gateway, or run an ungoverned build ` +
        `deliberately — see FORK-CHANGES.md.`,
    );
  }
}
