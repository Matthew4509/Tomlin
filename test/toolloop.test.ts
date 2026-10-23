// Tools while a model answers (src/engine.ts streamChat with a ToolBox): a stand-in for llama.cpp's server streams a
// tool call in pieces, the call is run, and the model is asked again with the call and what it gave, until it answers
// in words. The rounds run out: the last ask offers no tools, and a call made anyway is not run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { streamChat, type ToolBox } from '../src/engine.ts';

type Reply = { calls?: { name: string; args: string[] }[]; text?: string; think?: string };

/** A stand-in server: answers each ask with the next reply in turn, and keeps every request it was sent. */
async function model(replies: Reply[]) {
  const asked: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      asked.push(JSON.parse(body));
      const r = replies[Math.min(asked.length - 1, replies.length - 1)];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
      if (r.think) send({ reasoning_content: r.think });
      for (const [i, c] of (r.calls ?? []).entries()) {
        send({ tool_calls: [{ index: i, id: `call_${i}`, type: 'function', function: { name: c.name, arguments: '' } }] });
        for (const a of c.args) send({ tool_calls: [{ index: i, function: { arguments: a } }] });
      }
      for (const w of (r.text ?? '').split(/(?<= )/)) if (w) send({ content: w });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: r.calls?.length ? 'tool_calls' : 'stop' }], timings: { predicted_n: 9, predicted_per_second: 12 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, asked, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}

const box = (rounds: number, log: string[]): ToolBox => ({
  defs: [{ type: 'function', function: { name: 'web_search', description: 'Search.', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }],
  run: async (name, args) => {
    log.push(`${name} ${args}`);
    return `Results for ${JSON.parse(args).query}: 1. https://example.com/a`;
  },
  onCall: (name, args) => log.push(`calling ${name} ${args}`),
  rounds,
});

test('a tool call streamed in pieces is run, and the model is asked again with the call and its result; its answer is the one kept', async () => {
  const m = await model([{ think: 'I should search.', calls: [{ name: 'web_search', args: ['{"query":', ' "cuda 13"}'] }] }, { text: 'CUDA 13 runs RTX 50 cards natively.' }]);
  const log: string[] = [];
  const shown: string[] = [];
  try {
    const r = await streamChat(m.base, 'qwen3.5-4b', [{ role: 'user', content: 'Which CUDA for an RTX 5080?' }], t => shown.push(t), new AbortController().signal, 512, { tools: box(4, log) });
    assert.equal(r.text, 'CUDA 13 runs RTX 50 cards natively.');
    assert.deepEqual(log, ['calling web_search {"query": "cuda 13"}', 'web_search {"query": "cuda 13"}']);
    assert.equal(m.asked.length, 2);
    assert.equal(m.asked[0].tool_choice, 'auto');
    assert.ok(Array.isArray(m.asked[0].tools));
    const second = m.asked[1].messages as Record<string, unknown>[];
    assert.deepEqual(second.slice(-2), [
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'web_search', arguments: '{"query": "cuda 13"}' } }] },
      { role: 'tool', tool_call_id: 'call_0', content: 'Results for cuda 13: 1. https://example.com/a' },
    ]);
    assert.equal(second[0].role, 'user', 'the chat itself is sent again as it was, before the calls');
    // The working of each round is kept together.
    assert.equal(r.thought, 'I should search.');
    assert.equal(shown.at(-1), 'CUDA 13 runs RTX 50 cards natively.');
  } finally {
    await m.close();
  }
});

