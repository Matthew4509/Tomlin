// P1-4 (3 Nov): a node unloaded only one idle model before refusing (Gemma 4 refused with 6.6 GB free while three test
// models sat idle for the same PC), and the memory check ignored what a Max mode lending PC adds (Qwen3-Next-80B Q4
// refused: "needs 48.8 GB, 37.2 GB free" with a PC lending).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWayOrder, type LoadedFor } from '../src/nodestaff.ts';
import { lentBytes } from '../src/jobrun/maxhost.ts';

const GB = 2 ** 30;
const row = (by: string[], at: number) => ({ by: new Set(by), links: new Set(['l']), at });

test('every idle model loaded only for the asking PC makes way, oldest first; not the one asked for', () => {
  const loaded: LoadedFor = new Map([
    ['b', row(['worker'], 300)],
    ['a', row(['worker'], 100)],
    ['c', row(['worker'], 200)],
    ['want', row(['worker'], 50)],
  ]);
  assert.deepEqual(makeWayOrder(loaded, 'worker', 'want', () => true), ['a', 'c', 'b']);
});

test('a model answering, or loaded for another PC too, or only for another PC, stays', () => {
  const loaded: LoadedFor = new Map([
    ['busy', row(['worker'], 1)],
    ['shared', row(['worker', 'laptop'], 2)],
    ['theirs', row(['laptop'], 3)],
    ['free', row(['worker'], 4)],
  ]);
  assert.deepEqual(makeWayOrder(loaded, 'worker', 'want', id => id !== 'busy'), ['free']);
});

test('nothing loaded for that PC: nothing makes way', () => {
  assert.deepEqual(makeWayOrder(new Map(), 'worker', 'want', () => true), []);
});

const hello = (memory: unknown, can = ['max']) => ({ can, memory });

test('a lending PC with a card adds that card\'s free memory, less 0.5 GB kept free', () => {
  const h = hello({ cards: { count: 1, total: 4 * GB }, ram: { total: 32 * GB, used: 8 * GB }, gpu: { name: 'K1200', total: 4 * GB, used: 0.5 * GB } });
  assert.equal(lentBytes([h]), 3 * GB);
});

test('a lending PC with no card adds its free RAM, less the 3 GB kept for Windows', () => {
  const h = hello({ cards: { count: 0, total: 0 }, ram: { total: 32 * GB, used: 12 * GB }, gpu: null });
  assert.equal(lentBytes([h]), 17 * GB);
});

test('two lending PCs add up; one with no Max, no memory reading, or a card it cannot read adds nothing', () => {
  const ram = (free: number) => hello({ cards: { count: 0, total: 0 }, ram: { total: 16 * GB, used: (16 - free) * GB }, gpu: null });
  assert.equal(lentBytes([ram(10), ram(5)]), 9 * GB);
  assert.equal(lentBytes([hello({ cards: { count: 0 }, ram: { total: 16 * GB, used: 0 } }, [])]), 0);
  assert.equal(lentBytes([hello(null), null]), 0);
  assert.equal(lentBytes([hello({ cards: { count: 1, total: 8 * GB }, ram: { total: 16 * GB, used: 0 }, gpu: null })]), 0);
  // Never less than nothing.
  assert.equal(lentBytes([ram(1)]), 0);
});

// P1-4, the speed finder: a model loaded for a linked PC and then speed-tested (or set with Go with this config / Undo)
// is unloaded and loaded again; the gap read as "gone", its mark was lost, and the model then stayed loaded for good.
import { readFileSync } from 'node:fs';
import { finderHolds } from '../src/finderrun.ts';
import { chatVerdict } from '../src/nodestaff.ts';

test('the finder holds the model under test while it runs, then one it is loading again, else none', () => {
  assert.equal(finderHolds({ model: 'm', run: { state: 'running' } }, new Set()), 'm');
  assert.equal(finderHolds({ model: 'm', run: null }, new Set()), 'm');
  assert.equal(finderHolds({ model: 'm', run: { state: 'done' } }, new Set(['m'])), 'm');
  assert.equal(finderHolds({ model: 'm', run: { state: 'done' } }, new Set()), null);
  assert.equal(finderHolds(null, new Set(['x'])), 'x');
  assert.equal(finderHolds(null, new Set()), null);
});

test('a model the finder holds keeps its linked-PC mark even while it is unloaded for a moment', () => {
  assert.equal(chatVerdict({ state: 'disconnected', lending: false, busyHere: false, testing: true, idleMs: 0 }), 'keep');
  assert.equal(chatVerdict({ state: 'disconnected', lending: false, busyHere: false, testing: false, idleMs: 0 }), 'gone');
});

test('the put back after a test and the reload after Go / Undo both mark the model as being loaded again', () => {
  const src = readFileSync(new URL('../src/server/finder.ts', import.meta.url), 'utf8');
  assert.match(src, /async putBack\(\) \{\s*await whileReloading\(id,/);
  assert.match(src, /return whileReloading\(id, async \(\) => \{\s*await p\.disconnect\(\);/);
  assert.match(src, /export const finderTesting = \(\) => finderHolds\(job, reloading\);/);
});
