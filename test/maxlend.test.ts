import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as carry from '../src/carry.ts';
import { alive } from '../src/hardware.ts';
import { cleanLendIdle, DEFAULT_LEND_IDLE, Lender, lendWhy, loanEnds, maxShown, nobodyThere, ownerBack, presenceOf, rpcArgs, type RpcProgram } from '../src/maxlend.ts';
import { chatArgs, maxFault, whyItFailed } from '../src/llama.ts';

const ALL = { pull: true, backup: true, update: true, tune: true, lend: true, receive: true, give: true };
const LEND = { ...carry.NO_ALLOW, lend: true, receive: true };
const min = 60_000;
const base = { pc: 'Worker PC', on: true, shown: true, allow: LEND, away: false, presence: { idleMs: 10 * min, locked: false }, idleMinutes: 5, lease: null, by: { hash: 'a' } };
const SRC = pathToFileURL(join(import.meta.dirname, '..', 'src', 'maxlend.ts')).href;
/** A stand-in for ggml-rpc-server: a plain echo server on the port it is given. */
const standIn = (port: number) => spawn(process.execPath, ['-e', `require('net').createServer(s => s.pipe(s)).listen(${port}, '127.0.0.1')`], { stdio: 'ignore', windowsHide: true });
const PROGRAM: RpcProgram = { exe: 'ggml-rpc-server.exe', device: 'cpu', threads: 0 };

test('the Max mode tick is its own, and Allow all covers it', () => {
  assert.equal(carry.cleanAllow({ lend: 'yes' }).lend, false);
  assert.equal(carry.cleanAllow({ lend: true, receive: true }).lend, true);
  assert.equal(carry.allowsAll(ALL), true);
  // A node that had "Allow all" before this tick: Allow all shows unticked until it is ticked too.
  assert.equal(carry.allowsAll({ ...ALL, lend: false, receive: false }), false);
});

test('how long nobody must use the PC: 5 minutes unless its owner picked another of the choices', () => {
  assert.equal(DEFAULT_LEND_IDLE, 5);
  assert.equal(cleanLendIdle(undefined), 5);
  assert.equal(cleanLendIdle(10), 10);
  assert.equal(cleanLendIdle('30'), 30);
  assert.equal(cleanLendIdle(3), 5, 'not one of the choices');
  assert.equal(cleanLendIdle(0), 5);
});

test('it lends only while nobody uses it: Windows locked, or idle for the minutes chosen', () => {
  assert.equal(lendWhy(base), '');
  assert.equal(lendWhy({ ...base, presence: { idleMs: 4 * min, locked: false } }).includes('someone is using "Worker PC" (last used 4 min ago)'), true);
  assert.match(lendWhy({ ...base, presence: { idleMs: 4 * min, locked: false } }), /after 5 minutes with nobody using it/);
  assert.equal(lendWhy({ ...base, presence: { idleMs: 2_000, locked: true } }), '', 'locked: at once');
  assert.equal(lendWhy({ ...base, idleMinutes: 15 }) !== '', true, '10 minutes is not 15');
  assert.ok(nobodyThere({ idleMs: 5 * min, locked: false }, 5));
});

test('it refuses with the reason and where to change it', () => {
  assert.match(lendWhy({ ...base, on: false }), /not a node/);
  assert.match(lendWhy({ ...base, allow: carry.NO_ALLOW }), /ticks "Lend card memory to linked PCs \(Max mode\)" under Network/);
  assert.match(lendWhy({ ...base, away: true }), /I need to use the pc/);
  assert.match(lendWhy({ ...base, presence: null }), /could not tell whether someone is using it/);
});

test('one PC borrows at a time: another is told who has it; the same one may open more streams', async () => {
  const lease = { hash: 'a', name: 'Office PC', since: new Date().toISOString() };
  assert.match(lendWhy({ ...base, lease, by: { hash: 'b' } }), /lending its card memory to "Office PC" now\. One PC borrows it at a time/);
  assert.equal(lendWhy({ ...base, lease, by: { hash: 'a' } }), '');
  const l = new Lender(tmpdir(), () => '');
  l.lease = lease;
  await assert.rejects(l.open({ hash: 'b', name: 'Laptop' }, null), /lending to "Office PC"/);
  await assert.rejects(l.open({ hash: 'a', name: 'Office PC' }, null), /RPC server is missing/);
});

