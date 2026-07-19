import { describe, expect, it } from 'vitest';

import type { ModelProvider, ResolvedRuntimeProvider } from '../../src/session/provider-manager';
import { DECISION_ID_HEADER } from '../../src/foai/decision-id';
import type { FoaiGovernance } from '../../src/foai/governance';
import { GovernedModelProvider, Inv3ViolationError } from '../../src/foai/governed-provider';
import { MemoryReceiptSink } from '../../src/foai/receipts';

const GOVERNANCE: FoaiGovernance = {
  enabled: true,
  gatewayBaseUrl: 'http://127.0.0.1:8317/v1',
  missionId: 'mission-1',
  taskId: 'task-1',
  receiptSink: undefined,
};

/** A stand-in inner provider resolving to `baseUrl`. */
function fakeInner(baseUrl: string | undefined): ModelProvider {
  return {
    defaultModel: 'm',
    resolveProviderConfig(model: string): ResolvedRuntimeProvider {
      return {
        providerName: 'fake',
        provider: { type: 'openai', model, baseUrl } as ResolvedRuntimeProvider['provider'],
        modelCapabilities: {} as ResolvedRuntimeProvider['modelCapabilities'],
        type: 'openai',
        protocol: undefined,
      };
    },
  };
}

function governed(baseUrl: string | undefined, sink = new MemoryReceiptSink()) {
  return {
    gov: new GovernedModelProvider(fakeInner(baseUrl), GOVERNANCE, 'sess', sink),
    sink,
  };
}

describe('GovernedModelProvider — INV-3 (config-time)', () => {
  it('allows a provider that routes through the gateway', () => {
    const { gov } = governed('http://127.0.0.1:8317/v1');
    expect(() => gov.resolveProviderConfig('m')).not.toThrow();
  });

  it('does NOT mint or emit on a config resolution (metadata lookups are frequent)', () => {
    const { gov, sink } = governed('http://127.0.0.1:8317/v1');
    gov.resolveProviderConfig('m');
    gov.resolveProviderConfig('m');
    // Config-time is a pure check: no dispatch receipts, no sequence consumed.
    expect(sink.receipts.filter((r) => r.kind === 'stage_zero.call.dispatched')).toHaveLength(0);
    expect(gov.callCount).toBe(0);
  });

  it('REFUSES a provider that does not route through the gateway', () => {
    const { gov, sink } = governed('http://api.moonshot.ai/v1');
    expect(() => gov.resolveProviderConfig('m')).toThrow(Inv3ViolationError);
    expect(sink.receipts.some((r) => r.kind === 'stage_zero.call.refused')).toBe(true);
  });

  it('REFUSES a provider with no base_url (would fall back to vendor default)', () => {
    const { gov } = governed(undefined);
    expect(() => gov.resolveProviderConfig('m')).toThrow(Inv3ViolationError);
  });
});

describe('GovernedModelProvider — per-call decision ID (dispatch-time)', () => {
  it('injects a DISTINCT decision-id header on each generate call', () => {
    const { gov } = governed('http://127.0.0.1:8317/v1');
    const first = gov.decorateGenerateOptions(undefined)?.auth?.headers?.[DECISION_ID_HEADER];
    const second = gov.decorateGenerateOptions(undefined)?.auth?.headers?.[DECISION_ID_HEADER];

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second); // per-call, not session-static, ON THE WIRE
  });

  it('preserves any pre-existing auth and headers while adding the decision id', () => {
    const { gov } = governed('http://127.0.0.1:8317/v1');
    const out = gov.decorateGenerateOptions({
      auth: { apiKey: 'k', headers: { 'X-Keep': 'yes' } },
    });
    expect(out?.auth?.apiKey).toBe('k');
    expect(out?.auth?.headers?.['X-Keep']).toBe('yes');
    expect(out?.auth?.headers?.[DECISION_ID_HEADER]).toBeDefined();
  });

  it('emits exactly one dispatch receipt per generate call', () => {
    const { gov, sink } = governed('http://127.0.0.1:8317/v1');
    gov.decorateGenerateOptions(undefined);
    gov.decorateGenerateOptions(undefined);
    const dispatched = sink.receipts.filter((r) => r.kind === 'stage_zero.call.dispatched');
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]?.detail['sequence']).toBe(1);
    expect(dispatched[1]?.detail['sequence']).toBe(2);
    expect(dispatched[0]?.missionId).toBe('mission-1');
  });
});

describe('GovernedModelProvider — disabled passthrough', () => {
  it('does not decorate or emit when governance is disabled', () => {
    const disabled: FoaiGovernance = {
      enabled: false,
      gatewayBaseUrl: undefined,
      missionId: '',
      taskId: '',
      receiptSink: undefined,
    };
    const sink = new MemoryReceiptSink();
    const gov = new GovernedModelProvider(fakeInner('http://elsewhere/v1'), disabled, 's', sink);
    // A non-gateway base_url is allowed through an ungoverned build.
    expect(() => gov.resolveProviderConfig('m')).not.toThrow();
    const out = gov.decorateGenerateOptions({ auth: { apiKey: 'k' } });
    expect(out?.auth?.headers?.[DECISION_ID_HEADER]).toBeUndefined();
    expect(sink.receipts).toHaveLength(0);
  });
});
