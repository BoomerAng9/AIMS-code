import { describe, expect, it } from 'vitest';

import {
  CALL_SEQUENCE_HEADER,
  DECISION_ID_HEADER,
  DecisionIdMinter,
  decisionHeaders,
  MISSION_ID_HEADER,
  SESSION_ID_HEADER,
  TASK_ID_HEADER,
} from '../../src/foai/decision-id';

describe('per-call Stage Zero decision IDs', () => {
  it('mints a DISTINCT id on every call (fixes PR #72 session-static ID)', () => {
    const minter = new DecisionIdMinter('sess-A');
    const a = minter.mint();
    const b = minter.mint();
    const c = minter.mint();

    // The core deliverable: not session-scoped. Three calls, three ids.
    expect(new Set([a.value, b.value, c.value]).size).toBe(3);
    expect([a.sequence, b.sequence, c.sequence]).toEqual([1, 2, 3]);
  });

  it('embeds the session id and a monotonic sequence so ledger gaps are visible', () => {
    const minter = new DecisionIdMinter('sess-B', () => 'uuid');
    expect(minter.mint().value).toBe('sz-sess-B-1-uuid');
    expect(minter.mint().value).toBe('sz-sess-B-2-uuid');
    expect(minter.callCount).toBe(2);
  });

  it('builds the outbound header set with correlation when present', () => {
    const minter = new DecisionIdMinter('sess-C', () => 'u');
    const headers = decisionHeaders(minter.mint(), { missionId: 'm1', taskId: 't1' });
    expect(headers[DECISION_ID_HEADER]).toBe('sz-sess-C-1-u');
    expect(headers[SESSION_ID_HEADER]).toBe('sess-C');
    expect(headers[CALL_SEQUENCE_HEADER]).toBe('1');
    expect(headers[MISSION_ID_HEADER]).toBe('m1');
    expect(headers[TASK_ID_HEADER]).toBe('t1');
  });

  it('omits empty correlation headers rather than sending them blank', () => {
    const minter = new DecisionIdMinter('sess-D', () => 'u');
    const headers = decisionHeaders(minter.mint(), { missionId: '', taskId: undefined });
    expect(MISSION_ID_HEADER in headers).toBe(false);
    expect(TASK_ID_HEADER in headers).toBe(false);
  });
});
