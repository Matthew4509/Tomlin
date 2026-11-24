// A hire whose model is gone or whose PC is off: their own PC's models first, the network after Move to another PC;
// no "Until their PC is back" when the model itself is gone; one plain closing line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../public/backup.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('their own PC\'s models first; Move to another PC shows the network with its filters', () => {
  assert.match(js, /const own = \(homeUi\.data\?\.staff \?\? \[\]\)\.find\(s => s\.id === data\.hire\)\?\.pc \|\| 'This PC';/);
  assert.match(js, /let wide = !data\.choices\.some\(onOwn\);/, 'straight to the network when their PC has nothing');
  assert.match(js, /const shown = \(\) => data\.choices\.filter\(c => \(wide \? filtered\(c\) : onOwn\(c\)\)\);/);
  assert.match(js, /text: 'Move to another PC'/);
  assert.match(js, /chips\.hidden = !wide;\n\s+widen\.hidden = wide;/);
});

test('a gone model has no Until their PC is back, and the closing line is the plain one', () => {
  assert.match(js, /data\.gone \? \[go\('always'\)\] : \[go\('back'\), go\('always'\)\]/);
  assert.match(js, /text: 'This allows you to keep the chat, the history while changing the model or PC\.'/);
  assert.doesNotMatch(js, /the backup only lends its model/);
});

test('no Just this time button and no Fits their level filter', () => {
  assert.doesNotMatch(js, /Just this time|go\('once'\)/);
  assert.doesNotMatch(js, /chip\('level'|s level`/);
});
