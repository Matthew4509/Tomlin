// The owner's menu and Settings page (drawn in docs/mockups/settings-tiles.html, approved 2 Nov): TOMLIN - HOME, then
// Settings with its submenu under it; pressing Settings opens tiles, one short sentence each, low priority on the last
// row. Read from the page's own files; walked in the browser on a throwaway copy. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const html = read('index.html');
const menu = html.slice(html.indexOf('id="rail-setup-fold"'), html.indexOf('</nav>'));
const sub = menu.slice(menu.indexOf('id="rail-settings-sub"'));

/** The submenu's lines, in order: what each opens, its words and its tile's sentence. */
const lines = [...sub.matchAll(/data-setup="(\w+)" data-about="([^"]+)"><svg.*?<\/svg>([^<]+)<\/button>/g)].map(m => ({ opens: m[1], about: m[2], name: m[3] }));

test('the left menu says TOMLIN - HOME, then Settings, with the submenu under Settings', () => {
  assert.match(menu, /id="rail-setup-home">.*TOMLIN - HOME<\/button>/);
  assert.match(menu, /data-setup="settings">.*Settings<\/button>/);
  assert.doesNotMatch(menu, /Set up/);
  assert.ok(menu.indexOf('TOMLIN - HOME') < menu.indexOf('data-setup="settings"'));
  assert.ok(menu.indexOf('data-setup="settings"') < menu.indexOf('id="rail-settings-sub"'));
});

test('nine lines in the order drawn: the low-priority three last, Colours at the very end', () => {
  assert.deepEqual(lines.map(l => l.name), ['Hire staff', 'Models', 'Network', 'This PC', 'Jobs', 'Files and blog writer', 'Updates', 'Data and lock', 'Colours']);
  assert.deepEqual(lines.map(l => l.opens), ['staff', 'models', 'nodes', 'thispc', 'jobs', 'files', 'update', 'data', 'colours']);
});

test('each has one short sentence', () => {
  for (const l of lines) {
    assert.ok(l.about.length <= 62, `${l.name}: ${l.about}`);
    assert.equal(l.about.match(/\./g)?.length, 1, l.about);
    assert.match(l.about, /\.$/);
  }
  assert.match(lines.find(l => l.name === 'Data and lock')!.about, /alerts and web search/);
});

test('the tiles are made from the submenu, so the two always match', () => {
  assert.match(html, /<div class="settings-tiles" id="settings-tiles"><\/div>/);
  const view = read('homeview.js');
  assert.match(view, /document\.querySelectorAll\('#rail-settings-sub \[data-setup\]'\)/);
  assert.match(view, /\$\('#settings-tiles'\)\.replaceChildren\(/);
  assert.match(view, /dataset\.about/);
  // Three across, so the last row is the low-priority three; fewer only on a narrow screen.
  assert.match(read('style.css'), /\.settings-tiles \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});

test('Settings opens the tiles; what was on its long page has pages of its own', () => {
  const page = html.slice(html.indexOf('id="settings"'), html.indexOf('id="setup-page"'));
  const tiles = page.slice(0, page.indexOf('id="settings-data"'));
  for (const gone of ['settings-web', 'settings-notify', 'settings-lock', 'settings-keep', 'data-colours-pick', 'settings-update']) assert.ok(!tiles.includes(gone), `${gone} is not on the tile page`);
  const data = page.slice(page.indexOf('id="settings-data"'), page.indexOf('id="settings-colours"'));
  for (const here of ['settings-keep', 'settings-lock', 'settings-notify', 'settings-web']) assert.ok(data.includes(here), `${here} is on Data and lock`);
  assert.ok(page.slice(page.indexOf('id="settings-colours"')).includes('data-colours-pick'));

  const mute = read('mute.js');
  const open = /function openSettings\(\) \{[\s\S]*?\n\}/.exec(mute)![0];
  assert.doesNotMatch(open, /replaceChildren/, 'the tiles need nothing drawn');
  assert.match(open, /showSettingsPage\('settings'/);
  const data2 = /function openDataLock\(\) \{[\s\S]*?\n\}/.exec(mute)![0];
  for (const box of ['webSearchBox', 'notifyBox', 'appLockBox', 'keepBox']) assert.ok(data2.includes(box), box);
  assert.match(data2, /showSettingsPage\('data'/);
  assert.match(mute, /app\.openDataLock = openDataLock;/);
  assert.match(read('homeview.js'), /b\.dataset\.setup === 'data'\) app\.openDataLock\?\.\(\)/);
  assert.match(read('homeview.js'), /b\.dataset\.setup === 'colours'\) app\.openColours\?\.\(\)/);
});

test('the two new pages behave like the other Settings pages', () => {
  assert.match(read('home.js'), /const SETUP_VIEWS = \['settings', 'models', 'nodes', 'thispc', 'staff', 'jobs', 'files', 'data', 'colours'\];/);
  assert.match(read('home.js'), /data: '#settings-data', colours: '#settings-colours'/);
  const css = read('style.css');
  assert.match(css, /\.shell:not\(\[data-view="data"\]\) > #settings-data/);
  assert.match(css, /\.shell:not\(\[data-view="colours"\]\) > #settings-colours/);
});

test('everywhere else the left panel shows only the two lines, and the submenu opens on Settings', () => {
  const css = read('style.css');
  assert.doesNotMatch(css, /> \.rail > #rail-setup-fold \{ display: none; \}/, 'the two lines stay on every page');
  assert.match(css, /:not\(\[data-view="colours"\]\) > \.rail #rail-settings-sub \{ display: none; \}/);
});

test('links to what moved go to its new place, and no words send anyone to "Set up"', () => {
  assert.match(read('mute.js'), /text: 'Settings, Data and lock'/);
  assert.match(read('owner.js'), /Settings, Data and lock, then Put back/);
  assert.match(html, /Settings, Data and lock<\/b>/);
  for (const f of ['app.js', 'chatview.js', 'images.js', 'jobs.js', 'team.js', 'homeview.js']) assert.doesNotMatch(read(f), /(under |\()?Set up, /, f);
  const words = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(words, /<b>Set up<\/b>|Set up menu|Set up, /);
  assert.doesNotMatch(words, /aria-label="Set up"/);
});
