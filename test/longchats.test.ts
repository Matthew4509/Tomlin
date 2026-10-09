// Long answers and long chats (PLAN F10 G1): the answer room from the context, the stream's "cut" flag, how full a
// chat is, the handoff a carried-on chat opens with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerRoom, NoPrefill, readings, streamChat, streamedSpeed } from '../src/engine.ts';
import { buildChat } from '../src/memory.ts';
import { Chats } from '../src/chats.ts';
import { Store, type ChatLine } from '../src/store.ts';

const line = (role: 'user' | 'assistant', content: string): ChatLine => ({ role, content, at: '2026-10-05T10:00:00Z' });

test('the answer room is a quarter of the context, 2,048 at the 8K default, up to 16K', () => {
  assert.equal(answerRoom(8192), 2048);
  assert.equal(answerRoom(32768), 8192);
  assert.equal(answerRoom(65536), 16384);
  assert.equal(answerRoom(262144), 16384);
  assert.equal(answerRoom(0), 2048, 'unknown context: the default');
  assert.equal(answerRoom(1024), 512, 'never under 512');
});

test('buildChat reserves the bigger answer room on a big context', () => {
  const c = buildChat({ ctx: 32768, maxAnswer: 16384, card: 'card', team: [], own: null, name: 'Theo', history: [], message: 'hi' });
  assert.equal(c.answerTokens, 8192);
});

test('fill counts the whole chat, even the part that no longer fits', () => {
  const small = buildChat({ ctx: 4096, maxAnswer: 16384, card: 'card', team: [], own: null, name: 'Theo', history: [line('user', 'a'.repeat(100))], message: 'hi' });
  assert.ok(small.fill < 10, `a short chat is nearly empty (${small.fill}%)`);
  const history = Array.from({ length: 40 }, (_, i) => line(i % 2 ? 'assistant' : 'user', `Message ${i}. ${'word '.repeat(80)}`));
  const big = buildChat({ ctx: 4096, maxAnswer: 16384, card: 'card', team: [], own: null, name: 'Theo', history, message: 'hi' });
  assert.ok(big.fill > 100, `a chat bigger than the context is over 100% (${big.fill}%)`);
  assert.ok(big.parts.find(p => p.key === 'summary')?.state === 'cut', 'and its older messages are summarised');
});

test('a carried-on chat reads its handoff, before the recent messages', () => {
  const c = buildChat({ ctx: 8192, maxAnswer: 16384, card: 'card', team: [], own: null, name: 'Theo', history: [line('user', 'next?')], message: 'go', opening: 'We are building a booking page. Done: index.html.' });
  assert.match(c.turns[0].content, /carries on from an earlier one[\s\S]*booking page/);
  assert.equal(c.parts.find(p => p.key === 'opening')?.state, 'whole');
});

test('carryOn makes a new chat with the same person, named after the old one, with the handoff', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-long-'));
  try {
    const chats = new Chats(new Store(dir));
    const old = await chats.create('staff:theo');
    await chats.rename(old.id, 'Booking page');
    const next = await chats.carryOn((await chats.get(old.id))!, 'The handoff.');
    assert.equal(next.who, 'staff:theo');
    assert.equal(next.title, 'Booking page (carried on)');
    assert.equal(next.opening, 'The handoff.');
    assert.equal(next.from, old.id);
    const again = await chats.carryOn(next, 'Second.');
    assert.equal(again.title, 'Booking page (carried on 2)');
    await chats.mark(old.id, { fill: 80, askedLarge: 75 });
    assert.equal((await chats.get(old.id))?.askedLarge, 75);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A stand-in for llama.cpp's server: streams the pieces given, then a final chunk with `finish` and timings. */
async function fakeServer(pieces: string[], finish: string, status = 200, body = '') {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        return void res.end(body);
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const p of pieces) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], timings: { predicted_n: 9, predicted_per_second: 12, prompt_n: 300, prompt_per_second: 150 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(r)) };
}

test('streamChat says when the length limit cut the answer, and reports the reading speed', async () => {
  const seen: Array<[string, number, number]> = [];
  readings.seen = (m, n, ps) => seen.push([m, n, ps]);
  const cut = await fakeServer(['Hello', ' there'], 'length');
  const done = await fakeServer(['Done.'], 'stop');
  try {
    const a = await streamChat(cut.base, 'qwen3.5-2b', [{ role: 'user', content: 'hi' }], () => undefined, new AbortController().signal);
    assert.equal(a.text, 'Hello there');
    assert.equal(a.cut, true);
    const b = await streamChat(done.base, 'qwen3.5-2b', [{ role: 'user', content: 'hi' }], () => undefined, new AbortController().signal);
    assert.equal(b.cut, false);
    assert.deepEqual(seen[0], ['qwen3.5-2b', 300, 150]);
  } finally {
    readings.seen = null;
    await cut.close();
    await done.close();
  }
});

test('an answer whose timings never come still gets a speed, from the streamed pieces and the clock', async () => {
  assert.equal(streamedSpeed(3, 0, 5000), null, 'too few pieces');
  assert.equal(streamedSpeed(40, 1000, 1200), null, 'too short a time');
  assert.deepEqual(streamedSpeed(21, 1000, 3000), { perSecond: 10, tokens: 21 });
  // A stream that ends with no final chunk (cut short there): 12 pieces 60 ms apart, no timings.
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i = 0; i < 12; i++) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `w${i} ` }, finish_reason: null }] })}

`);
        await new Promise(r => setTimeout(r, 60));
      }
      res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const r = await streamChat(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 'm', [{ role: 'user', content: 'hi' }], () => undefined, new AbortController().signal);
    assert.equal(r.tokens, 12);
    assert.ok(r.perSecond > 5 && r.perSecond < 25, String(r.perSecond));
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('a server that cannot prefill a cut answer says so as NoPrefill (the chat then asks the model to go on)', async () => {
  const s = await fakeServer([], 'stop', 400, '{"error":{"message":"Assistant response prefill is incompatible with enable_thinking."}}');
  try {
    await assert.rejects(streamChat(s.base, 'm', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Half an ans' }], () => undefined, new AbortController().signal), NoPrefill);
    await assert.rejects(streamChat(s.base, 'm', [{ role: 'user', content: 'hi' }], () => undefined, new AbortController().signal), e => !(e instanceof NoPrefill));
  } finally {
    await s.close();
  }
});
