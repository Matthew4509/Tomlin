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

test('a card that starts with a block (Guest passes, the measured speeds) has room above its words', () => {
  assert.match(css, /\.set-card > \.set-block:first-child \{ padding: 14px 16px; \}/);
  const html = read('index.html');
  for (const id of ['guest-passes', 'cluster-speed']) {
    const part = html.slice(html.indexOf(`id="${id}"`), html.indexOf('</section>', html.indexOf(`id="${id}"`)));
    assert.match(part, /<div class="set-card">\s*<div class="set-block">/, `${id} starts with a block`);
  }
});

test('the host PIN says it is being given while a linked PC takes it', () => {
  const home = read('home.js');
  const give = home.slice(home.indexOf('async function giveHostPin('), home.indexOf("$('#host-pin-set').addEventListener"));
  assert.ok(give.indexOf('hostPinSay(`Giving the host PIN to "${p.name}"…`);') < give.indexOf("await api('/api/network/host-pin', { action: 'give'"));
});

test('a guest pass does not say a linked PC never answered when it simply has no models', () => {
  const home = read('home.js');
  assert.doesNotMatch(home, /it has not answered since it was linked\)/);
  assert.match(home, /'No models there yet, or it has not answered since it was linked\.'/);
});

test('This PC lists every permission a linked PC may have, and says turning it off starts ticked', () => {
  const html = read('index.html');
  const row = html.slice(html.indexOf('<b>What linked PCs may do here</b>'), html.indexOf('</span></span>', html.indexOf('<b>What linked PCs may do here</b>')));
  assert.match(row, /and turn it off\. Each is a tick, off until you tick it, except turning it off, which is on until you untick it\./);
  // The tick itself: on unless its owner turns it off (home.js drawNodeAllow's default).
  assert.match(read('home.js'), /receive: false, give: false, off: true \}/);
});

test('a line of Help\'s "On this page" takes the keyboard to its part, after the page\'s own focus', () => {
  const view = read('chatview.js');
  const open = view.slice(view.indexOf('function openHelp('), view.indexOf('app.openHelp = openHelp;'));
  assert.match(open, /setTimeout\(\(\) => \{\n\s*if \(!at\.hasAttribute\('tabindex'\)\) at\.setAttribute\('tabindex', '-1'\);\n\s*at\.focus\(\{ preventScroll: true \}\);/);
  assert.ok(open.indexOf("setView('help')") < open.indexOf('setTimeout('), 'queued after setView queues the title focus');
});
