// Quick or Think (2.0.31): which models can think, how they are asked, and the working kept apart from the answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatStyle, everyFew, plainStyle, streamChat, thinkingLoops, thinkingText, thinksOf, withWorking } from '../src/engine.ts';
import { Chats } from '../src/chats.ts';
import { Store } from '../src/store.ts';

test('which models think: Qwen 3 and 3.5 when asked, reasoning models always, the rest never', () => {
  assert.equal(thinksOf('Qwen3.5-2B-Q4_K_M.gguf'), 'switch');
  assert.equal(thinksOf('Qwen3-8B-Q4_K_M.gguf'), 'switch');
  assert.equal(thinksOf('Qwen3.5 9B on "Worker PC" remote:0a1b2c3d:Qwen3.5-9B-Q4_K_M.gguf'), 'switch');
  assert.equal(thinksOf('Qwen3-4B-Instruct-2507-Q4_K_M.gguf'), 'never');
  assert.equal(thinksOf('Qwen3-4B-Thinking-2507-Q4_K_M.gguf'), 'always');
  assert.equal(thinksOf('DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf'), 'always');
  assert.equal(thinksOf('QwQ-32B-Q4_K_M.gguf'), 'always');
  assert.equal(thinksOf('gemma-2-2b-it-Q4_K_M.gguf'), 'never');
  assert.equal(thinksOf('Huihui-Ministral-3B-Abliterated-Q4_K_M.gguf'), 'never');
});

test('Think asks a Qwen model to think, with its thinking sampling; Quick and other models are as before', () => {
  const quick = chatStyle('Qwen3.5-2B-Q4_K_M.gguf');
  assert.deepEqual(quick.sampling.chat_template_kwargs, { enable_thinking: false });
  assert.equal(quick.sampling.temperature, 0.7);
  const think = chatStyle('Qwen3.5-2B-Q4_K_M.gguf', true);
  assert.deepEqual(think.sampling.chat_template_kwargs, { enable_thinking: true });
  assert.equal(think.sampling.temperature, 0.6);
  assert.equal(think.sampling.top_k, 20);
  assert.deepEqual(chatStyle('gemma-2-2b-it.gguf', true), chatStyle('gemma-2-2b-it.gguf'), 'a model that cannot think is asked as before');
  // A Default hire keeps the model's own sampling either way; only the thinking switch changes.
  assert.deepEqual(plainStyle('Qwen3.5-2B.gguf').sampling, { chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(plainStyle('Qwen3.5-2B.gguf', true).sampling, { chat_template_kwargs: { enable_thinking: true } });
});

test('the working inside <think> tags is found, finished or not', () => {
  assert.equal(thinkingText('<think>Add 2 and 2.</think>It is 4.'), 'Add 2 and 2.');
  assert.equal(thinkingText('<think>Still working'), 'Still working');
  assert.equal(thinkingText('No working here.'), '');
});

/** A stand-in for llama.cpp's server that sends the working apart (reasoning_content), then the answer. */
async function thinkingServer(seen: unknown[]) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const r of ['Two and two ', 'make four.']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: r }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'It is 4.' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: { predicted_n: 12, predicted_per_second: 10 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise(r => server.close(r)) };
}

test('streamChat keeps the working out of the answer and hands it on as it grows', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const s = await thinkingServer(seen);
  try {
    const shown: string[] = [];
    const thoughts: string[] = [];
    const r = await streamChat(s.base, 'Qwen3.5-2B.gguf', [{ role: 'user', content: '2+2?' }], t => shown.push(t), new AbortController().signal, 100, { think: true, onThought: t => thoughts.push(t) });
    assert.equal(r.text, 'It is 4.');
    assert.equal(r.thought, 'Two and two make four.');
    assert.ok(r.thoughtSeconds >= 0);
    assert.deepEqual(shown, ['It is 4.'], 'the working never shows as the answer');
    assert.equal(thoughts.at(-1), 'Two and two make four.');
    assert.deepEqual(seen[0].chat_template_kwargs, { enable_thinking: true });
    // Quick: the same model is asked not to think.
    await streamChat(s.base, 'Qwen3.5-2B.gguf', [{ role: 'user', content: '2+2?' }], () => undefined, new AbortController().signal, 100);
    assert.deepEqual(seen[1].chat_template_kwargs, { enable_thinking: false });
  } finally {
    await s.close();
  }
});

test('everyFew passes on the first call, then at most once in the time given', () => {
  const got: number[] = [];
  const f = everyFew(60_000, (n: number) => got.push(n));
  f(1);
  f(2);
  f(3);
  assert.deepEqual(got, [1]);
});

