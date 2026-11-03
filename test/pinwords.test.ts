// The app lock PIN box's button says what pressing it does (3 Nov, the owner: "Change it" on "Type the app lock PIN of
// 'Worker PC'" read as changing the PIN, not going on with the update). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the PIN box\'s button names the update for another PC, and the change for this one, never "Change it"', () => {
  const html = read('public/index.html');
  const form = html.slice(html.indexOf('id="node-pin-form"'), html.indexOf('</form>', html.indexOf('id="node-pin-form"')));
  assert.doesNotMatch(form, />Change it</);
  assert.match(form, /<button class="btn primary" type="submit" id="node-pin-ok">/);
  const js = read('public/home.js');
  assert.match(js, /\$\('#node-pin-ok'\)\.textContent = other \? `Update "\$\{other\}"` : 'Apply the change';/);
});
