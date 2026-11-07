// A fresh install, nobody hired: New chat says so and gives the way to hire (the host is switched off on purpose, so the
// list is empty); and the web tool's description tells the model it may read several pages in one go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACE, WEB_TOOLS } from '../src/webtools.ts';

const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

test('fresh data folder: New chat has nobody listed, and says what to do', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sm-fresh-'));
  mkdirSync(join(home, 'startup'));
  writeFileSync(join(home, 'models-folder.txt'), '');
  const port = await freePort();
  const server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: { ...process.env, TOMLIN_DATA: join(home, 'data'), TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_OPEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  server.stdout.on('data', d => (said += d));
  server.stderr.on('data', d => (said += d));
  try {
    for (let i = 0; i < 200 && !said.includes('is running at'); i++) await new Promise(r => setTimeout(r, 300));
    assert.match(said, /is running at/, said);
    const d = await (await fetch(`http://127.0.0.1:${port}/api/chats`)).json() as { people: unknown[]; nobody?: string };
    assert.deepEqual(d.people, []);
    assert.match(d.nobody ?? '', /Nobody is hired yet/);
    assert.match(d.nobody ?? '', /Hire/);
  } finally {
    server.kill();
    await new Promise(r => setTimeout(r, 300));
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('the New chat window shows that line, with a button that opens Hire staff, when nobody is listed', () => {
  const js = readFileSync(fileURLToPath(new URL('../public/chats.js', import.meta.url)), 'utf8');
  assert.match(js, /chatUi\.nobody/);
  assert.match(js, /new-chat-none/);
});

test('open_page tells the model it may ask for several pages at once', () => {
  const open = WEB_TOOLS.find(t => t.function.name === 'open_page')!.function.description;
  assert.match(open, /several pages/);
  assert.match(open, new RegExp(`up to ${PACE.pagesPerRound} in one go`));
});
