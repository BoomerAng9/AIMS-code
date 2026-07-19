/**
 * End-to-end acceptance: the RUNNING governed agent refuses a denied Write.
 *
 * This is the fork-side execution of the proof that AIMS-Charlotte PR #72 left
 * SKIPPED ("a live kimi refuses a denied Write"). PR #72's test spawned the
 * `kimi` binary and therefore needed the binary + live credentials; here we
 * drive the SAME runtime code in-process through the real agent loop, with a
 * scripted model as the deterministic adversary.
 *
 * What makes this faithful, not a mock:
 *   - The binary under test is the real agent-core loop (`loop/tool-call.ts`,
 *     the real tool registry, the real `writeToolFor` governance wiring).
 *   - The only thing faked is the MODEL — a deterministic adversary that emits
 *     exactly one `Write` tool call and nothing else. It never falls back to
 *     the sanctioned `Edit`, so the test isolates "Write is refused" from "the
 *     model found another way".
 *   - The filesystem is a real temp dir driven by a real LocalKaos.
 *
 * Charlotte-side un-skip: PR #72's `test_live_denied_write_is_refused_end_to_end`
 * is gated on `KimiCodeAdapter().configured` (the kimi binary on PATH). Building
 * this fork and putting its `dist/main.mjs` on PATH flips that gate; the proof
 * that the governance holds against the running code lives here.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalKaos } from '@moonshot-ai/kaos';
import type { ToolCall } from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FoaiGovernance } from '../../src/foai/governance';
import {
  installMemorySinkForTest,
  resetRuntimeForTest,
  type MemoryReceiptSink,
} from '../../src/foai';
import { testAgent } from '../agent/harness';

const GOVERNANCE_ON: FoaiGovernance = {
  enabled: true,
  gatewayBaseUrl: 'http://127.0.0.1:8317/v1',
  missionId: 'e2e-mission',
  taskId: 'e2e-task',
  receiptSink: undefined,
};

let dir: string;
let sink: MemoryReceiptSink;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foai-e2e-'));
  sink = installMemorySinkForTest(GOVERNANCE_ON);
});

afterEach(() => {
  resetRuntimeForTest();
});

describe('E2E — governed agent refuses a denied Write against a real file', () => {
  it('leaves the target byte-identical and records the refusal', async () => {
    const target = join(dir, 'protected.py');
    writeFileSync(target, 'x = 1\n');
    const before = readFileSync(target);

    const kaos = (await LocalKaos.create()).withCwd(dir);
    const ctx = testAgent({ kaos });
    ctx.configure({ tools: ['Write'] });

    // Deterministic adversary: one Write call, nothing else.
    const writeCall: ToolCall = {
      type: 'function',
      id: 'call_write',
      name: 'Write',
      arguments: JSON.stringify({ path: 'protected.py', content: 'y = 2' }),
    };
    ctx.mockNextResponse({ type: 'text', text: 'Overwriting the file.' }, writeCall);
    // After the refusal comes back, the model gives up.
    ctx.mockNextResponse({ type: 'text', text: 'The write was refused; stopping.' });

    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'Overwrite protected.py so it contains only: y = 2' }],
    });
    await ctx.untilTurnEnd();

    // THE ACCEPTANCE: the running system did not modify the file.
    expect(readFileSync(target).equals(before)).toBe(true);

    // And the refusal is on the ledger.
    const refusals = sink.receipts.filter((r) => r.kind === 'csp.tool.refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.detail['path']).toBe('protected.py');
  });
});
