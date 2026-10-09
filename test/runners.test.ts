import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainIndex, MAX_RUNNERS, namesOf, place, type RunnerLook } from '../src/runners.ts';

const GB = 2 ** 30;
const r = (model: string | null, o: Partial<RunnerLook> = {}): RunnerLook => ({ model, name: model ?? '', state: model ? 'connected' : 'disconnected', ram: model ? 2 * GB : 0, usedAt: 0, ...o });

test('nothing loaded: the first runner, whatever else is empty', () => {
  assert.deepEqual(place('a', 'A', 2 * GB, 10 * GB, [r(null)]), { index: 0, already: false, replaces: null, level: 'ok' });
  assert.deepEqual(place('a', 'A', 2 * GB, 10 * GB, [r(null), r(null)]), { index: 0, already: false, replaces: null, level: 'ok' });
});

test('a model already loaded (or loading) answers where it is', () => {
  assert.deepEqual(place('b', 'B', 2 * GB, 1 * GB, [r('a'), r('b')]), { index: 1, already: true });
  assert.deepEqual(place('b', 'B', 2 * GB, 1 * GB, [r('b', { state: 'loading' })]), { index: 0, already: true });
});

test('a model that fits goes beside the loaded ones, in an empty runner or a new one', () => {
  assert.deepEqual(place('b', 'B', 2 * GB, 6 * GB, [r('a')]), { index: 1, already: false, replaces: null, level: 'ok' });
  assert.deepEqual(place('c', 'C', 2 * GB, 6 * GB, [r('a'), r(null), r('b')]), { index: 1, already: false, replaces: null, level: 'ok' });
});

test('one that does not fit beside them takes the place of the least recently used one that is not answering', () => {
  const p = place('c', 'C', 3 * GB, 2 * GB, [r('a', { usedAt: 50 }), r('b', { usedAt: 10, busy: true }), r('d', { usedAt: 30 })]);
  assert.deepEqual(p, { index: 2, already: false, replaces: 'd', level: 'ok' });
  // Every runner in use and none free: the least recently used goes, even when the new one would fit.
  const full = Array.from({ length: MAX_RUNNERS }, (_, i) => r(`m${i}`, { usedAt: 10 - i }));
  assert.deepEqual(place('x', 'X', 1 * GB, 50 * GB, full), { index: MAX_RUNNERS - 1, already: false, replaces: `m${MAX_RUNNERS - 1}`, level: 'ok' });
});

test('a swapped-out model frees its memory for the new one; too big even then is refused in plain words', () => {
  // 5 GB needed, 1 GB free, the one swapped out holds 4 GB: fits.
  assert.deepEqual(place('b', 'B', 5 * GB, 1 * GB, [r('a', { ram: 4 * GB })]), { index: 0, already: false, replaces: 'a', level: 'ok' });
  const no = place('b', 'Gemma 9B', 12 * GB, 1 * GB, [r('a', { name: 'A', ram: 4 * GB })]);
  assert.ok('error' in no);
  assert.match(no.error, /Gemma 9B needs about 12\.0 GB/);
  assert.match(no.error, /only 5\.0 GB is free once A is unloaded/);
  // Within 2 GB over is tight, not refused (the same line the model list's fit marks use).
  assert.deepEqual(place('b', 'B', 6.5 * GB, 1 * GB, [r('a', { ram: 4 * GB })]), { index: 0, already: false, replaces: 'a', level: 'tight' });
  assert.ok('error' in place('a', 'A', 9 * GB, 3 * GB, [r(null)]));
});

test('a model still loading or answering is never swapped out', () => {
  const loading = place('c', 'C', 4 * GB, 1 * GB, [r('a', { busy: true }), r('b', { name: 'B', state: 'loading' })], 2);
  assert.ok('error' in loading && /B is still loading/.test(loading.error));
  const busy = place('c', 'C', 4 * GB, 1 * GB, [r('a', { name: 'A', busy: true })], 1);
  assert.ok('error' in busy && /A is answering now/.test(busy.error));
  // Nothing to swap, but it fits beside within 2 GB: tight.
  assert.deepEqual(place('c', 'C', 2 * GB, 1 * GB, [r('a', { busy: true })]), { index: 1, already: false, replaces: null, level: 'tight' });
});

test('the main runner: the chat pane\'s model, else the first loaded, else the first', () => {
  assert.equal(mainIndex([r('a'), r('b')], 'b'), 1);
  assert.equal(mainIndex([r(null), r('b')], 'gone'), 1);
  assert.equal(mainIndex([r(null), r(null)], null), 0);
  assert.equal(mainIndex([r('a', { state: 'loading' }), r(null)], null), 0);
});

test('names read as a list', () => {
  assert.equal(namesOf([{ name: 'A' }]), 'A');
  assert.equal(namesOf([{ name: 'A' }, { name: 'B' }]), 'A and B');
  assert.equal(namesOf([{ name: 'A' }, { name: 'B' }, { name: 'C' }]), 'A, B and C');
});