test('a chat keeps Quick or Think', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-think-'));
  try {
    const chats = new Chats(new Store(dir));
    const c = await chats.create('staff:theo');
    assert.equal((await chats.get(c.id))?.think, undefined, 'a new chat starts on Quick');
    await chats.mark(c.id, { think: true });
    assert.equal((await chats.get(c.id))?.think, true);
    assert.equal((await new Chats(new Store(dir)).get(c.id))?.think, true, 'kept on disk');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A model that thinks in a loop the first time (the same paragraph again and again), and answers when asked not to think. */
async function loopingServer(seen: Array<Record<string, unknown>>) {
  const para = 'Wait, looking at the first turn again, the user asked for one sentence, so I should check that once more.';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const b = JSON.parse(body) as Record<string, unknown>;
      seen.push(b);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Thinks unless asked not to (a reasoning model is never asked either way).
      const thinking = (b.chat_template_kwargs as { enable_thinking?: boolean } | undefined)?.enable_thinking !== false;
      if (thinking) {
        // Written slowly enough for the client to stop it part-way.
        let n = 0;
        const t = setInterval(() => {
          if (res.destroyed || n++ > 40) {
            clearInterval(t);
            res.end();
            return;
          }
          const piece = { choices: [{ delta: { reasoning_content: para + '\n\n' }, finish_reason: null }] };
          res.write('data: ' + JSON.stringify(piece) + '\n\n');
        }, 5);
        res.on('close', () => clearInterval(t));
        return;
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '8 euros.' }, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise(r => server.close(r)) };
}

test('working that goes round in circles is stopped, and the answer is asked for straight away', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const s = await loopingServer(seen);
  try {
    const r = await streamChat(s.base, 'Qwen3.5-2B.gguf', [{ role: 'user', content: '12 pens?' }], () => undefined, new AbortController().signal, 6000, { think: true });
    assert.equal(r.text, '8 euros.');
    assert.equal(r.thoughtStopped, 'loop');
    assert.match(r.thought, /looking at the first turn again/);
    assert.equal(seen.length, 2, 'asked once thinking, once straight away');
    assert.deepEqual(seen[1].chat_template_kwargs, { enable_thinking: false });
    assert.equal(seen[1].max_tokens, 6000 - 4096, 'without the thinking room');
    const asked = (seen[1].messages as Array<{ role: string; content: string }>).at(-1)!.content;
    assert.match(asked, /^12 pens\?[\s\S]*Your working so far[\s\S]*looking at the first turn again[\s\S]*Now write only the answer\.$/, 'the working goes with the question');
    // A model that always thinks cannot be asked not to: it ends with no answer, and says the working looped.
    const always = await streamChat(s.base, 'DeepSeek-R1-Distill-Qwen-7B.gguf', [{ role: 'user', content: '12 pens?' }], () => undefined, new AbortController().signal, 6000, { think: true });
    assert.equal(always.thoughtStopped, 'loop');
    assert.equal(always.text, '');
    assert.equal(seen.length, 3, 'not asked again');
  } finally {
    await s.close();
  }
});

/** A model that thinks without repeating itself (a new line each time) for as long as it is let, then answers when asked not to think. */
async function longServer(seen: Array<Record<string, unknown>>, line = (n: number) => `Step ${n}: ${'checking one more different detail of the sum '.slice(0, 20 + (n % 25))}.`) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const b = JSON.parse(body) as Record<string, unknown>;
      seen.push(b);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if ((b.chat_template_kwargs as { enable_thinking?: boolean } | undefined)?.enable_thinking !== false) {
        let n = 0;
        const t = setInterval(() => {
          if (res.destroyed || n > 5000) {
            clearInterval(t);
            res.end();
            return;
          }
          n += 1;
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: line(n) + '\n' }, finish_reason: null }] }) + '\n\n');
        }, 1);
        res.on('close', () => clearInterval(t));
        return;
      }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '8 euros.' }, finish_reason: 'stop' }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise(r => server.close(r)) };
}

test('working past its room is stopped, and the answer asked for with it', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const s = await longServer(seen);
  try {
    const r = await streamChat(s.base, 'Qwen3.5-2B.gguf', [{ role: 'user', content: '12 pens?' }], () => undefined, new AbortController().signal, 6000, { think: true });
    assert.equal(r.thoughtStopped, 'long');
    assert.equal(r.text, '8 euros.');
    assert.ok(r.thought.length > 12_000 && r.thought.length < 13_000, `stopped just past the room (${r.thought.length} characters)`);
  } finally {
    await s.close();
  }
});

test('Answer now stops the working and asks for the answer with it', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const s = await longServer(seen, n => `Line ${n} of working, all different.`);
  try {
    const hurry = new AbortController();
    const r = await streamChat(s.base, 'Qwen3.5-2B.gguf', [{ role: 'user', content: '12 pens?' }], () => undefined, new AbortController().signal, 6000, { think: true, hurry: hurry.signal, onThought: t => { if (t.length > 300) hurry.abort(); } });
    assert.equal(r.thoughtStopped, 'hurry');
    assert.equal(r.text, '8 euros.');
    assert.ok(r.thought.length < 2000, 'stopped when pressed, not at the end of its room');
    assert.match((seen[1].messages as Array<{ content: string }>).at(-1)!.content, /Your working so far[\s\S]*Line 1 of working/);
  } finally {
    await s.close();
  }
});

test('a line of working written a third time is a loop; varied working is not', () => {
  const l = '    *   Wait, looking at the first turn, the user asked for one sentence only.';
  assert.equal(thinkingLoops(['Start.', l, 'Other.', l, 'More.', l].join('\n')), true);
  assert.equal(thinkingLoops(['Start.', l, 'Other.', l].join('\n')), false);
  assert.equal(thinkingLoops(Array.from({ length: 50 }, (_, i) => `Step ${i}: a different thought about the sum.`).join('\n')), false);
});

test('the working goes with the last message only, and a long one is cut to its end', () => {
  const turns = [{ role: 'system' as const, content: 'S' }, { role: 'user' as const, content: 'Q1' }, { role: 'assistant' as const, content: 'A1' }, { role: 'user' as const, content: 'Q2' }];
  const w = withWorking(turns, 'x'.repeat(5000) + 'END');
  assert.equal(w[1].content, 'Q1');
  assert.match(w[3].content, /^Q2\n\nYour working so far \(use it; do not repeat it\):\n…x+END\n\nNow write only the answer\.$/);
  assert.ok(w[3].content.length < 3200);
  assert.deepEqual(withWorking(turns, '  '), turns);
});