test('two calls in one round are both run, in order; with no tools offered, a plain answer is one ask as before', async () => {
  const m = await model([{ calls: [{ name: 'web_search', args: ['{"query":"a"}'] }, { name: 'web_search', args: ['{"query":"b"}'] }] }, { text: 'Both found.' }]);
  const log: string[] = [];
  try {
    const r = await streamChat(m.base, 'qwen3.5-4b', [{ role: 'user', content: 'Look up a and b.' }], () => undefined, new AbortController().signal, 512, { tools: box(4, log) });
    assert.equal(r.text, 'Both found.');
    assert.deepEqual(log.filter(l => !l.startsWith('calling')), ['web_search {"query":"a"}', 'web_search {"query":"b"}']);
    const tail = (m.asked[1].messages as Record<string, unknown>[]).slice(-3).map(x => x.role);
    assert.deepEqual(tail, ['assistant', 'tool', 'tool']);
  } finally {
    await m.close();
  }
  const plain = await model([{ text: 'Hello.' }]);
  try {
    const r = await streamChat(plain.base, 'qwen3.5-4b', [{ role: 'user', content: 'hi' }], () => undefined, new AbortController().signal);
    assert.equal(r.text, 'Hello.');
    assert.equal(plain.asked[0].tools, undefined);
    assert.equal(plain.asked[0].tool_choice, undefined);
  } finally {
    await plain.close();
  }
});

test('the rounds run out: the last ask offers no calls, and a call made anyway is not run', async () => {
  const m = await model([{ calls: [{ name: 'web_search', args: ['{"query":"x"}'] }] }, { calls: [{ name: 'web_search', args: ['{"query":"y"}'] }], text: 'What I found: x.' }]);
  const log: string[] = [];
  try {
    const r = await streamChat(m.base, 'qwen3.5-4b', [{ role: 'user', content: 'search' }], () => undefined, new AbortController().signal, 512, { tools: box(1, log) });
    assert.equal(m.asked.length, 2);
    assert.equal(m.asked[1].tool_choice, 'none');
    assert.deepEqual(log.filter(l => !l.startsWith('calling')), ['web_search {"query":"x"}']);
    assert.equal(r.text, 'What I found: x.');
  } finally {
    await m.close();
  }
});

test('Stop while a tool runs ends the answer there, and nothing more is asked', async () => {
  const m = await model([{ calls: [{ name: 'web_search', args: ['{"query":"x"}'] }] }, { text: 'never' }]);
  const ac = new AbortController();
  try {
    const slow: ToolBox = { ...box(4, []), run: async (_n, _a, signal) => new Promise((_r, reject) => { signal.addEventListener('abort', () => reject(new Error('Stopped.'))); ac.abort(); }) };
    await assert.rejects(streamChat(m.base, 'qwen3.5-4b', [{ role: 'user', content: 'search' }], () => undefined, ac.signal, 512, { tools: slow }));
    assert.equal(m.asked.length, 1);
  } finally {
    await m.close();
  }
});

test('Answer now pressed while it thinks after a search: the answer is asked for with what the search gave, tools off', async () => {
  const m = await model([{ calls: [{ name: 'web_search', args: ['{"query":"cuda 13"}'] }] }, { think: 'The results say CUDA 13 runs RTX 50 cards. I could check more pages, and then more' }, { text: 'CUDA 13 runs RTX 50 cards.' }]);
  const hurry = new AbortController();
  try {
    const r = await streamChat(m.base, 'qwen3.5-4b', [{ role: 'user', content: 'search' }], () => undefined, new AbortController().signal, 2048, { tools: box(4, []), hurry: hurry.signal, onThought: () => hurry.abort() });
    assert.equal(m.asked.length, 3);
    const last = m.asked[2] as { messages: { role: string; content: string }[]; tool_choice?: string };
    assert.ok(last.messages.some(x => x.role === 'tool' && /Results for cuda 13/.test(x.content)), 'the search results are in the last ask');
    assert.equal(last.tool_choice, 'none', 'no more calls are offered');
    assert.match(last.messages.find(x => x.role === 'user')!.content, /Your working so far/);
    assert.equal(r.text, 'CUDA 13 runs RTX 50 cards.');
    assert.equal(r.thoughtStopped, 'hurry');
  } finally {
    await m.close();
  }
});
