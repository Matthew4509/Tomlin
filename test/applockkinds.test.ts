// A1 + A2 on a real copy: the app lock is a PIN or a password, and 10 recovery codes can set a new one from the lock
// screen. Each test starts its own copy on a home in %TEMP%.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scryptSync } from 'node:crypto';
import { startPc, type Pc } from './pcs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function withPc(what: string, before: (data: string) => void, run: (pc: Pc, data: string) => Promise<void>): Promise<void> {
  const top = mkdtempSync(join(tmpdir(), `tomlin-${what}-`));
  const data = join(top, 'data');
  let pc: Pc | undefined;
  try {
    mkdirSync(data, { recursive: true });
    before(data);
    pc = await startPc({ root: ROOT, home: top });
    await run(pc, data);
  } finally {
    await pc?.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

/** Locks every browser and forgets this one's cookie, as a new browser would be. */
async function relock(pc: Pc): Promise<void> {
  await pc.post('/api/applock', { action: 'lock' });
  pc.cookie = '';
}

test('A1: an app lock file from before A1 (no kind) is a PIN and still opens with it', { timeout: 120_000 }, () => withPc('oldpin', data => {
  writeFileSync(join(data, 'app-lock.json'), JSON.stringify({ salt: 'feed', hash: scryptSync('2468', 'feed', 32).toString('hex'), idleMinutes: 0 }));
}, async pc => {
  const v = await pc.get('/api/applock');
  assert.equal(v.body.on, true);
  assert.equal(v.body.kind, 'pin');
  assert.equal(v.body.codes, null, 'no recovery codes yet');
  assert.equal((await pc.post('/api/applock', { action: 'unlock', pin: '2469' })).status, 403);
  assert.equal((await pc.post('/api/applock', { action: 'unlock', pin: '2468' })).status, 200);
  assert.equal((await pc.get('/api/chats')).status, 200);
  // A lock from before A2 makes its codes with New set (the current PIN needed).
  const made = await pc.post('/api/applock', { action: 'codes-new', current: '2468' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.recoveryCodes.length, 10);
}));

test('A1 + A2: a password lock, its 10 codes once, the kind switched, a code sets a new lock once', { timeout: 180_000 }, () => withPc('kinds', () => undefined, async (pc, data) => {
  // A password of any length; the strength is shown but nothing is refused.
  const set = await pc.post('/api/applock', { action: 'set', kind: 'password', pin: 'a', pin2: 'a', agree: true, idleMinutes: 15 });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.kind, 'password');
  assert.equal(set.body.open, false, 'it locks at once');
  const codes: string[] = set.body.recoveryCodes;
  assert.equal(codes.length, 10, 'the first lock makes 10 recovery codes, shown once');
  assert.deepEqual(set.body.codes, { left: 10, total: 10 });
  assert.equal((await pc.get('/api/applock')).body.recoveryCodes, undefined, 'never shown again');
  // Only hashes on disk.
  const disk = readFileSync(join(data, 'recovery-codes.json'), 'utf8');
  for (const c of codes) assert.ok(!disk.includes(c) && !disk.includes(c.replace('-', '')), 'no code in the file');
  assert.equal(JSON.parse(readFileSync(join(data, 'app-lock.json'), 'utf8')).kind, 'password');

  assert.equal((await pc.post('/api/applock', { action: 'unlock', pin: 'b' })).status, 403);
  assert.equal((await pc.post('/api/applock', { action: 'unlock', pin: 'a' })).status, 200);

  // Switched to a PIN with the current password; the password no longer opens it.
  const ch = await pc.post('/api/applock', { action: 'change', current: 'a', kind: 'pin', pin: '1357', pin2: '1357' });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  assert.equal(ch.body.kind, 'pin');
  assert.equal(ch.body.recoveryCodes, undefined, 'a change keeps the same codes');
  assert.equal((await pc.post('/api/applock', { action: 'change', current: '1357', kind: 'pin', pin: '12', pin2: '12' })).status, 400, 'the PIN rules stay');
  await relock(pc);
  assert.equal((await pc.post('/api/applock', { action: 'unlock', pin: 'a' })).status, 403);

  // Forgot it: a recovery code sets a new password and opens this browser.
  assert.equal((await pc.post('/api/applock', { action: 'recover', code: 'ABCDE-FGHJK', kind: 'password', pin: 'new one', pin2: 'new one' })).status, 403);
  const rec = await pc.post('/api/applock', { action: 'recover', code: codes[2].toLowerCase(), kind: 'password', pin: 'new one', pin2: 'new one' });
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  assert.equal(rec.body.open, true);
  assert.equal(rec.body.kind, 'password');
  assert.deepEqual(rec.body.codes, { left: 9, total: 10 });
  assert.equal((await pc.get('/api/chats')).status, 200, 'this browser is open');
  await relock(pc);
  assert.equal((await pc.post('/api/applock', { action: 'recover', code: codes[2], kind: 'pin', pin: '9999', pin2: '9999' })).status, 403, 'a code works once');
  assert.equal((await pc.post('/api/applock', { action: 'unlock', pin: 'new one' })).status, 200);

  // New set: the current lock (or a current code) is needed; the old set is void.
  assert.equal((await pc.post('/api/applock', { action: 'codes-new', current: 'wrong' })).status, 403);
  const fresh = await pc.post('/api/applock', { action: 'codes-new', current: codes[5] });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  const codes2: string[] = fresh.body.recoveryCodes;
  assert.equal(codes2.length, 10);
  assert.deepEqual(fresh.body.codes, { left: 10, total: 10 });
  const again = await pc.post('/api/applock', { action: 'codes-new', current: 'new one' });
  assert.equal(again.status, 200);
  const codes3: string[] = again.body.recoveryCodes;
  await relock(pc);
  for (const old of [codes[7], codes2[0]]) assert.equal((await pc.post('/api/applock', { action: 'recover', code: old, kind: 'pin', pin: '2222', pin2: '2222' })).status, 403, 'the old sets are void');
  // A new lock that breaks the rules uses no code.
  assert.equal((await pc.post('/api/applock', { action: 'recover', code: codes3[0], kind: 'pin', pin: '12', pin2: '12' })).status, 400);
  assert.equal((await pc.post('/api/applock', { action: 'recover', code: codes3[0], kind: 'pin', pin: '2222', pin2: '2222' })).status, 200);
  assert.equal((await pc.get('/api/applock')).body.codes.left, 9);
}));

test('A2: wrong recovery codes are counted with wrong PINs: 5 and the lock screen waits', { timeout: 120_000 }, () => withPc('codetries', () => undefined, async pc => {
  const set = await pc.post('/api/applock', { action: 'set', kind: 'pin', pin: '4826', pin2: '4826', agree: true });
  assert.equal(set.status, 200);
  const codes: string[] = set.body.recoveryCodes;
  for (let i = 0; i < 3; i++) assert.equal((await pc.post('/api/applock', { action: 'recover', code: 'ABCDE-FGHJK', kind: 'pin', pin: '1111', pin2: '1111' })).status, 403);
  for (let i = 0; i < 2; i++) assert.equal((await pc.post('/api/applock', { action: 'unlock', pin: '0000' })).status, 403);
  assert.equal((await pc.post('/api/applock', { action: 'unlock', pin: '4826' })).status, 429, 'five wrong tries: even the right PIN waits');
  assert.equal((await pc.post('/api/applock', { action: 'recover', code: codes[0], kind: 'pin', pin: '1111', pin2: '1111' })).status, 429, 'and so does a right code');
  assert.ok((await pc.get('/api/applock')).body.waitMinutes > 0);
}));

test('A1: password tries are counted before the slow check, so tries sent side by side cannot slip past the limit', { timeout: 120_000 }, () => withPc('pwtries', () => undefined, async pc => {
  assert.equal((await pc.post('/api/applock', { action: 'set', kind: 'password', pin: 'open sesame', pin2: 'open sesame', agree: true })).status, 200);
  const r = await Promise.all(Array.from({ length: 8 }, (_, i) => pc.post('/api/applock', { action: 'unlock', pin: `wrong ${i}` })));
  assert.ok(r.every(x => x.status === 403 || x.status === 429));
  assert.equal((await pc.post('/api/applock', { action: 'unlock', pin: 'open sesame' })).status, 429);
}));
