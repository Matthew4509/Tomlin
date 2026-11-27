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
  const draw = js.slice(js.indexOf('function drawUpdateAll(pcs)'), js.indexOf('// ---- The admin PC (src/hostpin.ts HostKey'));
  assert.match(draw, /fast\.hidden = !can\.length/);
  assert.match(draw, /Fast update \(\$\{can\.length\}\)/);
  // One runner for both buttons (and the left panel's): a PC without this PC's admin key asks its own PIN.
  assert.match(draw, /b\.onclick = updateAllLinked;\s*if \(fast\) fast\.onclick = updateAllLinked;/);
  const run = js.slice(js.indexOf('async function updateAllLinked()'), js.indexOf('/** The linked PCs this one can update now'));
  assert.doesNotMatch(run, /askHostPin\(|host-pin/, 'no typed host PIN (2.1.31)');
  assert.equal((run.match(/updatePcWithPin\(/g) ?? []).length, 1, 'one update loop, not two copies');
  assert.match(run, /'#rail-fast-update'/);
});

test('the left panel has Manage at the right of its Linked PCs heading, with how many are behind when some are', () => {
  assert.match(html, /<div class="rail-head-row" id="rail-pcs-head">\s*<h2 class="rail-head" id="rail-pcs-title">Linked PCs<\/h2>\s*<button class="btn quiet rail-fast" type="button" id="rail-fast-update" hidden/);
  assert.match(js, /const behind = homeUi\.pcs\.filter\(p => p\.outdated && !p\.updating && p\.activity !== 'offline'\)\.length;/);
  assert.match(js, /railFast\.hidden = !homeUi\.pcs\.length;\s*railFast\.onclick = \(\) => app\.openManage\?\.\(\);/);
  assert.match(css, /\.rail-head-row \{[^}]*justify-content: space-between/);
  assert.match(css, /\.rail-head-row \.rail-fast \{[^}]*font-size: 12px/);
});

test('the left panel\'s Manage: a yellow ! when linked PCs are behind, the count only on hover', () => {
  const js = readFileSync(new URL('../public/home.js', import.meta.url), 'utf8');
  assert.match(js, /railFast\.replaceChildren\('Manage', \.\.\.\(behind \? \[el\('span', \{ class: 'rail-flag', role: 'img', 'aria-label': toUpdate, title: toUpdate, text: '!' \}\)\] : \[\]\)\);/);
  assert.doesNotMatch(js, /to update\)`/, 'no "(2 to update)" in the label');
});

test('Update all and Fast update open a window of their own with only the linked PCs, not Models on my other PCs', () => {
  const run = js.slice(js.indexOf('async function updateAllRun('), js.indexOf('// The top of the Network page'));
  assert.match(run, /app\.openUpdates\?\.\(\);/);
  assert.doesNotMatch(run, /app\.openNet/);
  const dlg = html.slice(html.indexOf('<dialog id="upds-dlg"'), html.indexOf('</dialog>', html.indexOf('<dialog id="upds-dlg"')));
  assert.match(dlg, /<h2 id="upds-title">Updating linked PCs<\/h2>/);
  assert.match(dlg, /<h3>Linked PCs<\/h3>\s*<div class="pcg" id="upds-grid"><\/div>/);
  assert.doesNotMatch(dlg, /Shared by linked PCs|Restore points|net-rows|net-backups/);
  const net = readFileSync(join(ROOT, 'public', 'network.js'), 'utf8');
  assert.match(net, /app\.openUpdates = async \(\) => \{/);
  assert.match(net, /window\.pcGrid\?\.draw\(\$\('#upds-grid'\)/);
});
