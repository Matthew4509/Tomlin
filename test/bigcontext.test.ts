// Big contexts (up to 262,144) for big coding chats: the start of each turn's prompt stays the same as the chat grows
// (llama.cpp then reads only what is new: a full re-read of a 250K chat is an hour or more on a laptop), documents go
// in whole when they fit (code read in parts is not code), and a long message is not refused at 20,000 characters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildChat, chatRoom, keptFrom, MESSAGE_MAX } from '../src/memory.ts';
import { ANSWER_CEILING, cleanReading, ContextFull, contextFull, streamChat, type Reading } from '../src/engine.ts';
import { docSection, findParts, textParts, wholeSection, wholeText, type Doc } from '../src/docs.ts';
import type { ChatLine } from '../src/store.ts';

const line = (role: 'user' | 'assistant', content: string): ChatLine => ({ role, content, at: '2026-10-10T10:00:00Z' });

/** A made-up coding chat: messages of mixed sizes, the same every run. */
function chat(n: number): ChatLine[] {
  let seed = 7;
  const next = () => (seed = (seed * 48271) % 2147483647);
  return Array.from({ length: n }, (_, i) => line(i % 2 ? 'assistant' : 'user', `message ${i}: ${'function step() { return 1; }\n'.repeat(10 + (next() % 120))}`));
}

/** The part of a turn's prompt that comes before the newest messages: the system message and the first message kept. */
const front = (turns: { role: string; content: string }[]) => JSON.stringify(turns.slice(0, 2));

test('keptFrom: everything when it fits; never more than the room; the start moves in steps, not every turn', () => {
  assert.equal(keptFrom([10, 10, 10], 100), 0);
  assert.equal(keptFrom([], 100), 0);
  const sizes: number[] = [];
  let moves = 0;
  let last = 0;
  for (let i = 0; i < 400; i++) {
    sizes.push(20 + ((i * 37) % 60));
    const at = keptFrom(sizes, 900);
    assert.ok(sizes.slice(at).reduce((t, s) => t + s, 0) <= 900, `turn ${i}: what is kept fits`);
    assert.ok(at >= last, 'the start never goes back');
    if (at !== last) moves++;
    last = at;
  }
  // 400 messages of about 50 characters into a room of 900 (about 18 messages): one message a turn would be ~380 moves.
  assert.ok(moves < 400 / 4, `the start moved ${moves} times`);
  // The real run's turns (a 2,884-character message and a short answer) in a 250K context's room (about 700,000
  // characters): once past full, the start moves about once every third of the room said, dozens of turns apart. (At
  // 16K the same turns are a sixth of the room each, and it moved every turn or two there: a small context churns.)
  const run: number[] = [22_600, 2_000];
  let moved = 0;
  let past = 0;
  let start = 0;
  for (let t = 0; t < 1200; t++) {
    run.push(2_884, 4);
    const at = keptFrom(run, 700_000);
    if (at) past++;
    if (at !== start) moved++;
    start = at;
  }
  assert.ok(past > 900, `${past} turns past full`);
  assert.ok(moved <= Math.ceil((past * 2_888) / (700_000 / 3)) + 2, `moved ${moved} times in ${past} turns past full`);
  // One very long message: the step is skipped rather than leaving it and more out.
  const big = [100, 100, 100, 850, 10, 10];
  const from = keptFrom(big, 900);
  assert.ok(big.slice(from).reduce((t, s) => t + s, 0) <= 900);
  assert.equal(from, 3, 'keeps the long message, as the old way did');
});

test('a growing chat at 32K: the start of the prompt stays the same for most turns once the chat is past full', () => {
  const ctx = 32768;
  const all = chat(260);
  let changed = 0;
  let overflowTurns = 0;
  let prev = '';
  for (let i = 40; i < all.length; i += 2) {
    const c = buildChat({ ctx, maxAnswer: ANSWER_CEILING, card: 'You are Theo, a developer.', rules: 'RULE', team: [], own: [], name: 'Theo', history: all.slice(0, i), message: `next step ${i}` });
    assert.ok(c.used <= c.room, `turn ${i}: ${c.used} of ${c.room}`);
    if (c.fill <= 100) continue;
    overflowTurns++;
    const f = front(c.turns);
    if (prev && f !== prev) changed++;
    prev = f;
  }
  assert.ok(overflowTurns > 40, `${overflowTurns} turns past full`);
  // The old way changed the start every turn past full (one message off the top): now about one turn in four or fewer.
  assert.ok(changed <= overflowTurns / 4, `the start changed on ${changed} of ${overflowTurns} turns`);
});

