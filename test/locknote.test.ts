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

test('"Use a recovery code" is words only, centred, the size of the note above it', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(html, /<button class="link lock-recover-open" type="button" id="applock-recover-open" hidden>Use a recovery code<\/button>/);
  assert.match(css, /\.lock-recover-open \{ align-self: center; font-size: var\(--fs-sm\); \}/);
  assert.match(css, /\.hint \{[^}]*font-size: var\(--fs-sm\)/);
});
