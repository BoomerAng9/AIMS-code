/**
 * GovernedModelProvider — INV-3 enforced at the `ModelProvider` seam.
 *
 * Wraps any `ModelProvider` (in practice `ProviderManager`) and, on every
 * model-call resolution:
 *
 *   1. VERIFIES the resolved provider actually points at the A.I.M.S.
 *      Gateway. A config that names some other endpoint is refused, not
 *      silently rewritten — rewriting would mask a misconfiguration and send
 *      traffic somewhere the operator did not intend.
 *   2. MINTS a fresh Stage Zero decision ID and stamps it onto the outbound
 *      headers, so the gateway can attribute this individual call.
 *   3. EMITS a receipt for the dispatch, so the ledger sees every call that
 *      was authorised — and, by the sequence gap, any that were not.
 *
 * WHY WRAP RATHER THAN EDIT `ProviderManager`
 * ───────────────────────────────────────────
 * This fork must keep merging upstream. `ProviderManager` is a hot file
 * upstream; a decorator that satisfies the same published interface keeps the
 * FOAI delta out of it. The single wiring change lives at the construction
 * site (`rpc/core-impl.ts`), which is one line and trivially re-appliable.
 */

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

  /** Model calls resolved so far. Surfaced for receipts and tests. */
  get callCount(): number {
    return this.minter.callCount;
  }

  resolveProviderConfig(model: string): ResolvedRuntimeProvider {
    const resolved = this.inner.resolveProviderConfig(model);

    if (!this.config.enabled) return resolved;

    const gateway = this.config.gatewayBaseUrl;
    /* c8 ignore next 4 -- unreachable: resolveGovernance guarantees a URL when enabled. */
    if (gateway === undefined) {
      throw new Inv3ViolationError(
        'INV-3: governance is enabled but no gateway base URL was resolved.',
      );
    }

    this.assertGatewayOrigin(model, resolved, gateway);

    // Mint AFTER the origin check: a refused call must not consume a sequence
    // number, otherwise the ledger shows a gap that looks like a lost receipt
    // rather than a refusal.
    const decision = this.minter.mint();
    const stamped = decisionHeaders(decision, {
      missionId: this.config.missionId,
      taskId: this.config.taskId,
    });

    this.sink.emit(
      receipt('stage_zero.call.dispatched', this.context, {
        model,
        providerName: resolved.providerName,
        decisionId: decision.value,
        sequence: decision.sequence,
        gateway,
      }),
    );

    return {
      ...resolved,
      provider: {
        ...resolved.provider,
        // Stage Zero headers are applied LAST so a provider's own
        // `custom_headers` cannot shadow the decision ID. Config must not be
        // able to blind the ledger.
        defaultHeaders: { ...resolved.provider.defaultHeaders, ...stamped },
      },
    };
  }

  resolveAuth(
    model: string,
    options?: { readonly log?: Logger },
  ): ReturnType<NonNullable<ModelProvider['resolveAuth']>> {
    return this.inner.resolveAuth?.(model, options);
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
