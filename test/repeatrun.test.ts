// An answer that ends in one short piece written over and over ("xxxx…", "ha ha ha …") is cut as a loop
// (src/engine.ts sameRunCut inside repeatCut); a grid, a separator line or a long ordinary answer is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repeatCut, repeatWatch, SAME_RUN } from '../src/engine.ts';

test('one letter written thousands of times is cut where the run began, keeping its first 80 characters', () => {
  const said = 'First, the request word for word: ';
  assert.equal(repeatCut(said + 'x'.repeat(5000)), said + 'x'.repeat(80));
  // A short piece of a few characters, spaces included.
  const ha = 'That is funny. ' + 'ha '.repeat(1000);
  const cut = repeatCut(ha);
  assert.ok(cut !== null && cut.startsWith('That is funny. ha ha') && cut.length < 120);
});

test('the run is seen while the answer streams, long before it runs to its limit', () => {
  const watch = repeatWatch();
  let text = 'Here it is: ';
  let cut: string | null = null;
  while (cut === null && text.length < 20_000) {
    text += 'x'.repeat(40);
    cut = watch(text);
  }
  assert.ok(cut !== null, 'the run was cut');
  assert.ok(text.length < SAME_RUN * 3, `seen after ${text.length} characters`);
  assert.equal(cut, 'Here it is: ' + 'x'.repeat(80));
});

test('a long answer with no full stop is looked at quickly, so the app does not stand still while it streams', () => {
  // Words with no full stop, ! or ? and no new line (a long list, code outside a fence): 4 s for one look at 40,000
  // characters before, and about 38 s in all while such an answer streamed, with every page of the app waiting.
  const words: string[] = [];
  for (let i = 0; words.join(' ').length < 60_000; i++) words.push(`w${(i * 7919) % 100003}`);
  const t0 = performance.now();
  assert.equal(repeatCut(words.join(' ')), null);
  const one = performance.now() - t0;
  assert.ok(one < 200, `${Math.round(one)} ms for one look at 60,000 characters`);
  const watch = repeatWatch();
  let text = '';
  const t1 = performance.now();
  for (const w of words) {
    text += `${w} `;
    watch(text);
  }
  const all = performance.now() - t1;
  assert.ok(all < 3000, `${Math.round(all)} ms of looks while 60,000 characters streamed`);
  // A sentence that comes a third time is still cut where the second began.
  const s = 'The same sentence comes round again here. ';
  assert.equal(repeatCut(`Start. ${s}${s}${s}`), `Start. ${s}`.trimEnd());
});

test('a grid, a separator line, a table and a long ordinary answer are not cut', () => {
  const grid = 'Puzzle:\n' + Array.from({ length: 9 }, () => '[0, 0, 0, 0, 0, 0, 0, 0, 0],').join('\n') + '\nDone.';
  assert.equal(repeatCut(grid), null);
  assert.equal(repeatCut('Title\n' + '='.repeat(SAME_RUN - 100) + '\nText after the line.'), null);
  const table = '| a | b |\n|---|---|\n' + Array.from({ length: 200 }, (_, i) => `| ${i} | ${i * 2} |`).join('\n');
  assert.equal(repeatCut(table), null);
  const words: string[] = [];
  for (let i = 0; words.join(' ').length < 30_000; i++) words.push(`word${i}`);
  assert.equal(repeatCut(words.join(' ')), null);
  // A run that ended earlier, with ordinary words after it, is left alone: only a run still going is the loop.
  assert.equal(repeatCut('Start ' + '-'.repeat(SAME_RUN + 500) + ' ' + words.slice(0, 400).join(' ')), null);
});
