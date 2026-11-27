// The PC status grid (public/pcgrid.js): a mark then a name per linked PC, green / yellow / red / grey / turning, its
// specs on hover and keyboard focus, a summary line whose counts filter the grid, one Update all outdated, and progress
// in the cells (an update is no longer a row of its own in Models on my other PCs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = read('pcgrid.js');
const sandbox: { window: { pcGrid?: any } } = { window: {} };
runInNewContext(code, sandbox);
const g = sandbox.window.pcGrid;
// Arrays made inside the sandbox are of its own realm: compared as plain data.
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

const up = { id: 'a', name: 'Z820', ok: true, version: '2.1.26', update: null };
const old = { id: 'b', name: 'HP 800', ok: true, version: '2.1.20', update: { why: '', mine: '2.1.26' } };
const off = { id: 'c', name: 'Laptop', ok: false, seenAt: null };
const refused = { id: 'd', name: 'Worker PC', ok: false, relink: true, error: 'that PC no longer knows this one' };

test('each PC gets one state: up to date, outdated, off, a fault, or busy while a transfer runs', () => {
  assert.equal(g.stateOf(up).state, 'ok');
  assert.equal(g.stateOf(old).state, 'old');
  assert.equal(g.stateOf(old).why, 'runs 2.1.20, this PC 2.1.26');
  assert.equal(g.stateOf(off).state, 'off');
  assert.equal(g.stateOf({ ...up, away: '2026-11-26T10:00:00Z' }).state, 'off');
  const r = g.stateOf(refused);
  assert.equal(r.state, 'error');
  assert.equal(r.why, 'that PC no longer knows this one');
  const sending = [{ id: 't1', pc: 'b', kind: 'update', state: 'working', what: 'TOMLIN 2.1.26', bytes: 4 * 2 ** 20, done: 2 ** 20 }];
  const busy = g.stateOf(old, sending);
  assert.equal(busy.state, 'busy');
  assert.equal(busy.word, 'Updating');
  assert.deepEqual(plain(busy.doing), ['Updating to TOMLIN 2.1.26: 1 MB of 4 MB (25%)']);
  // A copy to it is busy, not "updating".
  const copy = g.stateOf(up, [{ id: 't2', pc: 'a', kind: 'send', state: 'working', what: 'Qwen3.5-9B', bytes: 0, done: 0 }]);
  assert.equal(copy.state, 'busy');
  assert.equal(copy.word, 'Busy');
  // Its own updating flag (from /api/nodes/others) turns it too, without the transfer list.
  assert.equal(g.stateOf({ ...old, updating: { id: 't1', what: 'TOMLIN 2.1.26' } }).state, 'busy');
});

test('a failed update while the PC is still behind is red, with the transfer for See progress and Retry', () => {
  const failed = [{ id: 't3', pc: 'b', kind: 'update', state: 'failed', what: 'TOMLIN 2.1.26', said: 'it did not start the new version' }, { id: 't0', pc: 'b', kind: 'update', state: 'done', what: 'TOMLIN 2.1.25' }];
  const s = g.stateOf(old, failed);
  assert.equal(s.state, 'error');
  assert.equal(s.why, 'it did not start the new version');
  assert.equal(s.failed.id, 't3');
  // Once it is up to date the old failure no longer counts.
  assert.equal(g.stateOf(up, failed.map(t => ({ ...t, pc: 'a' }))).state, 'ok');
});

test('the summary counts each kind in order and leaves out the zeros', () => {
  const states = [g.stateOf(up), g.stateOf(up), g.stateOf(old), g.stateOf(off), g.stateOf({ ...old, updating: { id: 'x', what: 'TOMLIN 2.1.26' } })];
  const s = g.summary(states);
  assert.equal(`${s.head}: ${s.parts.map((p: { text: string }) => p.text).join(', ')}`, '5 PCs: 2 up to date, 1 updating, 1 outdated, 1 off');
  assert.deepEqual(plain(s.parts.map((p: { state: string }) => p.state)), ['ok', 'busy', 'old', 'off']);
  assert.equal(g.summary([g.stateOf(up)]).head, '1 PC');
});

test('the specs: computer name, processor and threads, RAM, card and its memory, version, free on the models drive, model, now', () => {
  const p = { ...old, cpu: { name: 'Xeon E5-2670', cores: 16, threads: 32 }, memory: { ram: { total: 256 * 2 ** 30 }, gpu: { name: 'RTX 3060', total: 12 * 2 ** 30 } }, build: 'abc1234', modelsDrive: 'D:', drives: [{ drive: 'D:', free: 900 * 2 ** 30 }], model: 'Qwen3.5-9B' };
  assert.deepEqual(plain(g.specLines(p, 'DESKTOP-7Q4M2KD', g.stateOf(p))), [
    'Older TOMLIN: runs 2.1.20, this PC 2.1.26',
    'Computer name: DESKTOP-7Q4M2KD',
    'Processor: Xeon E5-2670, 16 cores, 32 threads',
    'RAM: 256 GB',
    'Graphics card: RTX 3060, 12 GB',
    'TOMLIN 2.1.20 (build abc1234)',
    'Free on its models drive (D:): 900 GB',
    'Model loaded: Qwen3.5-9B',
  ]);
  // An off PC says only what is known.
  assert.deepEqual(plain(g.specLines(off, '', g.stateOf(off))), ['Off or not answering']);
});

