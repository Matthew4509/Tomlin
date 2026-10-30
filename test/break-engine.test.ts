// Faults found by trying to break the chat pipeline (src/engine.ts streamChat, src/pane.ts connect), each shown to fail
// before its fix. Stand-ins only: no real runner or model is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { streamChat, type ToolBox } from '../src/engine.ts';
import { Pane } from '../src/pane.ts';
import { alive } from '../src/hardware.ts';

/**
 * A stand-in for llama-server: each ask gets the next stream of `data:` lines in turn. Like the real one (measured,
 * b11284), it answers 500 to the whole request when a tool call in the chat carries arguments that are not a JSON object.
 */
async function model(streams: string[][]) {
  const asked: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const ask = JSON.parse(body) as { messages: { tool_calls?: { function: { arguments: string } }[] }[] };
      asked.push(ask);
      for (const m of ask.messages) {
        for (const c of m.tool_calls ?? []) {
          let ok = false;
          try {
            const v: unknown = JSON.parse(c.function.arguments);
            ok = !!v && typeof v === 'object' && !Array.isArray(v);
          } catch {
            // not JSON
          }
          if (!ok) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 500, message: 'Failed to parse tool call arguments as JSON' } }));
            return;
          }
        }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const line of streams[Math.min(asked.length - 1, streams.length - 1)]) res.write(line);
      res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, asked, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}

const data = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;

const box = (log: string[]): ToolBox => ({
  defs: [{ type: 'function', function: { name: 'web_search', description: 'Search.', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }],
  run: async (_name, args) => {
    log.push(args);
    try {
      JSON.parse(args);
    } catch {
      return 'Those arguments were not valid JSON. Call the tool again with JSON such as {"query": "..."}.';
    }
    return 'Results: 1. https://example.com/a';
  },
  rounds: 4,
});

test('a tool call whose arguments are cut or broken JSON does not make the next ask fail with a 500', async () => {
  // The call is cut by the length limit inside its arguments; the model answers in words once it has the tool's reply.
  const m = await model([
    [data({ tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: 'web_search', arguments: '' } }] }), data({ tool_calls: [{ index: 0, function: { arguments: '{"query": "cud' } }] }), data({}, 'length'), 'data: [DONE]\n\n'],
    [data({ content: 'CUDA 13 it is.' }), data({}, 'stop'), 'data: [DONE]\n\n'],
  ]);
  const log: string[] = [];
  try {
    const r = await streamChat(m.base, 'qwen3.5-4b', [{ role: 'user', content: 'Which CUDA?' }], () => {}, new AbortController().signal, 512, { tools: box(log) });
    assert.equal(r.text, 'CUDA 13 it is.');
    // The tool still saw what the model wrote (and told it the JSON was broken).
    assert.deepEqual(log, ['{"query": "cud']);
    assert.equal(m.asked.length, 2);
  } finally {
    await m.close();
  }
});

test('the last streamed line is read even when the stream ends without a line end after it', async () => {
  const m = await model([[data({ content: 'Hello ' }), `data: ${JSON.stringify({ choices: [{ delta: { content: 'there.' }, finish_reason: 'length' }] })}`]]);
  try {
    const r = await streamChat(m.base, 'qwen3.5-4b', [{ role: 'user', content: 'Hi' }], () => {}, new AbortController().signal, 512);
    assert.equal(r.text, 'Hello there.');
    assert.equal(r.cut, true);
  } finally {
    await m.close();
  }
});

const request = (pane: Pane, args: string[], ready: () => Promise<boolean>) => ({
  model: 'm', modelName: 'M', asked: 'auto' as const, threads: 0, devices: ['cpu' as const], expectedSeconds: 1, why: (t: string) => `failed: ${t}`,
  build: () => ({ exe: process.execPath, args: () => args, ready, device: 'cpu' as const, timeoutSeconds: 20 }),
});

test('a runner that answers and then ends at once is a failed start, not Connected to nothing', async () => {
  const pane = new Pane('chat');
  try {
    // It says it is ready only once it has ended, so the end always falls between its answer and Connected.
    const v = await pane.connect(request(pane, ['-e', ''], async () => {
      while (pane.worker.pid) await new Promise(r => setTimeout(r, 20));
      return true;
    }));
    assert.equal(v.state, 'failed');
    assert.equal(pane.worker.base, null);
  } finally {
    await pane.disconnect().catch(() => undefined);
  }
});

test('Disconnect pressed just after the runner answered: it is never said to be connected, and the runner is ended', async () => {
  const pane = new Pane('chat');
  const states: string[] = [];
  pane.onChange = v => states.push(v.state);
  let pid = 0;
  try {
    let ending: Promise<unknown> | null = null;
    await pane.connect(request(pane, ['-e', 'setTimeout(() => {}, 30000)'], async () => {
      pid = pane.worker.pid ?? 0;
      // In the moment Connect waits for the last start lines.
      setTimeout(() => (ending = pane.disconnect()), 50);
      return true;
    }));
    await ending;
    assert.ok(!states.slice(states.indexOf('unloading')).includes('connected'), `states went ${states.join(' > ')}`);
    assert.equal(pane.view.state, 'disconnected');
    assert.ok(pid && !alive(pid), 'the runner was ended');
  } finally {
    if (pid && alive(pid)) process.kill(pid);
    await pane.disconnect().catch(() => undefined);
  }
});
