/**
 * Stage Zero decision IDs — minted per model-call resolution.
 *
 * THE PROBLEM THIS FIXES
 * ─────────────────────
 * AIMS-Charlotte PR #72 bound kimi to the A.I.M.S. Gateway through
 * `[providers.aims_gateway].custom_headers`, which the vendor renders once per
 * config file. Every model call was forced through Stage Zero — INV-3 held —
 * but all internal calls in a session shared ONE static decision ID. Stage
 * Zero could prove "this session was governed"; it could not attribute an
 * individual model call. PR #72 recorded that honestly as PARTIAL and named
 * the unblock condition: a header the vendor recomputes per request.
 *
 * We own this source, so we recompute it.
 *
 * GRANULARITY — stated precisely, because this is the deliverable
 * ──────────────────────────────────────────────────────────────
 * An ID is minted on every `ModelProvider.resolveProviderConfig()` call. In
 * agent-core, that method is invoked per model request — `turn/index.ts`,
 * `agent/index.ts`, and `agent/tool/index.ts` each resolve immediately before
 * dispatching. So the granularity is PER MODEL CALL, not per session.
 *
 * It is NOT per HTTP request: the provider config returned by one resolution
 * is reused by kosong's internal retry loop, so a transport-level retry of the
 * same logical call reuses that call's ID. That is the intended semantic —
 * a retry is the same Stage Zero decision, and giving it a fresh ID would
 * inflate the ledger with decisions no one made. Sub-request attribution, if
 * ever needed, belongs on the `attempt` field below rather than on a new ID.
 */

import { randomUUID } from 'node:crypto';

/** Header carrying the per-call Stage Zero decision ID. */
export const DECISION_ID_HEADER = 'X-Stage-Zero-Decision-Id';

/** Header carrying the session this call belongs to. */
export const SESSION_ID_HEADER = 'X-Stage-Zero-Session-Id';

/** Header carrying the monotonic call sequence within the session. */
export const CALL_SEQUENCE_HEADER = 'X-Stage-Zero-Call-Seq';

/** Header carrying the mission correlation. */
export const MISSION_ID_HEADER = 'X-Mission-Id';

/** Header carrying the task correlation. */
export const TASK_ID_HEADER = 'X-Task-Id';

/** Prefix making a FOAI decision ID recognisable in gateway logs. */
export const DECISION_ID_PREFIX = 'sz';

export interface DecisionId {
  /** The full decision identifier sent to the gateway. */
  readonly value: string;
  /** Session this decision belongs to. */
  readonly sessionId: string;
  /** 1-based position of this call within the session. */
  readonly sequence: number;
  /** Milliseconds since epoch at mint time. */
  readonly mintedAt: number;
}

/**
 * Mints per-call decision IDs for one session.
 *
 * A counter plus a UUID: the counter makes ordering and gaps visible in the
 * ledger (a missing sequence number means a call that never reached the
 * gateway), while the UUID makes the ID globally unique across sessions and
 * processes. Neither alone is sufficient — a bare counter collides across
 * sessions, a bare UUID cannot reveal a gap.
 */
export class DecisionIdMinter {
  private sequence = 0;

  constructor(
    private readonly sessionId: string,
    /** Injectable for deterministic tests. */
    private readonly uuid: () => string = randomUUID,
    private readonly now: () => number = Date.now,
  ) {}

  /** Mint the next decision ID. Never returns the same value twice. */
  mint(): DecisionId {
    this.sequence += 1;
    const unique = this.uuid();
    return {
      value: `${DECISION_ID_PREFIX}-${this.sessionId}-${String(this.sequence)}-${unique}`,
      sessionId: this.sessionId,
      sequence: this.sequence,
      mintedAt: this.now(),
    };
  }

  /** Number of calls minted so far. Used by receipts and tests. */
  get callCount(): number {
    return this.sequence;
  }
}

/**
 * Build the Stage Zero header set for one call.
 *
 * Correlation headers are omitted when empty rather than sent blank, so the
 * gateway can distinguish "not supplied" from "supplied as empty".
 */
export function decisionHeaders(
  decision: DecisionId,
  correlation: { readonly missionId?: string; readonly taskId?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    [DECISION_ID_HEADER]: decision.value,
    [SESSION_ID_HEADER]: decision.sessionId,
    [CALL_SEQUENCE_HEADER]: String(decision.sequence),
  };
  if (correlation.missionId !== undefined && correlation.missionId.length > 0) {
    headers[MISSION_ID_HEADER] = correlation.missionId;
  }
  if (correlation.taskId !== undefined && correlation.taskId.length > 0) {
    headers[TASK_ID_HEADER] = correlation.taskId;
  }
  return headers;
}
