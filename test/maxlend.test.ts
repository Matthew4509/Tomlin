import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import * as carry from '../src/carry.ts';
import { cleanLendIdle, DEFAULT_LEND_IDLE, Lender, lendWhy, loanEnds, nobodyThere, ownerBack, presenceOf, rpcArgs } from '../src/maxlend.ts';
import { chatArgs, maxFault, whyItFailed } from '../src/llama.ts';

const ALL = { pull: true, backup: true, update: true, tune: true, lend: true };
const LEND = { ...carry.NO_ALLOW, lend: true };
const min = 60_000;
const base = { pc: 'Worker PC', on: true, allow: LEND, away: false, presence: { idleMs: 10 * min, locked: false }, idleMinutes: 5, lease: null, by: { hash: 'a' } };

test('the Max mode tick is its own, and Allow all covers it', () => {
  assert.equal(carry.cleanAllow({ lend: 'yes' }).lend, false);
  assert.equal(carry.cleanAllow({ lend: true }).lend, true);
  assert.equal(carry.allowsAll(ALL), true);
  // A node that had "Allow all" before this tick: Allow all shows unticked until it is ticked too.
  assert.equal(carry.allowsAll({ ...ALL, lend: false }), false);
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

test('a loan ends when someone comes back, presses "I need to use the pc", or the tick or sharing goes off', () => {
  const on = { on: true, allow: LEND, away: false, presence: { idleMs: 10 * min, locked: false } };
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
