import { afterEach, describe, expect, it } from 'vitest';

import {
  GATEWAY_BASE_URL_ENV,
  GOVERNANCE_DISABLE_ACKNOWLEDGEMENT,
  GOVERNANCE_DISABLE_ENV,
  GovernanceStartupError,
  requireGovernedLaunch,
  resetGovernanceForTest,
} from '../../src/foai/governance';

afterEach(() => {
  resetGovernanceForTest();
});

describe('fail-closed launch gate', () => {
  it('REFUSES to launch when the gateway is not configured', () => {
    expect(() => requireGovernedLaunch({})).toThrow(GovernanceStartupError);
  });

  it('REFUSES on a half-hearted disable (not the exact acknowledgement)', () => {
    expect(() => requireGovernedLaunch({ [GOVERNANCE_DISABLE_ENV]: 'true' })).toThrow(
      GovernanceStartupError,
    );
  });

  it('permits a governed launch and primes the cache', () => {
    const verdict = requireGovernedLaunch({ [GATEWAY_BASE_URL_ENV]: 'http://127.0.0.1:8317/v1' });
    expect(verdict.enabled).toBe(true);
    expect(verdict.gatewayBaseUrl).toBe('http://127.0.0.1:8317/v1');
  });

  it('permits an explicitly, correctly acknowledged ungoverned launch', () => {
    const verdict = requireGovernedLaunch({
      [GOVERNANCE_DISABLE_ENV]: GOVERNANCE_DISABLE_ACKNOWLEDGEMENT,
    });
    expect(verdict.enabled).toBe(false);
  });
});