test('at 262,144 a big coding chat fits whole, with the answer room kept', () => {
  const c = buildChat({ ctx: 262144, maxAnswer: ANSWER_CEILING, card: 'card', team: [], own: null, name: 'Theo', history: chat(200), message: 'go on' });
  assert.equal(c.answerTokens, ANSWER_CEILING);
  assert.ok(c.fill < 100, `fill ${c.fill}`);
  assert.equal(c.turns.length, 1 + 200 + 1, 'the card, every message, the new one');
});

/** A made-up code file: indented, with blank lines, long enough to split into many parts. */
const code = Array.from({ length: 300 }, (_, i) => (i % 12 === 0 ? `\ndef step_${i}(x):\n    if x > ${i}:\n        return x - ${i}\n    return x` : `    # line ${i} of the made-up file`)).join('\n');
const doc = (name: string, text: string): Doc => ({ id: 'abc', name, kind: 'text', pages: text.split('\n').length, chars: text.length, at: '', parts: textParts(text) });

test('a code file is put back whole, line for line, with its indents', () => {
  const d = doc('steps.py', code);
  assert.ok(d.parts.length > 5, 'split into parts');
  assert.equal(wholeText(d), code.trim(), 'the same text');
  // The parts keep the indent of their first line (they used to be trimmed: Python read whole needs it).
  assert.ok(d.parts.some(p => /^ {4}\S/.test(p.text)), 'a part starts indented');
});

test('documents go in whole when they fit, the same every turn; the matching parts when they do not', () => {
  const d = doc('steps.py', code);
  const room = 200_000;
  const whole = wholeSection([d], room)!;
  assert.ok(whole.includes(code.trim()));
  assert.equal(wholeSection([d], 1000), null, 'too big for the room: no whole section');
  const turn = (message: string) => buildChat({ ctx: 65536, maxAnswer: ANSWER_CEILING, card: 'card', team: [], own: null, name: 'Theo', history: [line('user', 'hi'), line('assistant', 'hello')], message, docs: docSection(findParts([d], message, 20_000)), docsWhole: whole });
  const a = turn('what does step_24 do?');
  const b = turn('rename step_36 to finish');
  assert.equal(a.docsWhole, true);
  assert.equal(a.turns[0].content, b.turns[0].content, 'the same system message for two different questions');
  assert.equal(a.parts.find(p => p.key === 'docs')?.label, 'Documents in this chat (whole)');
  // At 8K the file is too big for the documents' room: the parts that match are sent with the card, as before. They
  // stay there, not with the new message: the chat on disk keeps the message without them, so the turn after would
  // differ from that message on, and Qwen 3.5 (hybrid) read everything again every turn (measured in the real run).
  const small = (message: string) => buildChat({ ctx: 8192, maxAnswer: ANSWER_CEILING, card: 'card', team: [], own: null, name: 'Theo', history: [line('user', 'hi'), line('assistant', 'hello')], message, docs: docSection(findParts([d], message, 3000)), docsWhole: whole });
  const s1 = small('what does step_24 do?');
  assert.equal(s1.docsWhole, false);
  assert.match(s1.turns[0].content, /match the message[\s\S]*step_24/);
  assert.equal(s1.turns.at(-1)!.content, 'what does step_24 do?', 'the new message as it is kept');
  assert.ok(s1.used <= s1.room);
});

test('a long message: the cap is far above 20,000, and a 250K context reads a 400,000-character paste', () => {
  assert.ok(MESSAGE_MAX >= 1_000_000);
  assert.ok(chatRoom(262144, ANSWER_CEILING) * 0.9 > 400_000);
  const c = buildChat({ ctx: 262144, maxAnswer: ANSWER_CEILING, card: 'card', team: [], own: null, name: 'Theo', history: [], message: 'x'.repeat(400_000) });
  assert.equal(c.turns.at(-1)?.content.length, 400_000);
});

