/**
 * FOAI runtime wiring — the single place governance is switched on.
 *
 * Two call sites in upstream code consult this module:
 *   - `rpc/core-impl.ts` wraps its `ProviderManager` via `governProvider()`.
 *   - `agent/tool/index.ts` selects the Write tool via `writeToolFor()`.
 * Keeping the wiring here means the upstream edits are one line each, which
 * keeps this fork mergeable.
 *
 * Governance is resolved once (fail-closed) and the sink is shared, so every
 * session in a process records to the same ledger file and sees the same
 * verdict.
 */

import type { BuiltinTool } from '../agent/tool/types';
import type { Kaos } from '@moonshot-ai/kaos';
import { WriteTool } from '../tools/builtin/file/write';
import type { WorkspaceConfig } from '../tools/support/workspace';
import { GovernedModelProvider } from './governed-provider';
import { GovernedWriteTool } from './governed-write';
import {
  type FoaiGovernance,
  GovernanceStartupError,
  governance,
} from './governance';
import type { ModelProvider } from '../session/provider-manager';
import {
  MemoryReceiptSink,
  MultiReceiptSink,
  NullReceiptSink,
  type ReceiptContext,
  type ReceiptSink,
  receipt,
  sinkFor,
} from './receipts';

interface FoaiRuntime {
  readonly config: FoaiGovernance;
  readonly sink: ReceiptSink;
}

let runtime: FoaiRuntime | undefined;

/** Governance verdict used when the process is embedding agent-core as a
 * LIBRARY and never went through the CLI launch gate. Enforcement is disabled
 * in that path on purpose: agent-core is a library, and a library is not the
 * thing that "launches". The fail-closed policy lives at the CLI boundary
 * (`requireGovernedLaunch`, wired into apps/kimi-code), which runs BEFORE any
 * session or tool is constructed. In the real binary that gate has already
 * primed `governance()` to the enabled verdict by the time this is reached, so
 * this fallback is never taken there — only in tests and third-party embeds. */
const LIBRARY_UNGOVERNED: FoaiGovernance = {
  enabled: false,
  gatewayBaseUrl: undefined,
  missionId: '',
  taskId: '',
  receiptSink: undefined,
};

/**
 * Process-wide governance + receipt sink, initialised once.
 *
 * Non-throwing by contract: it reflects the governance verdict but never itself
 * aborts a process. If governance was configured (or the CLI gate already
 * resolved it), that verdict is used; if the environment is unconfigured, the
 * library-ungoverned verdict is used. Refusing to launch ungoverned is the CLI
 * gate's job, not this function's — doing it here would abort every embed and
 * test at tool-registration time, far from the launch boundary.
 */
export function foaiRuntime(): FoaiRuntime {
  if (runtime === undefined) {
    let config: FoaiGovernance;
    try {
      config = governance();
    } catch (error) {
      // Unconfigured library/test context. The CLI gate handles the loud
      // refusal; here we degrade to ungoverned rather than crash an embed.
      if (!(error instanceof GovernanceStartupError)) throw error;
      config = LIBRARY_UNGOVERNED;
    }
    runtime = {
      config,
      sink: config.enabled ? sinkFor(config.receiptSink) : new NullReceiptSink(),
    };
  }
  return runtime;
}

/**
 * Wrap a provider so every model call it resolves is governed by INV-3 and
 * carries a per-call Stage Zero decision ID. A no-op passthrough when
 * governance is disabled, so a deliberately ungoverned build keeps working.
 *
 * Emits the `governance.session.started` receipt as a side effect: the ledger
 * should see a session begin, not just its individual calls.
 */
export function governProvider(inner: ModelProvider, sessionId: string): ModelProvider {
  const { config, sink } = foaiRuntime();
  if (!config.enabled) return inner;

  const governed = new GovernedModelProvider(inner, config, sessionId, sink);
  sink.emit(
    receipt('governance.session.started', governed.receiptContext, {
      controls: ['INV-3', 'CSP', 'per-call-decision-id', 'receipts'],
      gateway: config.gatewayBaseUrl,
    }),
  );
  return governed;
}

/**
 * Choose the Write tool for a session.
 *
 * Under governance the refusing `GovernedWriteTool` is returned, so the real
 * overwrite primitive is never constructed. The receipt context is taken from
 * the governed provider when present so CSP refusals correlate with the same
 * session/mission/task as the model calls.
 */
export function writeToolFor(
  kaos: Kaos,
  workspace: WorkspaceConfig,
  modelProvider: ModelProvider | undefined,
): BuiltinTool {
  const { config, sink } = foaiRuntime();
  if (!config.enabled) return new WriteTool(kaos, workspace) as BuiltinTool;

  const context: ReceiptContext =
    modelProvider instanceof GovernedModelProvider
      ? modelProvider.receiptContext
      : { sessionId: 'unknown', missionId: config.missionId, taskId: config.taskId };

  return new GovernedWriteTool(sink, context) as BuiltinTool;
}

/** Test-only: reset the runtime singleton. */
export function resetRuntimeForTest(): void {
  runtime = undefined;
}

/** Test-only: install an in-memory sink and return it for assertions. */
export function installMemorySinkForTest(config: FoaiGovernance): MemoryReceiptSink {
  const memory = new MemoryReceiptSink();
  runtime = { config, sink: new MultiReceiptSink([memory]) };
  return memory;
}
