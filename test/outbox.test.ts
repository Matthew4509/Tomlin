// Work that survives the host (src/outbox.ts): the node's outbox, and the host putting an owed answer into its chat.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as link from '../src/link.ts';
import { cleanOwed, cleanRid, KEEP_MS, newRid, Outbox, owedLine, ridOf, settle, withOwedLine, type Follower, type Lock, type Owed } from '../src/outbox.ts';
import type { ChatLine } from '../src/store.ts';

const keys = randomBytes(64);
const lock: Lock = { seal: (p, l) => link.sealBytes(link.toHost(keys), p, l), open: (r, l) => link.openBytes(link.toHost(keys), r, l) };
const OWNER = 'a1b2c3d4e5f60718';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

function follower(): Follower & { got: [string, unknown][]; ended: boolean } {
  const f = { got: [] as [string, unknown][], ended: false, send: (e: string, d: unknown) => void f.got.push([e, d]), end: () => void (f.ended = true) };
  return f;
}

async function until(check: () => boolean | Promise<boolean>, ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(10)) if (await check()) return;
  throw new Error('timed out');
}

test('an answer runs to its end when the PC that asked goes away, and waits sealed until it is collected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outbox-'));
  try {
    const box = new Outbox(dir);
    const rid = newRid();
    // The first follower is the connection that asked: it goes away part-way (its stream throws).
    const gone = { send: (e: string) => { if (e === 'text') throw new Error('closed'); }, end: () => undefined };
    let release!: () => void;
    const half = new Promise<void>(r => (release = r));
    box.start(OWNER, rid, lock, gone, async send => {
      send('text', { text: 'The answer' });
      await half;
      send('text', { text: 'The answer, whole.' });
      send('done', { model: 'Qwen 3 4B', speed: { write: 12.5 } });
    });
    assert.ok(box.isRunning(OWNER, rid));
    // Asking again with the same id follows it: what it wrote so far first, then the rest.
    const back = follower();
    assert.equal(box.join(OWNER, rid, back), true);
    assert.deepEqual(back.got[0], ['text', { text: 'The answer' }]);
    release();
    await until(() => back.ended);
    assert.deepEqual(back.got.at(-1), ['done', { model: 'Qwen 3 4B', speed: { write: 12.5 } }]);
    assert.equal(box.isRunning(OWNER, rid), false);
    const kept = await box.kept(OWNER, rid, lock);
    assert.equal(kept?.state, 'done');
    assert.equal(kept?.text, 'The answer, whole.');
    // On the disk it is sealed: the words are not in the file.
    const file = (await readdir(dir)).find(n => n.endsWith('.box'))!;
    assert.doesNotMatch((await readFile(join(dir, file))).toString('latin1'), /The answer/);
    // Another link's keys do not open it.
    const other = randomBytes(64);
    assert.equal(await box.kept(OWNER, rid, { seal: lock.seal, open: (r, l) => link.openBytes(link.toHost(other), r, l) }), null);
    assert.deepEqual(await box.where(OWNER, rid, lock), kept);
    await box.take(OWNER, rid);
    assert.equal(await box.where(OWNER, rid, lock), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the done line goes out only once the answer is on the disk, so "taken" can never come first and leave it behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outbox-'));
  try {
    const box = new Outbox(dir);
    const rid = newRid();
    let onDisk: boolean | null = null;
    let ended = false;
    // The PC that asked says "taken" the moment it reads done, as the host does.
    const f: Follower = { send: (e: string) => { if (e === 'done') onDisk = existsSync(join(dir, `${OWNER}-${rid}.box`)); }, end: () => void (ended = true) };
    box.start(OWNER, rid, lock, f, async send => {
      send('text', { text: 'Quick.' });
      send('done', {});
    });
    await until(() => ended);
    assert.equal(onDisk, true);
    await box.take(OWNER, rid);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Stop on the PC that asked ends the answer and keeps nothing; a fault is kept as the fault', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outbox-'));
  try {
    const box = new Outbox(dir);
    const rid = newRid();
    const f = follower();
    box.start(OWNER, rid, lock, f, async (send, signal) => {
      send('text', { text: 'Part' });
      await new Promise<void>(r => signal.addEventListener('abort', () => r()));
      throw new Error('Stopped.');
    });
    assert.equal(await box.stop(OWNER, rid), true);
    await until(() => f.ended);
    assert.equal(await box.kept(OWNER, rid, lock), null);
    const bad = newRid();
    box.start(OWNER, bad, lock, follower(), async send => {
      send('text', { text: 'Half an answer' });
      throw new Error('the model ran out of memory');
    });
    await until(async () => (await box.kept(OWNER, bad, lock)) !== null);
    const k = await box.kept(OWNER, bad, lock);
    assert.equal(k?.state, 'error');
    assert.equal(k?.text, 'Half an answer');
    assert.equal(k?.error, 'the model ran out of memory');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('answers nobody came back for in three days are swept away; odd ids are never used as file names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outbox-'));
  try {
    const box = new Outbox(dir);
    const rid = newRid();
    const f = follower();
    box.start(OWNER, rid, lock, f, async send => send('done', {}));
    await until(() => f.ended);
    assert.equal(await box.sweep(), 0);
    const old = new Date(Date.now() - KEEP_MS - 60_000);
    await utimes(join(dir, `${OWNER}-${rid}.box`), old, old);
    assert.equal(await box.sweep(), 1);
    assert.throws(() => box.start('../x', rid, lock, follower(), async () => undefined));
    assert.equal(cleanRid('../../settings'), null);
    assert.equal(cleanRid(rid), rid);
    // The same step asked again (the host started again) has the same id; another step does not.
    assert.equal(ridOf({ system: 'a', user: 'b' }), ridOf({ system: 'a', user: 'b' }));
    assert.notEqual(ridOf({ system: 'a', user: 'b' }), ridOf({ system: 'a', user: 'c' }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const O: Owed = { rid: 'ab'.repeat(12), pc: '0a1b2c3d', name: 'Worker PC', chatId: 'abcdef012345', ran: 'Qwen 3 4B on Worker PC', at: '2026-10-07T10:00:00.000Z' };
const asked: ChatLine = { role: 'user', content: 'Which video card for 1440p?', at: '2026-10-07T10:00:00.000Z' };

test('the host puts an owed answer into its chat: the words so far, then the whole answer in its place', () => {
  // This PC stopped before it wrote the stand-in line: it is added once.
  const a = withOwedLine([asked], O)!;
  assert.equal(a.length, 2);
  assert.deepEqual(a[1].waiting, { rid: O.rid, pc: O.pc, name: 'Worker PC' });
  assert.equal(withOwedLine(a, O), undefined);
  const b = settle(a, O.rid, { state: 'working', text: 'For 1440p,' })!;
  assert.equal(b[1].content, 'For 1440p,');
  assert.ok(b[1].waiting, 'still owed while it works');
  assert.equal(settle(b, O.rid, { state: 'working', text: 'For 1440p,' }), undefined, 'nothing new: nothing saved');
  const c = settle(b, O.rid, { state: 'done', text: 'For 1440p, a 12 GB card.', done: { speed: { write: 9.5 }, thought: null }, at: '2026-10-07T10:05:00.000Z' })!;
  assert.equal(c.length, 2);
  assert.equal(c[1].content, 'For 1440p, a 12 GB card.');
  assert.equal(c[1].waiting, undefined);
  assert.equal(c[1].perSecond, 9.5);
  assert.match(c[1].note!, /Collected from Worker PC/);
  assert.equal(c[1].ran, O.ran);
  // Settled already: a second collection changes nothing.
  assert.equal(settle(c, O.rid, { state: 'done', text: 'x', at: '' }), undefined);
  assert.equal(c[1].cut, undefined, 'a whole answer is not marked cut');
  // Cut at its length limit there (2.0.43 on): collected with Continue offered, as when it came in live.
  const cutLine = settle(b, O.rid, { state: 'done', text: 'For 1440p, a', done: { speed: null, thought: null, cut: true }, at: '2026-10-07T10:05:00.000Z' })!;
  assert.equal(cutLine[1].cut, true);
});

test('an owed answer that cannot come keeps the words so far and says why', () => {
  const a = [asked, owedLine(O, 'For 1440p')];
  const gone = settle(a, O.rid, { state: 'gone', why: '"Worker PC" does not have that answer.' })!;
  assert.equal(gone[1].content, 'For 1440p …');
  assert.equal(gone[1].waiting, undefined);
  assert.equal(gone[1].note, '"Worker PC" does not have that answer.');
  const failed = settle(a, O.rid, { state: 'error', text: 'For 1440p, a', error: 'the model ran out of memory', at: '' })!;
  assert.equal(failed[1].content, 'For 1440p, a …');
  assert.match(failed[1].note!, /Worker PC stopped part-way: the model ran out of memory\. Send your message again\./);
});

test('the list of owed answers keeps only well-formed entries', () => {
  assert.deepEqual(cleanOwed([O, { ...O, rid: 'nope' }, { ...O, chatId: '../x' }, null, 'x']), [O]);
  assert.deepEqual(cleanOwed('not a list'), []);
});
