// Bad requests to the server, started on an empty home: a body that is not JSON or is too large, and an address with a
// broken %-escape, are the asker's mistake and are answered as such (400 / 413 / 404), never as a fault of TOMLIN's (500).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

test('bad bodies and broken addresses are refused as the asker\'s mistake, and the server keeps answering', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sm-break-'));
  mkdirSync(join(home, 'startup'));
  writeFileSync(join(home, 'models-folder.txt'), '');
  const port = await freePort();
  const server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: { ...process.env, TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_OPEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  server.stdout.on('data', d => (said += d));
  server.stderr.on('data', d => (said += d));
  const base = `http://127.0.0.1:${port}`;
  const post = (p: string, body: string) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body });
  try {
    for (let i = 0; i < 200 && !said.includes('is running at'); i++) await new Promise(r => setTimeout(r, 300));
    assert.match(said, /is running at/, said);

    // A body that is not JSON: 400 with what was wrong, for a page route and the OpenAI-style one alike.
    for (const p of ['/api/todo/set', '/api/settings', '/v1/chat/completions']) {
      const r = await post(p, 'not json{');
      assert.equal(r.status, 400, `${p}: ${await r.clone().text()}`);
      assert.match(JSON.stringify(await r.json()), /not valid JSON/);
    }
    // A body over the limit: 413, not 500.
    const big = await post('/api/todo/set', `{"note":"${'x'.repeat((30 << 20) + 10)}"}`);
    assert.equal(big.status, 413, await big.clone().text());
    assert.match(JSON.stringify(await big.json()), /too large/);

    // A broken %-escape in a name in the address: nothing has that name (404), not a fault.
    for (const [method, p] of [['GET', '/api/pc/photo/%E0%A4%A'], ['GET', '/api/faces/file/%E0%A4%A'], ['POST', '/api/models/%E0%A4%A/load']]) {
      const r = await fetch(`${base}${p}`, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
      assert.equal(r.status, 404, `${method} ${p}: ${await r.text()}`);
    }

    assert.equal((await fetch(`${base}/api/status`)).status, 200);
    assert.doesNotMatch(said, /Something failed in the background|caught at the last moment/, said);
  } finally {
    server.kill();
    await new Promise(r => setTimeout(r, 300));
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
