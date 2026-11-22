// Network, Linked PCs: a "Fast update" button at the right of the heading, shown only while some linked PC can be updated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const js = readFileSync(join(ROOT, 'public', 'home.js'), 'utf8');
const css = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');

test('the button sits in the heading row of Linked PCs and is hidden until it is needed', () => {
  assert.match(html, /<div class="set-head">\s*<h3 id="node-linked-title">Linked PCs<\/h3>\s*<span class="net-linked-acts"><button class="btn" type="button" id="net-hw-scan"[^>]*>Scan for hardware changes<\/button>\s*<button class="btn primary fast-update" type="button" id="node-fast-update" hidden/);
  assert.match(css, /\.set-head \{[^}]*justify-content: space-between/);
});


test('it shows only while some linked PC can be updated now, and does what Update all does', () => {
  const draw = js.slice(js.indexOf('function drawUpdateAll(pcs)'), js.indexOf('// ---- The host PIN: one PIN for the linked PCs'));
  assert.match(draw, /fast\.hidden = !can\.length/);
  assert.match(draw, /Fast update \(\$\{can\.length\}\)/);
  // One runner for both buttons (and the left panel's): the host PIN is asked once, a PC without it asks its own PIN.
  assert.match(draw, /b\.onclick = updateAllLinked;\s*if \(fast\) fast\.onclick = updateAllLinked;/);
  const run = js.slice(js.indexOf('async function updateAllLinked()'), js.indexOf('/** The linked PCs this one can update now'));
  assert.match(run, /askHostPin\(/);
  assert.equal((run.match(/updatePcWithPin\(/g) ?? []).length, 1, 'one update loop, not two copies');
  assert.match(run, /'#rail-fast-update'/);
});

test('the left panel has the same Fast update at the right of its Linked PCs heading, hidden until a PC that answers is behind', () => {
  assert.match(html, /<div class="rail-head-row" id="rail-pcs-head">\s*<h2 class="rail-head" id="rail-pcs-title">Linked PCs<\/h2>\s*<button class="btn quiet rail-fast" type="button" id="rail-fast-update" hidden/);
  assert.match(js, /const behind = homeUi\.pcs\.filter\(p => p\.outdated && !p\.updating && p\.activity !== 'offline'\)\.length;/);
  assert.match(js, /railFast\.hidden = !behind;\s*railFast\.onclick = updateAllLinked;/);
  assert.match(css, /\.rail-head-row \{[^}]*justify-content: space-between/);
  assert.match(css, /\.rail-head-row \.rail-fast \{[^}]*font-size: 12px/);
});
