// An update going to a linked PC runs on the server, so its window can be closed. While it goes: the PC's card in the
// left panel turns a wheel in place of the yellow (!) and opens the steps again; Network and the PC's window say
// "Updating" with See progress, never Update it a second time; Fast update leaves that PC out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transfers, updatingTo } from '../src/jobrun/copies.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const home = read('public', 'home.js');
const net = read('public', 'network.js');
const pcs = read('public', 'pcs.js');
const view = read('public', 'homeview.js');
const html = read('public', 'index.html');
const css = read('public', 'style.css');

test('updatingTo names the update or pull under way for that PC only, and nothing once it has ended', async () => {
  let finish!: () => void;
  const held = new Promise<void>(r => (finish = r));
  const t = transfers.start({ kind: 'update', what: 'TOMLIN 9.9.9', pc: 'pc-a1', pcName: 'Worker PC' }, async () => {
    await held;
    return '';
  });
  assert.ok(!('error' in t));
  assert.deepEqual(updatingTo('pc-a1'), { id: t.id, kind: 'update', what: 'TOMLIN 9.9.9' });
  assert.equal(updatingTo('pc-b2'), null, 'another PC is not updating');
  // A second update to the same PC is refused while the first goes.
  const again = transfers.start({ kind: 'update', what: 'TOMLIN 9.9.9', pc: 'pc-a1', pcName: 'Worker PC' }, async () => '');
  assert.ok('error' in again && /busy/.test(again.error));
  finish();
  for (let i = 0; i < 50 && updatingTo('pc-a1'); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(updatingTo('pc-a1'), null);
});

test('a copy of a model to that PC is not an update', async () => {
  let finish!: () => void;
  const held = new Promise<void>(r => (finish = r));
  transfers.start({ kind: 'send', what: 'a model', pc: 'pc-c3', pcName: 'Worker PC' }, async () => {
    await held;
    return '';
  });
  assert.equal(updatingTo('pc-c3'), null);
  finish();
});

test('the PC lists carry it: the left panel, Network and the PC window', () => {
  assert.match(read('src', 'jobrun.ts'), /updating: updatingTo\(r\.id\)/);
  assert.match(read('src', 'server', 'thispc.ts'), /updating: jobRoutes\.updatingTo\(r\.id\)/);
  assert.match(read('src', 'server', 'costs.ts'), /updating: here \? null : jobRoutes\.updatingTo\(key\)/);
});

test('the left panel: a turning wheel in place of the yellow (!), and the card opens the steps again', () => {
  assert.match(home, /updating \? el\('span', \{ class: 'rail-name has-flag' \}[^\n]*class: 'net-spin rail-spin'/);
  assert.match(home, /const flag = \[upd \? '' : old, full\]/, 'the (!) for "behind" goes while it updates');
  assert.match(home, /onClick: \(\) => \(p\.updating \? app\.showUpdate\?\.\(p\.updating\.id\) : app\.openPc\?\.\(p\.id\)\)/);
  assert.match(css, /\.net-spin\.rail-spin \{/);
  // Drawn again at once when an update starts or its window closes, and every 3 seconds while one goes.
  assert.match(view, /app\.refreshPcs = refreshPcs;/);
  assert.match(view, /if \(homeUi\.pcs\?\.some\(p => p\.updating\)\) refreshPcs\(\);/);
  assert.match(net, /app\.refreshPcs\?\.\(\);\s*updDlg\.addEventListener\('close'/);
});

test('Network and the PC window say Updating with See progress, not Update it a second time', () => {
  assert.match(home, /p\.updating \? el\('div', \{ class: 'node-update' \}/);
  assert.match(home, /text: 'See progress', 'data-key': `updating:\$\{p\.id\}`, onclick: \(\) => app\.showUpdate\?\.\(p\.updating\.id\)/);
  assert.match(home, /p\.ok && p\.update && !p\.updating \? el\('div'/);
  assert.match(home, /p\.ok && p\.pull && !p\.updating \? el\('div'/);
  assert.match(pcs, /if \(v\.updating\) \{\s*go = el\('button', \{ class: 'btn primary', type: 'button', text: 'See progress'/);
  assert.match(pcs, /if \(older && !v\.update\.why && !v\.updating\) \{/);
  // The Models on my other PCs window: an update shows in its PC's cell of the grid (See progress there, public/pcgrid.js);
  // a pull (this PC taking an update) keeps its row with See progress.
  assert.match(net, /const rows = list\.filter\(t => t\.kind !== 'update'\);/);
  assert.match(net, /working && t\.kind === 'pull' \? el\('button'[^\n]*text: 'See progress'/);
});

test('Fast update and Update all leave out a PC already being updated', () => {
  assert.match(home, /p\.outdated && !p\.updating && p\.activity !== 'offline'/);
  assert.match(home, /filter\(p => p\.ok && p\.update && !p\.update\.why && !p\.updating\);\s*\} catch/);
  assert.match(home, /const can = pcs\.filter\(p => p\.ok && p\.update && !p\.update\.why && !p\.updating\);/);
});

test('the steps screen says it is safe to close, and how to see it again', () => {
  assert.match(html, /id="upd-keep">Safe to close this window: the update carries on\./);
  assert.doesNotMatch(html, /id="upd-keep">Keep this window open/);
  assert.match(net, /app\.showUpdate = async id => \{/);
});
