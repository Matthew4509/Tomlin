// N1 (27 Nov agents plan): an agent's timed run waits while a person uses its PC (src/pcbusy.ts), and the queue holds
// only that run (src/queue.ts toStart's `held`): a picture or chat lined up behind it goes on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busyWhy, cleanInUse, gpuOf, screenOf, WHY } from '../src/pcbusy.ts';
import * as Q from '../src/queue.ts';
import * as A from '../src/agents.ts';

const quiet = { screen: 5, gpu: 2, idleMs: 3 * 3600_000 };
const off = { keyMinutes: 10 };

test('busy reasons come from the looks, in fixed words', () => {
  assert.deepEqual(busyWhy(quiet, off, { node: false }), { busy: false, why: '' });
  assert.equal(busyWhy({ ...quiet, screen: 3 }, off, { node: false }).why, WHY.screen);
  assert.equal(busyWhy({ ...quiet, screen: 2 }, off, { node: false }).why, WHY.screen);
  assert.equal(busyWhy({ ...quiet, gpu: 85 }, off, { node: false }).why, WHY.gpu);
  // TOMLIN's own use of the card says nothing about other programs.
  assert.equal(busyWhy({ ...quiet, gpu: 85 }, off, { node: false, ownGpu: true }).busy, false);
  const keys = busyWhy({ ...quiet, idleMs: 60_000 }, off, { node: false });
  assert.equal(keys.busy, true);
  assert.match(keys.why, /key or mouse press in the last 10 minutes/);
  assert.equal(busyWhy({ ...quiet, idleMs: 11 * 60_000 }, off, { node: false }).busy, false);
  assert.equal(busyWhy({ ...quiet, idleMs: 11 * 60_000 }, { keyMinutes: 30 }, { node: false }).busy, true);
  // Looks that could not be taken hold nothing.
  assert.equal(busyWhy({ screen: null, gpu: null, idleMs: null }, off, { node: false }).busy, false);
});

test('the switch: off by default on a PC that is not a node, on for a node, and his choice wins', () => {
  const game = { ...quiet, screen: 3 };
  assert.equal(busyWhy(game, off, { node: false }).busy, true);
  assert.equal(busyWhy(game, off, { node: true }).busy, false);
  assert.equal(busyWhy(game, { ...off, whileInUse: true }, { node: false }).busy, false);
  assert.equal(busyWhy(game, { ...off, whileInUse: false }, { node: true }).busy, true);
  assert.deepEqual(cleanInUse({ keyMinutes: 500, whileInUse: 'yes' }), { keyMinutes: 120 });
  assert.deepEqual(cleanInUse({}), { keyMinutes: 10 });
});

test('the looks\' output is read, and nothing else', () => {
  assert.equal(gpuOf('37\r\n4\r\n'), 37);
  assert.equal(gpuOf(''), null);
  assert.equal(gpuOf('NVIDIA-SMI has failed'), null);
  assert.deepEqual(screenOf('3 1200\r\n'), { screen: 3, idleMs: 1200 });
  assert.deepEqual(screenOf('5 -1'), { screen: 5, idleMs: null });
  assert.deepEqual(screenOf('garbage'), { screen: null, idleMs: null });
});

const item = (id: string, kind: Q.QItem['kind']): Q.QItem => ({ id, kind, state: 'waiting', title: id, added: '2026-11-27T07:00:00Z', tries: 0 } as Q.QItem);

test('an agent item waits while its PC is in use and runs after; a picture behind it is not held', () => {
  const q: Q.Queue = { ...Q.EMPTY, items: [item('agent1', 'agent'), item('pic1', 'picture')] };
  const lanes = () => ['here'];
  const busy = (it: Q.QItem) => it.kind === 'agent';
  assert.deepEqual(Q.toStart(q, lanes, new Set(), Date.now(), busy).map(x => x.id), ['pic1']);
  // Not in use any more: the agent goes first again, in its place.
  assert.deepEqual(Q.toStart(q, lanes, new Set(), Date.now(), () => false).map(x => x.id), ['agent1']);
});

test('a waiting run says this PC is in use, and a skip says why', () => {
  assert.equal(A.inUseLine(WHY.screen), 'Waiting: this PC is in use (a full-screen game or program is in front).');
  const run = { id: 'r1', job: 'j1', name: 'Price check', agent: 'robin', agentName: 'Robin', by: 'its timer', state: 'waiting', added: '', line: '', held: [] } as A.Run;
  const f = { ...A.EMPTY_FILE, runs: [run] };
  assert.equal(A.skipLine(f, run, 60, WHY.screen), 'Skipped: a full-screen game or program was in front for 60 minutes.');
  assert.equal(A.skipLine(f, run, 60), 'Skipped: its PC was busy for 60 minutes.');
});