test('Max mode is hidden until the PC is started with TOMLIN_MAX: no lending, and a tick saved before (Allow all) counts for nothing', () => {
  assert.equal(maxShown({}), false);
  assert.equal(maxShown({ TOMLIN_MAX: ' ' }), false);
  assert.equal(maxShown({ TOMLIN_MAX: 'Worker PC' }), true);
  assert.match(lendWhy({ ...base, shown: false }), /does not lend its card memory: Max mode is not switched on there/);
  assert.equal(carry.cleanAllow({ ...ALL }, false).lend, false);
  assert.equal(carry.cleanAllow({ ...ALL }, false).tune, true, 'the other ticks stay');
  assert.equal(carry.cleanAllow({ ...ALL }).lend, true);
});

test('the page shows the Lend tick and its Help line only once Max mode is shown, and Help no longer counts "all five"', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /<div data-max hidden><label class="check"><input type="checkbox" data-allow="lend">/);
  assert.match(html, /<span data-max hidden>, <b>Lend card memory to linked PCs \(Max mode\)<\/b>/);
  assert.doesNotMatch(html, /ticks all five/);
  const js = readFileSync(join(import.meta.dirname, '..', 'public', 'home.js'), 'utf8');
  assert.match(js, /lend: e\.target\.checked && shown/, 'Allow all ticks Lend only while it is shown');
});

test('a loan ends when the link to the PC borrowing it is removed', () => {
  const lease = { hash: 'a', name: 'Office PC', since: new Date().toISOString() };
  const on = { on: true, allow: LEND, away: false, presence: { idleMs: 10 * min, locked: false }, lease, paired: [{ hash: 'b' }, { hash: 'a' }] };
  assert.equal(loanEnds(on), '');
  assert.equal(loanEnds({ ...on, paired: [{ hash: 'b' }] }), 'the link to "Office PC" was removed');
  assert.equal(loanEnds({ ...on, lease: null, paired: [] }), '', 'no loan: nothing to end');
});

test('a loan ended while its RPC server is still starting stays ended: nothing is left lending', async () => {
  let spawned = 0;
  class T extends Lender {
    protected spawnRpc(_p: RpcProgram, port: number) {
      spawned++;
      return standIn(port);
    }
  }
  const l = new T(tmpdir(), () => '');
  const opening = l.open({ hash: 'a', name: 'Office PC' }, PROGRAM);
  // Sharing turned off at once, before the server is even started.
  await l.end('sharing was turned off there');
  await assert.rejects(opening, /the loan ended as it started/);
  assert.equal(spawned, 0, 'no RPC server was started');
  assert.equal(l.lease, null);
  assert.equal(l.pid, null);
});

