// Quick or Think (2.0.31): which models can think, how they are asked, and the working kept apart from the answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatStyle, everyFew, finalStyle, plainStyle, streamChat, thinkingLoops, thinkingText, thinkRoomFit, thinkRoomOf, THINK_ROOM, THINK_SIZES, thinksOf, withWorking } from '../src/engine.ts';
import { readFileSync } from 'node:fs';

test('the working has a default room and bigger sizes to expand to; anything else is the default', () => {
  assert.equal(THINK_SIZES[0], THINK_ROOM);
  assert.ok(THINK_ROOM > 4096, 'raised from the first default (4096), which a hybrid model\'s working could fill on a short question');
  assert.deepEqual([...THINK_SIZES].sort((a, b) => a - b), [...THINK_SIZES]);
  assert.equal(thinkRoomOf(undefined), THINK_ROOM);
  assert.equal(thinkRoomOf(123), THINK_ROOM);
  assert.equal(thinkRoomOf(THINK_SIZES[2]), THINK_SIZES[2]);
});


test('the working is never given more room than the context leaves', () => {
  // A 16k context with a short prompt: the whole default room fits.
  assert.deepEqual(thinkRoomFit(THINK_ROOM, 16384, 3000, 4096), { room: THINK_ROOM, free: 16384 - 1000 - 4096 });
  // An 8k context: even a short prompt leaves less than the default 6k, so the working is cut to what is left.
  assert.deepEqual(thinkRoomFit(THINK_ROOM, 8192, 3000, 2048), { room: 8192 - 1000 - 2048, free: 8192 - 1000 - 2048 });
  // A long chat at 8k: the prompt fills most of it, so the working gets what is left (never under 512), not the default.
  const long = thinkRoomFit(THINK_ROOM, 8192, 12000, 2048);
  assert.equal(long.free, 8192 - 4000 - 2048);
  assert.equal(long.room, long.free);
  assert.ok(long.room < THINK_ROOM);
  // Prompt plus answer already past the context: the floor, and nothing bigger is offered (free is 0).
  assert.deepEqual(thinkRoomFit(THINK_ROOM, 8192, 30000, 2048), { room: 512, free: 0 });
  // A big context: asking for a bigger size is honoured up to what fits.
  assert.equal(thinkRoomFit(THINK_SIZES[3], 65536, 20000, 4096).room, THINK_SIZES[3]);
  assert.ok(THINK_SIZES.filter(s => s > THINK_ROOM && s <= long.free).length === 0, 'no bigger size is offered when it would not fit');
});

test('a working that fills its room offers the bigger sizes on a card; Web off offers its own card', () => {
  const root = join(import.meta.dirname, '..');
  const chat = readFileSync(join(root, 'src/server/chat.ts'), 'utf8');
  const view = readFileSync(join(root, 'public/chatview.js'), 'utf8');
  assert.match(chat, /THINK_SIZES\.filter\(s => s > thinkAsked && s <= ctxFree\)/);
  assert.match(chat, /bigger\.length && !away \? \{ room:/);
  assert.match(chat, /room: \{ now: thinkRoom, sizes: bigger \}/);
  assert.match(chat, /send\('weboff', \{ text: webOffWords\(message\) \}\)/);
  assert.match(chat, /thinkRoomOf\(b\.room\)/);
  assert.match(view, /data\.room\?\.sizes\?\.length/);
  assert.match(view, /ev === 'weboff'/);
  assert.match(view, /Turn Web on and ask again/);
});
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
  // GLM 4.5 and later think by default and can be switched off; GLM-4 and 4.1 do not think.
  assert.equal(thinksOf('GLM-4.7-Flash-UD-Q4_K_XL.gguf'), 'switch');
  assert.equal(thinksOf('GLM-4.5-Air-Q4_K_M.gguf'), 'switch');
  // GLM 5 and later have no off switch (only reasoning_effort): always, low on Quick, high on Think, low for the final ask.
  assert.equal(thinksOf('GLM-5.3-Flash-Q2_K.gguf'), 'always');
  assert.equal(thinksOf('GLM-5.3-UD-IQ2_M-00001-of-00006.gguf'), 'always');
  assert.deepEqual(chatStyle('GLM-5.3-UD-IQ2_M.gguf').sampling.chat_template_kwargs, { enable_thinking: false, reasoning_effort: 'low' });
  assert.deepEqual(chatStyle('GLM-5.3-UD-IQ2_M.gguf', true).sampling.chat_template_kwargs, { enable_thinking: true, reasoning_effort: 'high' });
  assert.deepEqual(finalStyle('GLM-5.3-UD-IQ2_M.gguf', chatStyle('GLM-5.3-UD-IQ2_M.gguf', true)).sampling.chat_template_kwargs, { enable_thinking: true, reasoning_effort: 'low' });
  // DeepSeek V3.1 and later switch with enable_thinking (and thinking); R1 and V3 are unchanged.
  assert.equal(thinksOf('DeepSeek-V4-Flash-0731-UD-Q4_K_XL-00001-of-00005.gguf'), 'switch');
  assert.equal(thinksOf('DeepSeek-V3.1-Terminus-Q2_K.gguf'), 'switch');
  assert.equal(thinksOf('DeepSeek-V3-0324-Q2_K.gguf'), 'never');
  assert.deepEqual(chatStyle('DeepSeek-V4-Flash-0731-UD-Q2_K_XL.gguf').sampling.chat_template_kwargs, { enable_thinking: false, thinking: false });
  assert.deepEqual(chatStyle('remote:abc:DeepSeek-V4-Flash-0731-UD-Q2_K_XL.gguf', true).sampling.chat_template_kwargs, { enable_thinking: true, thinking: true });
  assert.equal(thinksOf('GLM-4-9B-0414-Q4_K_M.gguf'), 'never');
  assert.equal(thinksOf('GLM-4.1V-9B-Q4_K_M.gguf'), 'never');
  assert.equal(thinksOf('glm-4-5-air-Q4_K_M.gguf'), 'switch', 'a dashed version number');
  for (const other of ['xglm-5.8B-Q4_K_M.gguf', 'chatglm-6.2b-Q4_K_M.gguf', 'ChatGLM3-6B-Q4_K_M.gguf', 'GLM-4.10-Q4_K_M.gguf']) assert.equal(thinksOf(other), 'never', other);
  assert.deepEqual(chatStyle('GLM-4.7-Flash-UD-Q4_K_XL.gguf').sampling.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(chatStyle('GLM-4.7-Flash-UD-Q4_K_XL.gguf', true).sampling.chat_template_kwargs, { enable_thinking: true });
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
    const r = await streamChat(s.base, 'Qwen3.5-2B.gguf', [{ role: 'user', content: '12 pens?' }], () => undefined, new AbortController().signal, 10_000, { think: true });
    assert.equal(r.text, '8 euros.');
    assert.equal(r.thoughtStopped, 'loop');
    assert.match(r.thought, /looking at the first turn again/);
    assert.equal(seen.length, 2, 'asked once thinking, once straight away');
    assert.deepEqual(seen[1].chat_template_kwargs, { enable_thinking: false });
    assert.equal(seen[1].max_tokens, 10_000 - THINK_ROOM, 'without the thinking room');
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
    assert.ok(r.thought.length > THINK_ROOM * 3 && r.thought.length < THINK_ROOM * 3 + 1000, `stopped just past the room (${r.thought.length} characters)`);
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
