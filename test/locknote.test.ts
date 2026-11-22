// The unlock screen says where the PIN lock is turned off. Run: node --test test/locknote.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('a note under the keypad: where to disable the PIN lock', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const card = html.slice(html.indexOf('<form class="applock-card" id="applock-form">'), html.indexOf('</form>', html.indexOf('id="applock-form"')));
  assert.ok(card.indexOf('id="applock-pad"') < card.indexOf('id="applock-off-note"'), 'under the keypad');
  assert.match(card, /<p class="hint applock-off-note" id="applock-off-note">You can disable pin locks in Settings, Data and lock<\/p>/);
});
