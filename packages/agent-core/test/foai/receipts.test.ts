import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileReceiptSink, MemoryReceiptSink, receipt } from '../../src/foai/receipts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foai-receipt-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('receipts', () => {
  it('builds an envelope with correlation, omitting empty fields', () => {
    const r = receipt('csp.tool.refused', { sessionId: 's', missionId: 'm', taskId: '' }, { a: 1 });
    expect(r.kind).toBe('csp.tool.refused');
    expect(r.sessionId).toBe('s');
    expect(r.missionId).toBe('m');
    expect('taskId' in r).toBe(false);
    expect(r.detail['a']).toBe(1);
    expect(typeof r.at).toBe('string');
  });

  it('FileReceiptSink appends JSON Lines that round-trip', () => {
    const path = join(dir, 'nested', 'ledger.jsonl');
    const sink = new FileReceiptSink(path);
    sink.emit(receipt('governance.session.started', { sessionId: 's1' }, { n: 1 }));
    sink.emit(receipt('stage_zero.call.dispatched', { sessionId: 's1' }, { n: 2 }));

    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).kind).toBe('governance.session.started');
    expect(JSON.parse(lines[1]!).detail.n).toBe(2);
  });

  it('FileReceiptSink never throws on a bad path (receipts must not halt a session)', () => {
    // A directory path as the sink file is unwritable; emit must degrade, not throw.
    const sink = new FileReceiptSink(dir);
    expect(() => sink.emit(receipt('csp.tool.refused', { sessionId: 's' }, {}))).not.toThrow();
  });

  it('MemoryReceiptSink collects for assertions', () => {
    const sink = new MemoryReceiptSink();
    sink.emit(receipt('csp.tool.refused', { sessionId: 's' }, {}));
    expect(sink.receipts).toHaveLength(1);
  });
});
