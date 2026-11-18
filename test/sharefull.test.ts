// The disk fills while a sharing setting is changed (test/fulldisk.mjs: every write in the home fails as a full disk
// fails it): the change is refused in plain words and undone, so it never shows as made and is never saved later by
// another change. And a linked PC's request that meets a full disk there is told so plainly, without folder names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testEnv } from './env.ts';
import { doorFault } from '../src/carry.ts';

const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

test('a sharing change the full disk refuses is undone, not kept in memory and saved later', { timeout: 300_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sm-sharefull-'));
  mkdirSync(join(home, 'startup'));
  writeFileSync(join(home, 'models-folder.txt'), '');
  const port = await freePort();
  const server = spawn(process.execPath, ['--import', pathToFileURL(fileURLToPath(new URL('./fulldisk.mjs', import.meta.url))).href, fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: testEnv({ TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_OPEN: '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  server.stdout.on('data', d => (said += d));
  server.stderr.on('data', d => (said += d));
  const post = async (body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/share`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
  };
  const flag = join(home, '.disk-full');
  try {
    for (let i = 0; i < 600 && !said.includes('is running at'); i++) await new Promise(r => setTimeout(r, 300));
    assert.match(said, /is running at/, said);
    assert.equal((await post({ name: 'Before' })).status, 200);
    writeFileSync(flag, '');
    const refused = await post({ name: 'During' });
    assert.ok(refused.status >= 400, JSON.stringify(refused));
    assert.match(JSON.stringify(refused.body), /disk .*full/i);
    rmSync(flag);
    // Another change once space is back: the refused name is not saved with it.
    const after = await post({ hostFirst: true });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.equal(after.body.name, 'Before', 'the page shows the name as saved');
    assert.equal(JSON.parse(readFileSync(join(home, 'data', 'share.json'), 'utf8')).name, 'Before');
  } finally {
    server.kill();
    await new Promise(r => setTimeout(r, 500));
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});

test('a full disk or a held file on a linked PC is told plainly over the link, without that PC\'s folder names', () => {
  const full = Object.assign(new Error("ENOSPC: no space left on device, write 'C:\\Users\\Someone\\TOMLIN\\models\\chat\\x.gguf.part'"), { code: 'ENOSPC' });
  assert.match(doorFault(full), /disk is full/);
  assert.doesNotMatch(doorFault(full), /Users|ENOSPC/);
  const held = Object.assign(new Error("EBUSY: resource busy or locked, open 'C:\\Users\\Someone\\x'"), { code: 'EBUSY' });
  assert.equal(doorFault(held), 'a file there could not be used (EBUSY). The details are in its log');
  assert.equal(doorFault(new Error('that piece is not part of the update.')), 'that piece is not part of the update.');
  const node = readFileSync(new URL('../src/jobrun/node.ts', import.meta.url), 'utf8');
  assert.match(node, /workerJson\(res, 400, \{ error: carry\.doorFault\(e\) \}\)/);
});
