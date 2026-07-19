/**
 * Receipts — the evidence trail Charlotte's ledger consumes.
 *
 * A governance control that leaves no record is unauditable: "it was enforced"
 * becomes a claim rather than a fact. Every enforcement decision this fork
 * makes emits a receipt, including the ones where nothing was blocked, so the
 * absence of a receipt is itself a signal.
 *
 * TRANSPORT
 * ─────────
 * Receipts are appended as JSON Lines to `FOAI_RECEIPT_SINK`. A file sink is
 * deliberate: it survives a crashed process, needs no network at emit time,
 * and cannot itself fail closed and take the runtime down with it. Charlotte
 * tails the file into the audit ledger. Emission NEVER throws — a broken sink
 * degrades to a stderr warning rather than killing a governed session, because
 * losing a receipt is bad but halting mid-edit is worse.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Receipt event kinds. Stable strings — Charlotte's ledger keys off these. */
export type ReceiptKind =
  /** A session came up under governance, with the controls it verified. */
  | 'governance.session.started'
  /** A model call was resolved and stamped with a Stage Zero decision ID. */
  | 'stage_zero.call.dispatched'
  /** A model call was refused for failing the INV-3 gateway-origin check. */
  | 'stage_zero.call.refused'
  /** A CSP-forbidden tool invocation was refused. */
  | 'csp.tool.refused';

export interface Receipt {
  readonly kind: ReceiptKind;
  /** ISO-8601 emit time. */
  readonly at: string;
  readonly sessionId: string;
  readonly missionId?: string;
  readonly taskId?: string;
  /** Kind-specific payload. */
  readonly detail: Record<string, unknown>;
}

export interface ReceiptSink {
  emit(receipt: Receipt): void;
}

/** Discards receipts. Used only when governance is explicitly disabled. */
export class NullReceiptSink implements ReceiptSink {
  emit(): void {
    /* intentionally empty */
  }
}

/** Collects receipts in memory. Test and introspection use. */
export class MemoryReceiptSink implements ReceiptSink {
  readonly receipts: Receipt[] = [];

  emit(receipt: Receipt): void {
    this.receipts.push(receipt);
  }
}

/** Appends receipts as JSON Lines. The production sink. */
export class FileReceiptSink implements ReceiptSink {
  private warned = false;

  constructor(private readonly path: string) {}

  emit(receipt: Receipt): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(receipt)}\n`, { encoding: 'utf-8' });
    } catch (error) {
      // Warn once. A sink that is broken now is broken for every subsequent
      // receipt, and a warning per model call would bury the original cause.
      if (!this.warned) {
        this.warned = true;
        process.stderr.write(
          `[FOAI] receipt sink unavailable at ${this.path}: ${String(error)}\n` +
            `[FOAI] governance remains ENFORCED; receipts for this session are not being recorded.\n`,
        );
      }
    }
  }
}

/** Fan-out sink, so a session can record locally and in memory at once. */
export class MultiReceiptSink implements ReceiptSink {
  constructor(private readonly sinks: readonly ReceiptSink[]) {}

  emit(receipt: Receipt): void {
    for (const sink of this.sinks) sink.emit(receipt);
  }
}

export interface ReceiptContext {
  readonly sessionId: string;
  readonly missionId?: string;
  readonly taskId?: string;
}

/** Build a receipt with the shared envelope filled in. */
export function receipt(
  kind: ReceiptKind,
  context: ReceiptContext,
  detail: Record<string, unknown>,
  now: () => Date = () => new Date(),
): Receipt {
  return {
    kind,
    at: now().toISOString(),
    sessionId: context.sessionId,
    ...(context.missionId !== undefined && context.missionId.length > 0
      ? { missionId: context.missionId }
      : {}),
    ...(context.taskId !== undefined && context.taskId.length > 0 ? { taskId: context.taskId } : {}),
    detail,
  };
}

/** Construct the sink implied by a governance verdict. */
export function sinkFor(receiptSinkPath: string | undefined): ReceiptSink {
  return receiptSinkPath === undefined ? new NullReceiptSink() : new FileReceiptSink(receiptSinkPath);
}
