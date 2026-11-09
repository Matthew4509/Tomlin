// tools/speedrun.ts (a sustained speed run, 9 Nov 2026) against a fake OpenAI-style server: it finds the model, keeps
// asking for answers for the set time, throws the first one away as a warm-up, and reports by minute and overall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('speedrun counts answers after a warm-up and reports a speed by minute and overall', { timeout: 60_000 }, async () => {
  let asked = 0;
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
    if (req.url === '/v1/chat/completions') {
      asked++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const timer = setInterval(() => {
        if (n++ < 20) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'word ' } }] })}\n\n`);
        else {
          clearInterval(timer);
          res.write(`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
          res.end();
        }
      }, 20);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), 'speedrun-'));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [join(ROOT, 'tools', 'speedrun.ts'), '--url', `http://127.0.0.1:${port}`, '--seconds', '10'], { cwd: dir, encoding: 'utf8' });
    assert.match(stdout, /Model: fake-model/);
    assert.match(stdout, /warm-up, not counted/);
    assert.match(stdout, /minute 1: \d+ answers, median [\d.]+ tok\/s/);
    const overall = /Overall: (\d+) answers, (\d+) tokens, median ([\d.]+) tok\/s/.exec(stdout);
    assert.ok(overall, stdout);
    assert.ok(Number(overall[1]) >= 5, 'many short answers in 10 seconds');
    assert.equal(Number(overall[2]), Number(overall[1]) * 20, 'twenty tokens each');
    // 19 intervals of about 20 ms: roughly 50 tok/s, far from 0 and from a wild figure
    assert.ok(Number(overall[3]) > 10 && Number(overall[3]) < 120, overall[3]);
    assert.equal(readdirSync(dir).filter(f => /^speedrun-.*\.jsonl$/.test(f)).length, 1);
    assert.equal(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8').trim().split('\n').length, asked);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('speedrun says what to do when nothing is loaded', async () => {
  const server = createServer((_req, res) => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [] })));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(promisify(execFile)(process.execPath, [join(ROOT, 'tools', 'speedrun.ts'), '--url', `http://127.0.0.1:${port}`, '--seconds', '10'], { encoding: 'utf8' }), (e: { stderr?: string }) => /Load one in TOMLIN first/.test(e.stderr ?? ''));
  } finally {
    server.close();
  }
});
