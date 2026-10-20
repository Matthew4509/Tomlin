import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { streamChat } from '../src/engine.ts';
import { chatArgs } from '../src/llama.ts';
import { runnerHeaders } from '../src/runnerkeys.ts';
import { Worker } from '../src/worker.ts';

test('llama-server is started with a key of its own and no slots page', () => {
  const a = chatArgs('m.gguf', 9000, 'cpu', 0, false, undefined, false, 'k'.repeat(48));
  assert.deepEqual(a.slice(a.indexOf('--api-key'), a.indexOf('--api-key') + 2), ['--api-key', 'k'.repeat(48)]);
  assert.ok(a.includes('--no-slots'));
});

/** A runner stand-in that answers only with the key it was started with, as llama-server --api-key does (/health is open). */
const RUNNER = `
const http = require('node:http');
const [port, key] = process.argv.slice(1);
http.createServer((req, res) => {
  if (req.url === '/health') return res.end('{}');
  if (req.headers.authorization !== 'Bearer ' + key) { res.writeHead(401); return res.end('{"error":"Invalid API Key"}'); }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'With the key.' }, finish_reason: null }] }) + '\\n\\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\\n\\n');
  res.end('data: [DONE]\\n\\n');
}).listen(Number(port), '127.0.0.1');
`;

test('every start gets a new key; TOMLIN sends it, nothing else has it, and it is forgotten when the runner ends', async () => {
  const w = new Worker('chat');
  const keys: string[] = [];
  const start = () => w.launch({
    exe: process.execPath,
    args: (port, key) => (keys.push(key), ['-e', RUNNER, String(port), key]),
    ready: async port => (await fetch(`http://127.0.0.1:${port}/health`)).ok,
    device: 'cpu',
    timeoutSeconds: 20,
  });
  assert.equal(await start(), 'ready');
  const base = w.base!;
  try {
    assert.match(keys[0], /^[0-9a-f]{48}$/);
    const r = await streamChat(base, 'm', [{ role: 'user', content: 'hi' }], () => undefined, new AbortController().signal);
    assert.equal(r.text, 'With the key.');
    // Another program on this PC that found the port: refused.
    assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' })).status, 401);
  } finally {
    await w.end();
  }
  assert.deepEqual(runnerHeaders(base), {});
  assert.equal(await start(), 'ready');
  try {
    assert.notEqual(keys[1], keys[0]);
    assert.deepEqual(runnerHeaders(w.base!), { authorization: `Bearer ${keys[1]}` });
  } finally {
    await w.end();
  }
});

test('a runner address TOMLIN did not start gets no key sent to it', async () => {
  const s = createServer((req, res) => res.end(String(req.headers.authorization ?? 'none')));
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  try {
    assert.deepEqual(runnerHeaders(`http://127.0.0.1:${(s.address() as { port: number }).port}`), {});
  } finally {
    await new Promise(r => s.close(r));
  }
});
