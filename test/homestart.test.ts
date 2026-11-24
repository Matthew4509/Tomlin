// Home: Getting started? (three steps) above the greeting, the hover help on Project name and Mini description, and
// Manage's large pictures with Scan's radar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('Getting started? sits above the greeting: 1 Hire staff, 2 Install a model, 3 Start chatting', () => {
  const html = read('index.html');
  const start = html.indexOf('id="home-start"');
  assert.ok(start > 0 && start < html.indexOf('<h2 id="home-title">'), 'above the greeting');
  const box = html.slice(start, html.indexOf('</section>', start));
  assert.match(box, /<h3 id="home-start-title">Getting started\?<\/h3>/);
  assert.deepEqual([...box.matchAll(/home-start-n" aria-hidden="true">(\d)<\/span><button class="btn" type="button" id="home-start-(\w+)">([^<]+)</g)].map(m => [m[1], m[2], m[3]]),
    [['1', 'hire', 'Hire staff'], ['2', 'model', 'Install a model'], ['3', 'chat', 'Start chatting']]);
  const view = read('homeview.js');
  assert.match(view, /\$\('#home-start-hire'\)\.addEventListener\('click', \(\) => app\.openHire\?\.\(\{ page: true \}\)\);/);
  assert.match(view, /\$\('#home-start-model'\)\.addEventListener\('click', \(\) => app\.openModels\?\.\(\)\);/);
  assert.match(view, /\$\('#home-start-chat'\)\.addEventListener\('click', \(\) => \$\('#rail-new'\)\.click\(\)\);/);
});

test('hovering Project name says it names the folder, and shows the folder the typed name makes', () => {
  const html = read('index.html');
  assert.match(html, /<label class="field" id="home-name-field" title="[^"]*names the project's folder[^"]*"><span>Project name \(optional\)<\/span>/);
  assert.match(html, /<label class="field" id="home-about-field" title="[^"]*Scope card[^"]*"><span>Mini description \(optional\)<\/span>/);
  const view = read('homeview.js');
  const fn = view.match(/function folderFromName[\s\S]*?\n}\n/)![0];
  const folderFromName = new Function('folderNow', `${fn}; return folderFromName;`)(() => 'STAMP');
  assert.equal(folderFromName('Harbour: Bakery/2?'), 'Harbour Bakery 2', 'as the server makes it (src/jobs.ts projectFolderFrom)');
  assert.equal(folderFromName('jobs'), 'STAMP');
  assert.equal(folderFromName('!!!'), 'STAMP');
  assert.equal(folderFromName('My tip calculator for the café on the corner of Main St'), 'My tip calculator for the café on the');
});

test('Manage draws its pictures large, and Scan is a radar dish sending waves out (still for less motion)', () => {
  const m = read('manage.js');
  assert.match(m, /width: 40, height: 40/);
  assert.match(m, /const ICON_SCAN = \[[^\n]*'wave wave-1'[^\n]*'wave wave-3'\]\];/);
  const css = read('style.css');
  assert.match(css, /\.manage-tile > \.set-tile \{ width: 64px; height: 64px;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.manage-tile \.wave \{ animation: none; \} \}/);
});

test('Getting started? is drawn first on Home: Home pulls its head and form up with order, so it goes earlier still', () => {
  assert.match(read('style.css'), /\.home-main > \.home-start, \.home > \.home-start \{ order: -3; \}/);
});

test('Home\'s right panel: Urgent | Staff overview, To Do hidden, and it starts hidden behind an arrow as the chat\'s does', () => {
  const html = read('index.html');
  assert.match(html, /<span id="home-waiting-title">Urgent<\/span>/);
  assert.match(html, /<span class="side-tab-bar" aria-hidden="true" hidden>\|<\/span><button class="side-tab" type="button" role="tab" id="tab-home-todo" hidden/);
  assert.match(html, /<span class="subjects-arrow home-side-open" aria-hidden="true"><svg/);
  assert.match(html, /<span class="home-side-close" aria-hidden="true"><svg/);
  const home = read('home.js');
  assert.match(home, /\$\('#home-side-fold'\)\.open = store\('home-waiting-open'\) === '1';/);
  assert.match(home, /const homeTabs = \[\$\('#tab-waiting'\), \$\('#tab-home-staff'\), \$\('#tab-home-todo'\)\]\.filter\(t => !t\.hidden\);/);
  const css = read('style.css');
  assert.match(css, /\.home-side\.folded \.home-side-open \{ display: inline-flex; \}/);
  assert.doesNotMatch(css, /\.home-side-sum::after \{ content: "Hide"/);
  for (const f of ['mute.js', 'owner.js', 'queue.js', 'help/queue.html', 'help/office.html']) assert.doesNotMatch(read(f), /Waiting for you/, f);
});
