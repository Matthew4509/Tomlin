import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const { diff, patch } = await load('diff.js');

const lcs = (a, b) => {
  const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) t[i][j] = a[i - 1] === b[j - 1] ? t[i - 1][j - 1] + 1 : Math.max(t[i - 1][j], t[i][j - 1]);
  return t[a.length][b.length];
};
let seed = 12345;
const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const lines = (n, k) => Array.from({ length: n }, () => String.fromCharCode(97 + rnd(k)));

test('the ops are keep, add and del, and rebuild both sides', () => {
  const a = ['one', 'two', 'three'], b = ['one', 'TWO', 'three', 'four'];
  const ops = diff(a, b);
  for (const o of ops) assert.ok(['keep', 'add', 'del'].includes(o.op) && typeof o.line === 'string');
  assert.deepEqual(ops.filter(o => o.op !== 'add').map(o => o.line), a);
  assert.deepEqual(ops.filter(o => o.op !== 'del').map(o => o.line), b);
});
test('identical and empty inputs', () => {
  assert.deepEqual(diff([], []), []);
  assert.deepEqual(diff(['x'], ['x']), [{ op: 'keep', line: 'x' }]);
  assert.deepEqual(diff([], ['x']), [{ op: 'add', line: 'x' }]);
  assert.deepEqual(diff(['x'], []), [{ op: 'del', line: 'x' }]);
});
test('300 random pairs: both sides rebuild and the edit is as short as it can be', () => {
  for (let n = 0; n < 300; n++) {
    const a = lines(rnd(14), 3), b = lines(rnd(14), 3);
    const ops = diff(a, b);
    assert.deepEqual(ops.filter(o => o.op !== 'add').map(o => o.line), a, `a, case ${n}`);
    assert.deepEqual(ops.filter(o => o.op !== 'del').map(o => o.line), b, `b, case ${n}`);
    const edits = ops.filter(o => o.op !== 'keep').length;
    assert.equal(edits, a.length + b.length - 2 * lcs(a, b), `not minimal, case ${n}: ${a.join('')} -> ${b.join('')}`);
  }
});
test('patch applies the ops to the old lines to give the new ones', () => {
  for (let n = 0; n < 50; n++) {
    const a = lines(rnd(20), 4), b = lines(rnd(20), 4);
    assert.deepEqual(patch(a, diff(a, b)), b);
  }
});
test('patch refuses ops that do not fit the lines it is given', () => {
  const ops = diff(['a', 'b'], ['a', 'c']);
  assert.throws(() => patch(['z', 'b'], ops), Error);
});
test('a 5,000-line file with a few changes is diffed quickly', () => {
  const a = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
  const b = a.slice();
  b[10] = 'changed'; b.splice(2500, 3); b.splice(4000, 0, 'new one', 'new two');
  const t = Date.now();
  const ops = diff(a, b);
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
  assert.equal(ops.filter(o => o.op !== 'keep').length, 2 + 3 + 2);
});
