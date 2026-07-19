import { describe, expect, it } from 'vitest';

import {
  GATEWAY_BASE_URL_ENV,
  GOVERNANCE_DISABLE_ACKNOWLEDGEMENT,
  GOVERNANCE_DISABLE_ENV,
  GovernanceStartupError,
  isGatewayOrigin,
  normalizeGatewayUrl,
  resolveGovernance,
} from '../../src/foai/governance';

describe('FOAI governance resolution — fail-closed', () => {
  it('is ON by default and requires a gateway (INV-3)', () => {
    // Empty env: no gateway configured, no disable acknowledgement.
    expect(() => resolveGovernance({})).toThrow(GovernanceStartupError);
  });

  it('enables governance when a gateway URL is supplied', () => {
    const g = resolveGovernance({ [GATEWAY_BASE_URL_ENV]: 'http://127.0.0.1:8317/v1' });
    expect(g.enabled).toBe(true);
    expect(g.gatewayBaseUrl).toBe('http://127.0.0.1:8317/v1');
  });

  it('refuses a malformed gateway URL rather than proceeding', () => {
    expect(() => resolveGovernance({ [GATEWAY_BASE_URL_ENV]: 'not-a-url' })).toThrow(
      GovernanceStartupError,
    );
  });

  it('treats a half-hearted disable as an error, not as governed-anyway', () => {
    // Someone plainly intended to disable; ignoring that silently hides it.
    for (const raw of ['1', 'true', 'yes', 'on']) {
      expect(() => resolveGovernance({ [GOVERNANCE_DISABLE_ENV]: raw })).toThrow(
        GovernanceStartupError,
      );
    }
  });

  it('disables ONLY on the exact acknowledgement phrase', () => {
    const g = resolveGovernance({
      [GOVERNANCE_DISABLE_ENV]: GOVERNANCE_DISABLE_ACKNOWLEDGEMENT,
    });
    expect(g.enabled).toBe(false);
    expect(g.gatewayBaseUrl).toBeUndefined();
  });

  it('does NOT require a gateway when explicitly disabled', () => {
    // The disable path must not itself trip the INV-3 gateway requirement.
    expect(() =>
      resolveGovernance({ [GOVERNANCE_DISABLE_ENV]: GOVERNANCE_DISABLE_ACKNOWLEDGEMENT }),
    ).not.toThrow();
  });
});

describe('gateway-origin matching (INV-3 is an origin claim)', () => {
  const gw = 'http://127.0.0.1:8317/v1';

  it('accepts the gateway origin itself and paths beneath it', () => {
    expect(isGatewayOrigin('http://127.0.0.1:8317/v1', gw)).toBe(true);
    expect(isGatewayOrigin('http://127.0.0.1:8317/v1/', gw)).toBe(true);
    expect(isGatewayOrigin('http://127.0.0.1:8317/v1/chat/completions', gw)).toBe(true);
  });

  it('rejects a different host, port, or scheme', () => {
    expect(isGatewayOrigin('http://api.moonshot.ai/v1', gw)).toBe(false);
    expect(isGatewayOrigin('http://127.0.0.1:9999/v1', gw)).toBe(false);
    expect(isGatewayOrigin('https://127.0.0.1:8317/v1', gw)).toBe(false);
  });

  it('rejects a lookalike-prefix host (no substring escape)', () => {
    // A path prefix must be a real path boundary, not a string prefix.
    expect(isGatewayOrigin('http://127.0.0.1:8317/v1evil', gw)).toBe(false);
  });

  it('normalises trailing slashes', () => {
    expect(normalizeGatewayUrl('http://127.0.0.1:8317/v1/')).toBe(
      normalizeGatewayUrl('http://127.0.0.1:8317/v1'),
    );
  });
});