/** A made-up llama.cpp server: progress lines as b11284 sends them (with return_progress), a keep-alive, then the answer. */
async function progressServer() {
  const asked: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const b = JSON.parse(body) as Record<string, unknown>;
      asked.push(b);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const empty = { choices: [{ finish_reason: null, index: 0, delta: { role: 'assistant', content: null } }] };
      if (b.return_progress) {
        for (const done of [0, 2048, 4096]) res.write(`data: ${JSON.stringify({ ...empty, prompt_progress: { total: 5000, cache: 1000, processed: 1000 + done, time_ms: done * 10 } })}\n\n`);
      }
      res.write(': keep-alive\n\n');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: { predicted_n: 1, predicted_per_second: 5, prompt_n: 4000, prompt_per_second: 100 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, asked, close: () => new Promise(r => server.close(r)) };
}

test('reading progress: asked for when someone shows it, passed on cleaned, and the answer still comes', async () => {
  const s = await progressServer();
  try {
    const seen: Reading[] = [];
    const r = await streamChat(s.base, 'Qwen3.5-0.8B-Q4_K_M.gguf', [{ role: 'user', content: 'hi' }], () => undefined, new AbortController().signal, 64, { onReading: x => seen.push(x) });
    assert.equal(r.text, 'OK');
    assert.equal(s.asked[0].return_progress, true);
    assert.deepEqual(seen.map(x => x.done), [1000, 3048, 5000]);
    assert.deepEqual(seen[0], { total: 5000, cached: 1000, done: 1000, ms: 0 });
    // Nobody shows it (a job step, a title): not asked for.
    await streamChat(s.base, 'Qwen3.5-0.8B-Q4_K_M.gguf', [{ role: 'user', content: 'hi' }], () => undefined, new AbortController().signal, 64);
    assert.equal(s.asked[1].return_progress, undefined);
  } finally {
    await s.close();
  }
});

test('cleanReading: a linked PC\'s line or llama.cpp\'s own names; nonsense is dropped', () => {
  assert.deepEqual(cleanReading({ total: 10, cache: 2, processed: 5, time_ms: 7 }), { total: 10, cached: 2, done: 5, ms: 7 });
  assert.deepEqual(cleanReading({ total: 10, cached: 20, done: 50, ms: 1 }), { total: 10, cached: 10, done: 10, ms: 1 });
  assert.equal(cleanReading({ total: 0, cached: 0, done: 0, ms: 0 }), null);
  assert.equal(cleanReading({ total: 'x' }), null);
  assert.equal(cleanReading(null), null);
});

test('a chat over the context: llama.cpp\'s refusal becomes ContextFull with its count, and a squeezed build is smaller', async () => {
  const said = JSON.stringify({ error: { code: 400, message: 'request (34222 tokens) exceeds the available context size (32768 tokens), try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: 34222, n_ctx: 32768 } });
  const full = contextFull(said);
  assert.ok(full instanceof ContextFull);
  assert.equal(full.tokens, 34222);
  assert.equal(full.ctx, 32768);
  assert.equal(contextFull('{"error":{"type":"other"}}'), null);
  assert.equal(contextFull('not json'), null);
  // Through the stream client: thrown as ContextFull, not "The model server answered 400: {...}".
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(said);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(streamChat(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 'm.gguf', [{ role: 'user', content: 'hi' }], () => undefined, new AbortController().signal, 64), (e: unknown) => e instanceof ContextFull && e.tokens === 34222);
  } finally {
    await new Promise(r => server.close(r));
  }
  // Built again with the share llama.cpp's count allows: the room and what is sent shrink by it.
  const history = chat(120);
  const one = buildChat({ ctx: 32768, maxAnswer: ANSWER_CEILING, card: 'card', team: [], own: null, name: 'Theo', history, message: 'go' });
  const less = buildChat({ ctx: 32768, maxAnswer: ANSWER_CEILING, card: 'card', team: [], own: null, name: 'Theo', history, message: 'go', squeeze: 0.7 });
  assert.equal(less.room, Math.floor(one.room * 0.7));
  assert.ok(less.used <= less.room && less.used < one.used);
});