test('TOMLIN ending (its window closed, Quit) ends the RPC server and the presence reader with it', { skip: process.platform !== 'win32' && 'the presence reader is Windows only' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-lendexit-'));
  try {
    const script = join(dir, 'lend.mjs');
    writeFileSync(script, `import { spawn } from 'node:child_process';
import { Lender, PresenceReader } from ${JSON.stringify(SRC)};
class T extends Lender {
  spawnRpc(_p, port) { return spawn(process.execPath, ['-e', \`require('net').createServer(s => s.pipe(s)).listen(\${port}, '127.0.0.1')\`], { stdio: 'ignore', windowsHide: true }); }
}
const l = new T(${JSON.stringify(dir)}, () => '');
await l.open({ hash: 'a', name: 'Office PC' }, { exe: 'x', device: 'cpu', threads: 0 });
const r = new PresenceReader();
r.now();
console.log(JSON.stringify({ rpc: l.pid, presence: r.pid }));
process.exit(0);
`);
    const said = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 60_000 }).trim().split('\n').pop()!) as { rpc: number; presence: number };
    assert.ok(said.rpc && said.presence, JSON.stringify(said));
    for (let t = 0; t < 50 && (alive(said.rpc) || alive(said.presence)); t++) await new Promise(r => setTimeout(r, 100));
    assert.equal(alive(said.rpc), false, 'the RPC server was ended with TOMLIN');
    assert.equal(alive(said.presence), false, 'the presence reader was ended with TOMLIN');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a loan ends when someone comes back, presses "I need to use the pc", or the tick or sharing goes off', () => {
  const on = { on: true, allow: LEND, away: false, presence: { idleMs: 10 * min, locked: false }, lease: null, paired: [] };
  assert.equal(loanEnds(on), '');
  assert.equal(loanEnds({ ...on, presence: { idleMs: 800, locked: false } }), 'someone started using it');
  // A mouse moved at the lock screen is not someone back at the PC.
  assert.equal(loanEnds({ ...on, presence: { idleMs: 800, locked: true } }), '');
  assert.equal(loanEnds({ ...on, presence: null }), '', 'a missed reading does not end it');
  assert.match(loanEnds({ ...on, away: true }), /I need to use the pc/);
  assert.match(loanEnds({ ...on, allow: carry.NO_ALLOW }), /took the Max mode tick off/);
  assert.match(loanEnds({ ...on, on: false }), /sharing was turned off/);
  assert.equal(ownerBack({ idleMs: 4_999, locked: false }), true);
  assert.equal(ownerBack({ idleMs: 5_000, locked: false }), false);
});

test('the presence reader\'s lines', () => {
  assert.deepEqual(presenceOf('61234 0'), { idleMs: 61234, locked: false });
  assert.deepEqual(presenceOf('12 1\r'), { idleMs: 12, locked: true });
  assert.equal(presenceOf('Add-Type: error'), null);
  assert.equal(presenceOf(''), null);
});

test('the RPC server listens on this PC only; threads only for a CPU lend; the cache only when asked', () => {
  assert.deepEqual(rpcArgs(5000, { exe: 'x', device: 'cuda', threads: 4 }, true), ['-H', '127.0.0.1', '-p', '5000', '-c']);
  assert.deepEqual(rpcArgs(5000, { exe: 'x', device: 'cpu', threads: 4 }, false), ['-H', '127.0.0.1', '-p', '5000', '-t', '4']);
  assert.ok(!rpcArgs(5000, { exe: 'x', device: 'cpu', threads: 0 }, false).includes('-t'));
});

test('a chat runner with lent PCs: --rpc, and llama.cpp\'s own fit places the layers (no -ngl), on the CPU runner too', () => {
  const a = chatArgs('m.gguf', 9000, 'cpu', 4, false, { ctx: 8192, cache: 'f16', place: 'auto', rpc: ['127.0.0.1:1', '127.0.0.1:2'] });
  assert.deepEqual(a.slice(a.indexOf('--rpc'), a.indexOf('--rpc') + 2), ['--rpc', '127.0.0.1:1,127.0.0.1:2']);
  assert.ok(!a.includes('-ngl'));
  const plain = chatArgs('m.gguf', 9000, 'cpu', 4);
  assert.ok(!plain.includes('--rpc'));
  assert.deepEqual(plain.slice(plain.indexOf('-ngl'), plain.indexOf('-ngl') + 2), ['-ngl', '0']);
});

test('a lent PC that went away is named as the reason', () => {
  const tail = 'E send failed (bytes_sent=0, size_to_send=8)\nD:/a/llama.cpp/ggml/src/ggml-rpc/ggml-rpc.cpp:569: Remote RPC server crashed or returned malformed response';
  assert.ok(maxFault(tail));
  assert.match(whyItFailed(tail), /a PC lending its card for Max mode stopped answering/);
  assert.ok(!maxFault('llama_model_load: error loading model: failed to allocate buffer'));
});
