// The lock screen reads in the usual order: the PIN box, then Unlock at its right. "Send host" below keeps its own order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const css = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');

test('the PIN box comes first and Unlock sits at its right', () => {
  assert.match(html, /<div class="applock-row applock-pin-row">\s*<input id="applock-open-pin"[^>]*>\s*<button class="btn primary" type="submit" id="applock-open">Unlock<\/button>\s*<\/div>/);
  assert.match(css, /\.applock-row\.applock-pin-row \{ grid-template-columns: minmax\(0, 1fr\) 7\.5rem; \}/);
  // The node's ask row is unchanged: its button, then the choice.
  assert.match(html, /<div class="applock-row" id="applock-ask-row">\s*<button class="btn" type="button" id="applock-ask">Send host<\/button>/);
});
