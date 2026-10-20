// Real copies on 127.0.0.1: S4 (a node's worker door holds large bodies to a budget before their seal opens) and S5
// (the app lock PIN hash is made again at the higher cost; a 4-digit PIN still serves a node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, nodeHome, startPc, until, type Pc } from './pcs.ts';
import { hashToken, newToken } from '../src/share.ts';
import { keysText } from '../src/link.ts';
import { PIN_COST } from '../src/lock.ts';

const ROOT = join(import.meta.dirname, '..');

/**
 * A POST to the worker door that declares `length` bytes, sends a few and holds the rest back. Gives the status when the
 * door answers within `ms`, or 'held' when it is still reading. node:http with no agent: a node cuts an oversized body.
 */
function hold(port: number, path: string, link: string, length: number, ms = 2500) {
  const req = request({ host: '127.0.0.1', port, path, method: 'POST', agent: false, headers: { authorization: `Link ${link}`, 'content-type': 'application/json', 'content-length': length } });
  req.on('error', () => undefined);
  req.write('{"v":1,"box":"');
  const answer = new Promise<number | 'held'>(resolve => {
    req.on('response', r => {
      r.resume();
      resolve(r.statusCode ?? 0);
    });
    setTimeout(() => resolve('held'), ms).unref();
  });
  return { answer, end: () => req.destroy() };
}

test('S4: the worker door refuses a body larger than its door takes, before reading it, and a second large body from one link while the first is read', { timeout: 120_000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'sm-guard-node-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const workerPort = await freePort();
  nodeHome(home, workerPort);
  // One link, written as the node keeps it: the hash of its token names it, its keys seal its messages.
  const token = newToken();
  const shareFile = join(home, 'data', 'share.json');
  const share = JSON.parse(readFileSync(shareFile, 'utf8'));
  share.paired = [{ name: 'Test host', hash: hashToken(token), key: keysText(randomBytes(64)), at: new Date().toISOString(), keep: 'k1' }];
  writeFileSync(shareFile, JSON.stringify(share));
  const node: Pc = await startPc({ root: ROOT, home });
  t.after(() => node.stop());
  const link = hashToken(token);
  await until('the worker door to open', async () => (await fetch(`http://127.0.0.1:${workerPort}/worker/whoami`)).ok, 30_000, 300);

  // 40 MB declared on a door that takes 32 MB: refused before a byte more is read (400, as every body too large is).
  const big = hold(workerPort, '/worker/git-commit', link, 40 << 20);
  assert.equal(await big.answer, 400);
  big.end();

  // Two 30 MB bodies from one link at once: the first is read, the second waits its turn (refused, said why).
  const first = hold(workerPort, '/worker/git-commit', link, 30 << 20);
  assert.equal(await first.answer, 'held');
  const second = hold(workerPort, '/worker/git-commit', link, 30 << 20);
  assert.equal(await second.answer, 429);
  second.end();
  // The first one given up: its room is given back.
  first.end();
  const again = await until('the room to be given back', async () => {
    const h = hold(workerPort, '/worker/git-commit', link, 30 << 20, 1500);
    const a = await h.answer;
    h.end();
    return a === 'held' ? a : null;
  }, 15_000, 300);
  assert.equal(again, 'held');
});

test('S5: an old PIN file is made again at the higher cost; a 4-digit PIN turns a node on', { timeout: 120_000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'sm-guard-pin-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const data = join(home, 'data');
  mkdirSync(data, { recursive: true });
  // An app lock from before 2.0.56: 4 digits, scrypt's default cost, no cost in the file.
  writeFileSync(join(data, 'app-lock.json'), JSON.stringify({ salt: 'feed', hash: scryptSync('2468', 'feed', 32).toString('hex'), idleMinutes: 0 }));
  writeFileSync(join(data, 'share.json'), JSON.stringify({ on: false, port: await freePort(), name: 'Test node', id: 'a1b2c3d4', code: 'TEST-NQDE', pinOn: false, pin: '', paired: [], models: [] }));
  const pc: Pc = await startPc({ root: ROOT, home });
  t.after(() => pc.stop());
  const lockFile = () => JSON.parse(readFileSync(join(data, 'app-lock.json'), 'utf8'));

  assert.equal((await pc.post('/api/applock', { action: 'unlock', pin: '2468' })).status, 200);
  await until('the PIN file to be made again at the higher cost', async () => lockFile().cost === PIN_COST, 10_000, 200);
  assert.notEqual(lockFile().hash, scryptSync('2468', 'feed', 32).toString('hex'));
  assert.equal((await pc.post('/api/applock', { action: 'lock' })).status, 200);
  assert.equal((await pc.post('/api/applock', { action: 'unlock', pin: '2468' })).status, 200, 'the same PIN opens it after the new hash');

  // A 4-digit PIN is fine for a node (his call: most people like 4 digits). Turning it on asks no PIN, as before;
  // while it is a node, a change asks it, and a 4-digit PIN can still be set.
  const on = await pc.post('/api/share', { on: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal((await pc.get('/api/applock')).body?.node?.on, true);
  assert.equal((await pc.post('/api/applock', { action: 'change', current: '2468', pin: '1357', pin2: '1357' })).status, 200);
  assert.equal((await pc.post('/api/share', { on: false })).body?.needAppPin, true);
  assert.equal((await pc.post('/api/share', { on: false, appPin: '1357' })).status, 200);
});
