// Faults found walking Network, the Cluster page, Help and the PC windows on a throwaway copy, at 1200 and 400 px wide,
// kept fixed here. Read from the page's own files. Run: node --test test/pageswalk.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = read('style.css');

test('a linked PC tile is wide enough for its memory lines, and a long card name puts its figures under it', () => {
  // Three across in the 820px Network page made each tile about 240px: "Graphics card (Quadro P2000)" went one word a line.
  assert.match(css, /\.node-tiles \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 280px\), 1fr\)\); gap: 12px; \}/);
  assert.doesNotMatch(css, /\.node-tiles \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /\.mbar-box\.mbar-short \{ display: flex; flex-wrap: wrap; gap: 4px 12px; \}/);
  assert.match(css, /\.mbar-short > \.mbar \{ flex: 0 0 100%; \}/);
});

test('a card that starts with a block has room above its words; Guest passes starts with its switch row, as Node does', () => {
  assert.match(css, /\.set-card > \.set-block:first-child \{ padding: 14px 16px; \}/);
  const html = read('index.html');
  const part = html.slice(html.indexOf('id="guest-passes"'), html.indexOf('</section>', html.indexOf('id="guest-passes"')));
  assert.match(part, /<div class="set-card">\s*<div class="set-row">/, 'guest-passes starts with its switch row');
});

test('a guest pass does not say a linked PC never answered when it simply has no models', () => {
  const home = read('home.js');
  assert.doesNotMatch(home, /it has not answered since it was linked\)/);
  assert.match(home, /'No models there yet, or it has not answered since it was linked\.'/);
});

test('This PC has every permission a linked PC may have as its tick, and turning it off starts ticked', () => {
  const html = read('index.html');
  const thispc = html.slice(html.indexOf('<section class="nodes" id="thispc"'), html.indexOf('\n</section>\n', html.indexOf('<section class="nodes" id="thispc"')));
  for (const k of ['pull', 'receive', 'backup', 'update', 'tune', 'off', 'peer', 'give', 'lend']) assert.match(thispc, new RegExp(`data-allow="${k}"`), k);
  // The tick itself: on unless its owner turns it off (home.js drawNodeAllow's default).
  assert.match(read('home.js'), /receive: false, give: false, off: true \}/);
});

test('a Help button takes the person to its topic: the frame is pointed at it, and an old section name is sent on by Help\'s own script', () => {
  const view = read('chatview.js');
  const open = view.slice(view.indexOf('function openHelp('), view.indexOf('app.openHelp = openHelp;'));
  assert.match(open, /frame\.src = `help\/index\.html\?go=\$\{encodeURIComponent\(part\)\}`/);
  assert.ok(open.indexOf("setView('help')") < open.indexOf('frame.src'), 'the page is up before the frame moves');
  assert.match(read('help/help.js'), /location\.replace\(map\.aliases\[go\]\)/);
});
