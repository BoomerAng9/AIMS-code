import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalKaos } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GovernedWriteTool } from '../../src/foai/governed-write';
import { MemoryReceiptSink } from '../../src/foai/receipts';
import { EditTool, type EditInput } from '../../src/tools/builtin/file/edit';
import type { WorkspaceConfig } from '../../src/tools/support/workspace';
import { executeTool } from '../tools/fixtures/execute-tool';
import { toolContentString } from '../tools/fixtures/fake-kaos';

const signal = new AbortController().signal;
const CONTEXT = { sessionId: 'sess-csp', missionId: 'm', taskId: 't' };

let dir: string;
let kaos: LocalKaos;
let workspace: WorkspaceConfig;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'foai-csp-'));
  kaos = (await LocalKaos.create()).withCwd(dir);
  workspace = { workspaceDir: dir, additionalDirs: [] };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CSP at source — the blind-overwrite path is unavailable', () => {
  it('the governed Write tool refuses and is auditable', async () => {
    const sink = new MemoryReceiptSink();
    const tool = new GovernedWriteTool(sink, CONTEXT);

    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'c',
      args: { path: 'protected.py', content: 'y = 2' },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('Refused');
    expect(toolContentString(result)).toContain('Edit');
    expect(sink.receipts.some((r) => r.kind === 'csp.tool.refused')).toBe(true);
  });

  it('a forced Write leaves the target file BYTE-IDENTICAL (ACCEPTANCE)', async () => {
    const target = join(dir, 'protected.py');
    writeFileSync(target, 'x = 1\n');
    const before = readFileSync(target); // Buffer

    const governed = new GovernedWriteTool(new MemoryReceiptSink(), CONTEXT);
    await executeTool(governed, {
      turnId: '0',
      toolCallId: 'attack',
      args: { path: 'protected.py', content: 'y = 2' },
      signal,
    });

    expect(readFileSync(target).equals(before)).toBe(true);
  });

  it('a mismatched Edit anchor also leaves the file byte-identical (sanctioned path)', async () => {
    const target = join(dir, 'protected.py');
    writeFileSync(target, 'x = 1\n');
    const before = readFileSync(target);

    const edit = new EditTool(kaos, workspace);
    const args: EditInput = {
      path: 'protected.py',
      old_string: 'this anchor does not exist in the file',
      new_string: 'y = 2',
    };
    const result = await executeTool(edit, { turnId: '0', toolCallId: 'e', args, signal });

    expect(result.isError).toBe(true);
    expect(readFileSync(target).equals(before)).toBe(true);
  });

  it('a MATCHING Edit anchor succeeds — the sanctioned path still works', async () => {
    const target = join(dir, 'protected.py');
    writeFileSync(target, 'x = 1\n');

    const edit = new EditTool(kaos, workspace);
    const args: EditInput = { path: 'protected.py', old_string: 'x = 1', new_string: 'y = 2' };
    const result = await executeTool(edit, { turnId: '0', toolCallId: 'e2', args, signal });

    expect(result.isError).not.toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('y = 2\n');
  });
});
