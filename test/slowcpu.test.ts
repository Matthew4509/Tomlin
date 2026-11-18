// A slow CPU: llama-server sends nothing while it reads a long prompt, and Node's fetch gave up on a stream quiet for
// 300 s (measured: "terminated", UND_ERR_BODY_TIMEOUT after 306 s), so a long prompt on a slow PC failed. Every runner
// request now asks for progress lines (they keep the stream moving), and goes through runnerFetch (no time limit).
// The 300 s itself is too long for the suite: checked by hand (a made-up runner quiet for 310 s: plain fetch was cut
// at 306 s, runnerFetch read it whole at 310 s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { runnerFetch, streamChat } from '../src/engine.ts';

/** A made-up llama-server: records each request's body, answers "OK" in two pieces after `quietMs` of nothing. */
async function fakeRunner(quietMs = 0): Promise<{ base: string; bodies: Record<string, unknown>[]; server: Server }> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', d => (raw += d));
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"O"}}]}\n\n');
        res.end('data: {"choices":[{"delta":{"content":"K"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      }, quietMs);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, bodies, server };
}

test('every runner request asks for progress lines, not only the chat that shows them (a job, a fold, a blog post)', async () => {
  const f = await fakeRunner();
  try {
    const r = await streamChat(f.base, 'qwen3', [{ role: 'user', content: 'Say OK.' }], () => undefined, new AbortController().signal, 8);
    assert.equal(r.text, 'OK');
    assert.equal(f.bodies[0].return_progress, true);
  } finally {
    f.server.close();
  }
});

test('runnerFetch reads a stream that is quiet for a while, and Stop still ends it', async () => {
  const f = await fakeRunner(1500);
  try {
    const res = await runnerFetch(`${f.base}/v1/chat/completions`, { method: 'POST', body: '{}' });
    assert.match(await res.text(), /\[DONE\]/);
    const ac = new AbortController();
    const quiet = await runnerFetch(`${f.base}/v1/chat/completions`, { method: 'POST', body: '{}', signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(quiet.text(), /abort/i);
  } finally {
    f.server.closeAllConnections();
    f.server.close();
  }
});

/** A made-up runner that writes "ab", then goes quiet for good (a hung runner); a slow start before the first piece is `slowStart`. */
async function hungRunner(slowStart = 0): Promise<{ base: string; server: Server }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"b"}}]}\n\n');
      }, slowStart);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

test('an answer that has begun and then goes quiet is ended and offered Continue, with the quiet said (F2)', async () => {
  const f = await hungRunner();
  try {
    const seen: string[] = [];
    const r = await streamChat(f.base, 'qwen3', [{ role: 'user', content: 'Go.' }], t => seen.push(t), new AbortController().signal, 64, { stallMs: 400 });
    assert.equal(r.text, 'ab', 'what was written is kept');
    assert.equal(r.cut, true, 'Continue is offered');
    assert.ok((r.stalled ?? 0) >= 1, 'the quiet is reported');
    assert.ok('stalled' in r);
  } finally {
    f.server.closeAllConnections();
    f.server.close();
  }
});

test('a slow start is not a stall, and the wait before the first word and the longest quiet are reported (F3, F10)', async () => {
  const f = await fakeRunner(1200);
  try {
    const r = await streamChat(f.base, 'qwen3', [{ role: 'user', content: 'Go.' }], () => undefined, new AbortController().signal, 8, { stallMs: 400 });
    assert.equal(r.text, 'OK');
    assert.equal(r.stalled, undefined, 'nothing had been written yet, so the wait was not a stall');
    assert.ok((r.firstWord ?? 0) >= 1, `first word after ${r.firstWord} s`);
  } finally {
    f.server.closeAllConnections();
    f.server.close();
  }
});

test('the PC clock put forward an hour while an answer streams is not taken for a stalled runner', async () => {
  // A made-up runner that writes a piece, thinks for a second (under the 2 s allowed), then writes the rest.
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
      setTimeout(() => {
        for (let n = 0; n < 14; n++) res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
        res.end('data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      }, 1000);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const realNow = Date.now;
  try {
    let moved = false;
    const r = await streamChat(base, 'qwen3', [{ role: 'user', content: 'Go.' }], () => {
      // Windows sets the clock right just after the first piece: an hour forward.
      if (!moved) {
        moved = true;
        Date.now = () => realNow() + 3_600_000;
      }
    }, new AbortController().signal, 64, { stallMs: 2000 });
    assert.equal(r.stalled, undefined, 'not cut as a stall');
    assert.equal(r.text, 'xxxxxxxxxxxxxxx!');
  } finally {
    Date.now = realNow;
    server.closeAllConnections();
    server.close();
  }
});
