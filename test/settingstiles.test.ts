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

test('the left panel has no TOMLIN - HOME or Settings line; only the submenu is left', () => {
  assert.doesNotMatch(html, /TOMLIN - HOME/);
  assert.doesNotMatch(html, /id="rail-setup-home"/);
  assert.doesNotMatch(menu, /data-setup="settings"/);
  assert.doesNotMatch(menu, /Set up/);
  assert.ok(menu.includes('id="rail-settings-sub"'));
  // Nothing in the page's scripts may still look for the removed line (a missing element stops the whole page).
  assert.doesNotMatch(read('home.js'), /rail-setup-home/);
  // Home and Settings stay one press away: the logo and the Home row, and the top bar's Settings button.
  assert.match(html, /id="rail-home-row"/);
  assert.match(html, /id="settings-open"/);
});

test('eleven lines in the order drawn: Cluster after Network, Permissions after Data and lock, Colours at the very end', () => {
  assert.deepEqual(lines.map(l => l.name), ['Hire staff', 'Models', 'Network', 'Cluster', 'This PC', 'Jobs', 'Files and blog writer', 'Manage updates', 'Data and lock', 'Permissions', 'Colours']);
  assert.deepEqual(lines.map(l => l.opens), ['staff', 'models', 'nodes', 'cluster', 'thispc', 'jobs', 'files', 'updates', 'data', 'perms', 'colours']);
});

test('each has one short sentence', () => {
  for (const l of lines) {
    assert.ok(l.about.length <= 62, `${l.name}: ${l.about}`);
    assert.equal(l.about.match(/\./g)?.length, 1, l.about);
    assert.match(l.about, /\.$/);
  }
  assert.match(lines.find(l => l.name === 'Data and lock')!.about, /set a PIN and choose alerts/);
  assert.match(lines.find(l => l.name === 'Permissions')!.about, /may do on its own/);
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
  for (const here of ['settings-keep', 'settings-lock', 'settings-notify']) assert.ok(data.includes(here), `${here} is on Data and lock`);
  // Permissions, the rules and web search have a page of their own: Permissions.
  for (const gone of ['settings-web', 'settings-permissions', 'settings-rules']) assert.ok(!data.includes(gone), `${gone} is not on Data and lock`);
  assert.ok(data.includes('id="settings-perms-body"'), 'Permissions has its own page');
  assert.ok(page.slice(page.indexOf('id="settings-colours"')).includes('data-colours-pick'));

  const mute = read('mute.js');
  const open = /function openSettings\(\) \{[\s\S]*?\n\}/.exec(mute)![0];
  assert.doesNotMatch(open, /replaceChildren/, 'the tiles need nothing drawn');
  assert.match(open, /showSettingsPage\('settings'/);
  const data2 = /function openDataLock\(\) \{[\s\S]*?\n\}/.exec(mute)![0];
  for (const box of ['notifyBox', 'appLockBox', 'keepBox']) assert.ok(data2.includes(box), box);
  assert.match(data2, /showSettingsPage\('data'/);
  const perms = /function openPermissions\(\) \{[\s\S]*?\n\}/.exec(mute)![0];
  assert.match(perms, /app\.permissionsPage\?\.\(\)/);
  assert.match(perms, /showSettingsPage\('perms', '#settings-perms'\)/);
  assert.match(read('homeview.js'), /b\.dataset\.setup === 'perms'\) app\.openPermissions\?\.\(\)/);
  assert.match(mute, /app\.openDataLock = openDataLock;/);
  assert.match(read('homeview.js'), /b\.dataset\.setup === 'data'\) app\.openDataLock\?\.\(\)/);
  assert.match(read('homeview.js'), /b\.dataset\.setup === 'colours'\) app\.openColours\?\.\(\)/);
});

test('the two new pages behave like the other Settings pages', () => {
  assert.match(read('home.js'), /const SETUP_VIEWS = \['settings', 'models', 'nodes', 'thispc', 'staff', 'jobs', 'files', 'updates', 'data', 'perms', 'colours'\];/);
  assert.match(read('home.js'), /data: '#settings-data', perms: '#settings-perms', colours: '#settings-colours'/);
  const css = read('style.css');
  assert.match(css, /\.shell:not\(\[data-view="data"\]\) > #settings-data/);
  assert.match(css, /\.shell:not\(\[data-view="colours"\]\) > #settings-colours/);
});

test('Manage updates is a page of its own: pressing it goes there and marks it, whatever is on This PC', () => {
  const home = read('home.js');
  const open = /app\.openUpdateInstall = [^\n]*\n[\s\S]*?\n\};/.exec(home)![0];
  assert.match(open, /setView\('updates'\)/);
  assert.doesNotMatch(open, /openThisPc|scrollIntoView/, 'it was a scroll down This PC, lost as that page drew its models');
  assert.match(home, /updates: '#updates-page'/);
  assert.match(read('homeview.js'), /b\.dataset\.setup === 'updates'\) app\.openUpdateInstall\?\.\(\)/);
  const thispc = html.slice(html.indexOf('id="thispc"'), html.indexOf('id="updates-page"'));
  assert.ok(thispc.length > 0 && !thispc.includes('id="node-install"'), 'not on This PC any more');
  assert.match(html, /<h2 id="thispc-title">This PC<\/h2>/);
  assert.match(html, /id="updates-page"[\s\S]*?<h2 id="updates-title">Manage updates<\/h2>[\s\S]*?id="node-install"/);
  assert.doesNotMatch(/function openThisPc\(\) \{[\s\S]*?\n\}/.exec(home)![0], /drawInstall/);
  assert.match(read('style.css'), /\.shell:not\(\[data-view="updates"\]\) > #updates-page/);
});

test('everywhere else the foot of the left panel shows nothing, and the submenu opens on Settings pages', () => {
  const css = read('style.css');
  assert.match(css, /:not\(\[data-view="colours"\]\) > \.rail #rail-settings-sub \{ display: none; \}/);
  assert.match(css, /:not\(\[data-view="colours"\]\) > \.rail > \.rail-setup \{ display: none; \}/, 'no empty box with a line across it');
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
