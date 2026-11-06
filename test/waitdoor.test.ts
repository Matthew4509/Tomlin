// 6 Nov slow-start plan, fix 2: the port answers while a start backs up data/, and the app takes over the same socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { openWaitDoor, takeWaitDoor, waitAnswer } from '../src/waitdoor.ts';

const freePort = () => new Promise<number>(done => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); }); });

test('the holding page for a browser, 503 "starting" for the API, 403 for another host name', () => {
  const page = waitAnswer('/', '127.0.0.1:8740', 8740);
  assert.equal(page.status, 503);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /http-equiv="refresh"/);
  assert.match(page.body, /keeps a copy of your data/);
  const api = waitAnswer('/api/status?x=1', 'localhost:8740', 8740);
  assert.equal(api.status, 503);
  assert.equal(JSON.parse(api.body).busy, 'starting');
  assert.equal(waitAnswer('/v1/chat/completions', '127.0.0.1:8740', 8740).status, 503);
  assert.equal(waitAnswer('/', 'evil.example:8740', 8740).status, 403);
});

test('the door answers at once, then the app answers on the same socket with no gap', async () => {
  const port = await freePort();
  await openWaitDoor(port);
  const before = await fetch(`http://127.0.0.1:${port}/api/status`);
  assert.equal(before.status, 503);
  assert.equal((await before.json()).busy, 'starting');
  const s = takeWaitDoor();
  assert.ok(s?.listening);
  s.on('request', (_req, res) => res.end('app'));
  const after = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(after.status, 200);
  assert.equal(await after.text(), 'app');
  assert.equal(takeWaitDoor(), null);
  await new Promise(r => s.close(r));
});

test('a port already taken: no door, and the app listens itself (and says the port is in use)', async () => {
  const port = await freePort();
  const holder = createServer().listen(port, '127.0.0.1');
  await new Promise(r => holder.once('listening', r));
  await openWaitDoor(port);
  assert.equal(takeWaitDoor(), null);
  await new Promise(r => holder.close(r));
});

test('the door opens before the data is prepared, and the app takes it over before it would listen', () => {
  const core = readFileSync(new URL('../src/server/core.ts', import.meta.url), 'utf8');
  assert.ok(core.indexOf('await openWaitDoor(PORT);') > 0 && core.indexOf('await openWaitDoor(PORT);') < core.indexOf('await keep.prepare('));
  const srv = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(srv, /const server = takeWaitDoor\(\) \?\? createServer\(\);\s*\n\s*server\.on\('request',/);
  assert.match(srv, /if \(server\.listening\) started\(\);\s*\nelse server\.listen\(PORT, '127\.0\.0\.1', started\);/);
});
