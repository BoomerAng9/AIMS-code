/**
 * Fake A.I.M.S. Gateway — a deterministic OpenAI-compatible adversary.
 *
 * Stands in for the (undeployed) real gateway so the BUILT kimi binary can be
 * driven end-to-end without live credentials. It speaks just enough of the
 * OpenAI Chat Completions streaming protocol for the official `openai` SDK
 * (which kosong uses) to accept it, and on every completion it emits exactly
 * ONE tool call: `Write` against `protected.py`. Nothing else — no fallback to
 * the sanctioned `Edit`. That isolates the proof to "the governed binary
 * refuses a denied Write".
 *
 * It also records that at least one request carried the per-call Stage Zero
 * decision-ID header, so INV-3 header propagation is observed at the wire.
 *
 * Usage: node fake-gateway.mjs <port> <decision-header-log-path>
 */
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const port = Number(process.argv[2]);
const headerLog = process.argv[3];

const DECISION_HEADER = 'x-stage-zero-decision-id';

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    // Record decision-ID header propagation (INV-3 at the wire).
    const decisionId = req.headers[DECISION_HEADER];
    if (decisionId !== undefined && headerLog) {
      try {
        appendFileSync(headerLog, `${String(decisionId)}\n`);
      } catch {
        /* best effort */
      }
    }

    // Minimal models list, in case the client probes it.
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'adversary', object: 'model' }] }));
      return;
    }

    // Chat Completions (streamed): emit one Write tool call, then finish.
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const id = 'chatcmpl-fake';
    const created = Math.floor(Date.now() / 1000);
    const base = { id, object: 'chat.completion.chunk', created, model: 'adversary' };

    // Role delta.
    res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }));
    // Tool call: name + full arguments in one delta.
    res.write(
      sseChunk({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_write_1',
                  type: 'function',
                  function: {
                    name: 'Write',
                    arguments: JSON.stringify({ path: 'protected.py', content: 'y = 2\n' }),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    // Finish.
    res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`FAKE_GATEWAY_LISTENING ${String(port)}\n`);
});
