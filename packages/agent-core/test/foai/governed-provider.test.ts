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
        // Only `baseUrl` and `defaultHeaders` are read by the governor.
        provider: { type: 'openai', model, baseUrl } as ResolvedRuntimeProvider['provider'],
        modelCapabilities: {} as ResolvedRuntimeProvider['modelCapabilities'],
        type: 'openai',
        protocol: undefined,
      };
    },
  };
}

describe('GovernedModelProvider — INV-3 at the ModelProvider seam', () => {
  it('stamps a DISTINCT decision id on each resolved call', () => {
    const sink = new MemoryReceiptSink();
    const gov = new GovernedModelProvider(
      fakeInner('http://127.0.0.1:8317/v1'),
      GOVERNANCE,
      'sess-1',
      sink,
    );

    const first = gov.resolveProviderConfig('m').provider.defaultHeaders?.[DECISION_ID_HEADER];
    const second = gov.resolveProviderConfig('m').provider.defaultHeaders?.[DECISION_ID_HEADER];

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second); // per-call, not session-static
  });

  it('emits a dispatch receipt per authorised call', () => {
    const sink = new MemoryReceiptSink();
    const gov = new GovernedModelProvider(
      fakeInner('http://127.0.0.1:8317/v1'),
      GOVERNANCE,
      'sess-2',
      sink,
    );
    gov.resolveProviderConfig('m');
    gov.resolveProviderConfig('m');

    const dispatched = sink.receipts.filter((r) => r.kind === 'stage_zero.call.dispatched');
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]?.detail.sequence).toBe(1);
    expect(dispatched[1]?.detail.sequence).toBe(2);
    expect(dispatched[0]?.missionId).toBe('mission-1');
  });

  it('REFUSES a provider that does not route through the gateway', () => {
    const sink = new MemoryReceiptSink();
    const gov = new GovernedModelProvider(
      fakeInner('http://api.moonshot.ai/v1'),
      GOVERNANCE,
      'sess-3',
      sink,
    );
    expect(() => gov.resolveProviderConfig('m')).toThrow(Inv3ViolationError);
    expect(sink.receipts.some((r) => r.kind === 'stage_zero.call.refused')).toBe(true);
  });

  it('REFUSES a provider with no base_url (would fall back to vendor default)', () => {
    const sink = new MemoryReceiptSink();
    const gov = new GovernedModelProvider(fakeInner(undefined), GOVERNANCE, 'sess-4', sink);
    expect(() => gov.resolveProviderConfig('m')).toThrow(Inv3ViolationError);
  });

  it('does not consume a sequence number on a refused call', () => {
    const sink = new MemoryReceiptSink();
    const gov = new GovernedModelProvider(fakeInner(undefined), GOVERNANCE, 'sess-5', sink);
    expect(() => gov.resolveProviderConfig('m')).toThrow();
    expect(gov.callCount).toBe(0); // refusal must not look like a lost receipt
  });

  it('passes through untouched when governance is disabled', () => {
    const disabled: FoaiGovernance = {
      enabled: false,
      gatewayBaseUrl: undefined,
      missionId: '',
      taskId: '',
      receiptSink: undefined,
    };
    const sink = new MemoryReceiptSink();
    // A non-gateway base_url is allowed through an ungoverned build.
    const gov = new GovernedModelProvider(fakeInner('http://elsewhere/v1'), disabled, 's', sink);
    const resolved = gov.resolveProviderConfig('m');
    expect(resolved.provider.defaultHeaders?.[DECISION_ID_HEADER]).toBeUndefined();
    expect(sink.receipts).toHaveLength(0);
  });
});
