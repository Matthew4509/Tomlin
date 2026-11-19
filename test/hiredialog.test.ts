import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

test('the hired window opens at once: the speed-test check is not awaited before it', () => {
  const team = read('team.js');
  assert.ok(!/await askStartChat\(hired, await /.test(team));
  assert.match(team, /has not been speed tested yet\./);
  assert.match(team, /You can chat or choose to optimize\./);
  assert.match(team, /text: 'Optimize'/);
});

test('the Optimize window: Start the test left, Skip, open chat right, a running test says it carries on', () => {
  const finder = read('finder.js');
  assert.match(finder, /Skip, open chat/);
  assert.match(finder, /finder-right/);
  assert.match(finder, /You can close this window; the test continues in the background\./);
  assert.ok(!/Close \(it carries on\)/.test(finder));
});
