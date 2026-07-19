/**
 * GovernedWriteTool — CSP enforced at source.
 *
 * CSP ("Context Security Protocol") forbids blind file rewrites: an edit must
 * name the exact text it replaces, so a stale or wrong assumption fails loudly
 * instead of silently destroying content. Upstream's `Write` tool is
 * documented as "overwrite or append to a file" and takes the full file body
 * with no anchor — it is precisely the blind-rewrite primitive CSP exists to
 * remove.
 *
 * WHAT THIS DOES
 * ──────────────
 * Under governance, this tool is registered *in place of* upstream's
 * `WriteTool`. The real one is never constructed, so no code path in the
 * process can reach `kaos.writeText` through `Write`. This tool holds no
 * `Kaos` handle and declares `ToolAccesses.none()`: it is structurally
 * incapable of touching the filesystem, not merely unwilling.
 *
 * WHY REGISTER A REFUSING TOOL RATHER THAN DROP `Write` ENTIRELY
 * ─────────────────────────────────────────────────────────────
 * Dropping the registration makes a forced `Write` call land on the
 * unknown-tool path, whose message ("no such tool") tells the model nothing
 * about what to do instead, and tells an auditor nothing about whether
 * governance was even active. Keeping a refusing tool means:
 *   - the refusal is attributable — it emits a `csp.tool.refused` receipt;
 *   - the model is redirected to `Edit`, so the turn makes progress; and
 *   - the denial is observable in the transcript, which is what makes the
 *     end-to-end acceptance test meaningful.
 * Either shape yields a byte-identical file. This one is auditable.
 *
 * THE SANCTIONED PATH
 * ───────────────────
 * `Edit` remains fully available. It is exact-string replacement and already
 * errors — without writing — when `old_string` is absent or ambiguous, which
 * is the CSP acceptance condition: a patch whose anchor does not match leaves
 * the file byte-identical.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../agent/tool/types';
import type { ExecutableToolErrorResult, ToolExecution } from '../loop/types';
import { toInputJsonSchema } from '../tools/support/input-schema';
import { type ReceiptContext, type ReceiptSink, receipt } from './receipts';

/**
 * Input schema, kept structurally compatible with upstream `WriteInputSchema`.
 *
 * Matching the upstream shape matters: a model that has learned the `Write`
 * signature produces a well-formed call that is cleanly refused, rather than a
 * schema-validation error that obscures the governance decision.
 */
export const GovernedWriteInputSchema = z.object({
  path: z.string().describe('Path the model attempted to overwrite. Refused under FOAI CSP.'),
  content: z.string().optional().describe('Ignored. This tool never writes.'),
  mode: z.enum(['overwrite', 'append']).optional().describe('Ignored. This tool never writes.'),
});

export type GovernedWriteInput = z.Infer<typeof GovernedWriteInputSchema>;

const DESCRIPTION = [
  'DISABLED under FOAI Context Security Protocol (CSP).',
  '',
  'Whole-file overwrite is not available in this runtime. Any call to this',
  'tool is refused and no file is modified.',
  '',
  'Use the Edit tool instead: it performs exact-string replacement, so a',
  'mismatched anchor fails without destroying the file. To create a new file,',
  'ask the operator — file creation is an operator-gated action here.',
].join('\n');

export class GovernedWriteTool implements BuiltinTool<GovernedWriteInput> {
  readonly name = 'Write' as const;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GovernedWriteInputSchema);

  constructor(
    private readonly sink: ReceiptSink,
    private readonly context: ReceiptContext,
  ) {}

  resolveExecution(args: GovernedWriteInput): ToolExecution {
    // Refuse at RESOLUTION, before any approval or filesystem step exists.
    // `ToolExecution` accepts an error result directly, so there is no
    // `execute` path to reach and nothing that could ever touch disk.
    return this.refuse(args);
  }

  private refuse(args: GovernedWriteInput): ExecutableToolErrorResult {
    this.sink.emit(
      receipt('csp.tool.refused', this.context, {
        tool: this.name,
        path: args.path,
        reason: 'blind whole-file overwrite is structurally unavailable under CSP',
        // Recorded so the ledger shows the size of what was prevented without
        // storing the content itself.
        attemptedBytes:
          args.content === undefined ? 0 : Buffer.byteLength(args.content, 'utf8'),
      }),
    );

    return {
      isError: true,
      output:
        `Refused: Write is disabled under FOAI Context Security Protocol. ` +
        `${args.path} was NOT modified.\n\n` +
        `Blind whole-file overwrite is unavailable in this runtime because it ` +
        `destroys content when the model's picture of the file is stale.\n\n` +
        `Use Edit instead — supply the exact existing text as old_string and ` +
        `the replacement as new_string. Read the file first if you need its ` +
        `current contents.`,
    };
  }
}