test('the cells: mark before the name, its word for screen readers, a tip shown on hover and on focus; 4, 3, 2, 1 across', () => {
  assert.match(code, /el\('span', \{ class: 'pcg-mark', 'data-state': st\.state, 'aria-hidden': 'true' \}\),\n\s+el\('span', \{ class: 'sr-only', text: `\$\{st\.word\}: ` \}\),\n\s+el\('span', \{ class: 'pcg-name', text: name\(p\) \}\)\);/);
  assert.match(code, /'aria-describedby': tipId/);
  assert.match(code, /el\('span', \{ class: 'pcg-tip', role: 'tooltip', id: tipId \}/);
  assert.match(code, /text: `Update all outdated \(\$\{can\.length\}\)`/);
  assert.match(code, /text: 'See progress', onclick: \(\) => app\.openUpdate\?\.\(st\.failed\)/);
  assert.match(code, /text: 'Retry'/);
  const css = read('style.css');
  const block = css.slice(css.indexOf('/* The PC status grid'));
  assert.match(block, /\.pcg-grid \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(block, /@media \(max-width: 1100px\) \{ \.pcg-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \} \}/);
  assert.match(block, /@media \(max-width: 760px\) \{ \.pcg-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \} \}/);
  assert.match(block, /@media \(max-width: 480px\) \{ \.pcg-grid \{ grid-template-columns: minmax\(0, 1fr\); \} \}/);
  assert.match(block, /\.pcg-item:hover \.pcg-tip, \.pcg-cell:focus-visible \+ \.pcg-tip \{ display: block; \}/);
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i, 'colours by the page\'s own names');
  for (const m of block.matchAll(/font-size: (\d+)px/g)) assert.ok(Number(m[1]) >= 12, m[0]);
});

test('it is drawn in Models on my other PCs and on Network, from the lists already read; an update is not a row of its own', () => {
  const html = read('index.html');
  assert.ok(html.indexOf('<script src="pcgrid.js">') > 0 && html.indexOf('<script src="pcgrid.js">') < html.indexOf('<script src="network.js">'));
  assert.match(html, /<h3>Linked PCs<\/h3>\n\s+<div class="pcg" id="net-grid"><\/div>\n\s+<div class="net-list" id="net-transfers"/);
  assert.match(html, /<div class="pcg" id="node-grid"><\/div>/);
  const net = read('network.js');
  assert.match(net, /window\.pcGrid\?\.draw\(\$\('#net-grid'\), netPcsLast, netLast,/);
  assert.match(net, /netPcsLast = \(await api\('\/api\/nodes\/others'\)\)\.pcs \?\? \[\];/);
  assert.match(net, /const rows = list\.filter\(t => t\.kind !== 'update'\);/);
  const home = read('home.js');
  assert.match(home, /window\.pcGrid\?\.draw\(\$\('#node-grid'\), pcs\.filter\(p => p\.role !== 'guest'\), homeUi\.transfers \?\? \[\],/);
  assert.match(home, /api\('\/api\/network\/transfers'\)\.catch\(\(\) => null\)/);
});

test('Updating linked PCs: a short tip (state, CPU, RAM, GPU) that floats over the page, in a wide window', () => {
  const G = 2 ** 30;
  const st = { word: 'Up to date', why: '' };
  assert.deepEqual(plain(g.briefLines({ cpu: { name: 'Intel(R) Xeon(R) CPU E5-2690 v2 @ 3.00GHz', threads: 20 }, memory: { ram: { total: 64 * G }, gpu: { name: 'NVIDIA GeForce RTX 3060', total: 12 * G } } }, st)),
    ['Up to date', 'CPU: Intel Xeon E5-2690 v2, 20 threads', 'RAM: 64 GB', 'GPU: GeForce RTX 3060, 12 GB']);
  // A PC that has told nothing (off): its state only, not "GPU: none".
  assert.deepEqual(plain(g.briefLines({}, { word: 'Off', why: '' })), ['Off']);
  assert.deepEqual(plain(g.briefLines({ memory: { ram: { total: 8 * G } } }, st)), ['Up to date', 'RAM: 8.0 GB', 'GPU: none']);
  // Fixed and placed by its cell, so showing it never moves the layout or adds scroll bars to a window.
  assert.match(code, /item\.addEventListener\('mouseenter', place\);/);
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.pcg-tip \{ display: none; position: fixed; z-index: 1000;/);
  assert.match(css, /dialog#upds-dlg \{[^}]*width: min\(1100px, 96vw\)/);
  assert.match(read('network.js'), /onChanged: updsRead, brief: true \}\);/);
});
