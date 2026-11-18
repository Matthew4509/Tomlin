// A lending PC only watches its free RAM (src/maxlend.ts MemoryWatch): a line when the loan starts, on a move of 2 GB and every 10 minutes, one
// line when it falls under the 4 GB it aims to keep free, and memory.low in its hello. It never ends a loan for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MemoryWatch } from '../src/maxlend.ts';

const GB = 2 ** 30;
const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');

test('free RAM is logged, said as RAM, at the start of the loan, on a move of 2 GB or more, and every 10 minutes otherwise', () => {
  const w = new MemoryWatch();
  assert.deepEqual(w.step(0, 24 * GB, 17 * GB, true), ['Lending: this PC has 17.0 GB of its 24.0 GB of RAM free.']);
  // A small change is not said, minute after minute.
  for (let m = 1; m < 10; m++) assert.deepEqual(w.step(m * 60_000, 24 * GB, 17 * GB - m * 0.1 * GB), [], `minute ${m}`);
  // Ten minutes on: one line, even with little change.
  assert.deepEqual(w.step(600_000, 24 * GB, 16 * GB), ['Lending: this PC has 16.0 GB of its 24.0 GB of RAM free.']);
  // A move of 2 GB since that line is said at once (a minute after the last line at the earliest).
  assert.deepEqual(w.step(630_000, 24 * GB, 13 * GB), []);
  assert.deepEqual(w.step(660_000, 24 * GB, 13 * GB), ['Lending: this PC has 13.0 GB of its 24.0 GB of RAM free.']);
  assert.deepEqual(w.step(720_000, 24 * GB, 14.5 * GB), []);
  // Up by 2 GB counts as well as down.
  assert.deepEqual(w.step(780_000, 24 * GB, 15 * GB), ['Lending: this PC has 15.0 GB of its 24.0 GB of RAM free.']);
  assert.equal(w.low, false);
});

test('a day of lending with steady RAM writes a few lines, not one a minute', () => {
  const w = new MemoryWatch();
  let n = w.step(0, 128 * GB, 113 * GB, true).length;
  for (let m = 1; m <= 24 * 60; m++) n += w.step(m * 60_000, 128 * GB, 113 * GB + (m % 3) * 0.3 * GB).length;
  assert.ok(n <= 24 * 6 + 1, `${n} lines`);
});

test('falling under the 4 GB aim is said once, sets low, and clears when RAM is back; it asks for nothing to end', () => {
  const w = new MemoryWatch();
  w.step(0, 24 * GB, 17 * GB, true);
  const lines = w.step(5_000, 24 * GB, 3.2 * GB);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^This PC's free memory is 3\.2 GB, under the 4\.0 GB it aims to keep free\. It keeps lending/);
  assert.equal(w.low, true);
  assert.deepEqual(w.step(6_000, 24 * GB, 3.0 * GB), []);
  assert.equal(w.low, true);
  // Just above the aim is not yet clear; half a GB above is.
  w.step(7_000, 24 * GB, 4.2 * GB);
  assert.equal(w.low, true);
  w.step(8_000, 24 * GB, 4.6 * GB);
  assert.equal(w.low, false);
  // And it can be said again if it falls again.
  assert.equal(w.step(9_000, 24 * GB, 2 * GB).length, 1);
  w.reset();
  assert.equal(w.low, false);
});

test('the watch is read by the lender and told in the hello; nothing in it ends a loan', () => {
  const lend = read('src/maxlend.ts');
  assert.match(lend, /this\.watchMemory\(true\)/);
  assert.match(lend, /private tick\(\): void \{\s*if \(!this\.lease\) return;\s*this\.watchMemory\(\);/);
  // The only things that end a loan are the existing ones.
  const watch = lend.slice(lend.indexOf('private watchMemory'), lend.indexOf('private tick'));
  assert.ok(!/this\.end\(/.test(watch));
  assert.match(read('src/jobrun/maxnode.ts'), /export const memoryLow = \(\) => lender\?\.memory\.low === true;/);
  assert.match(read('src/server/thispc.ts'), /\.\.\.\(memoryLow\(\) \? \{ low: true \} : \{\}\)/);
});
