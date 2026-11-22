// One look for the Settings pages (Nov 2026): blue means "press here", a grey tint is where you are. Data and lock is rows
// in white cards; Permissions, the rules and web search are a page of their own, in groups. Run: node --test test/settingslook.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = read('style.css');
const app = read('app.js');
const look = css.slice(css.indexOf('/* ---- One look (Nov 2026)'));

test('buttons: blue means "press here"; the main one filled blue, every other one white with a border', () => {
  assert.ok(look.length > 1000, 'the One look block is at the end of the stylesheet, so it wins');
  assert.match(look, /\.btn, \.btn\.quiet \{ background: var\(--panel\); color: var\(--ink\); border: 1px solid /);
  assert.match(look, /\.btn\.primary \{ background: var\(--accent\); border-color: var\(--accent\); color: var\(--accent-ink\);/);
  // A button that cannot be pressed is faint, not a solid block.
  assert.match(look, /\.btn:disabled, \.btn\.primary:disabled \{ background: var\(--panel\);/);
  // Where you are is never blue: a grey tint and a dark bar, the same in the Settings list, the left list and Jobs.
  const here = look.match(/\.rail-links \.link\[aria-current="page"\], \.rail-row\[aria-current\][^{]*\{([^}]*)\}/)!;
  assert.match(here[0], /\.job-nav-item\[aria-current\]/);
  assert.match(here[1], /background: var\(--accent-soft\);[^}]*box-shadow: inset 3px 0 0 var\(--ink\);/);
  assert.doesNotMatch(here[1], /var\(--accent\)/);
  assert.match(look, /\.rail-count \{ background: var\(--ink\); color: var\(--panel\); \}/);
  // A choice picked (PIN or Password, Day or Night) is raised and white, not blue.
  assert.match(look, /\.lock-kind button\[aria-checked="true"\], \.theme-switch button\[aria-checked="true"\][^{]*\{ background: var\(--panel\);/);
});

test('the rows have one shape: icon, name, how it is now, its control; more folds under the row', () => {
  for (const name of ['setIcon', 'setPart', 'setCard', 'setRow', 'setSwitch', 'setSeg', 'setSaid', 'setButton']) assert.match(app, new RegExp(`app\\.${name} = `), name);
  const row = app.slice(app.indexOf('app.setRow = '), app.indexOf('app.setSwitch = '));
  assert.match(row, /el\('details', \{ class: 'set-row', open \}/);
  assert.match(row, /el\('div', \{ class: 'set-inside' \}/);
  // Text sizes are the page's own (13px or more), and colours by name.
  const rows = css.slice(css.indexOf('/* ---- Settings rows (app.js setRow)'));
  for (const m of rows.matchAll(/font-size:\s*([^;]+);/g)) assert.match(m[1], /var\(--fs-(xs|sm|md|lg|xl)\)/);
  assert.doesNotMatch(rows, /#[0-9a-f]{3,8}\b/i);
});

test('Data and lock: Your data, Lock and Notifications as rows; Update this install is on Manage updates only', () => {
  const keep = read('keep.js');
  const box = keep.slice(keep.indexOf('app.keepBox = () => {'));
  assert.doesNotMatch(box, /Update this install/);
  assert.match(box, /app\.setButton\('Back up now', [\s\S]*?\{ main: true \}\)/);
  assert.match(box, /el\('table', \{ class: 'set-table', hidden: true \}/);
  // No backups yet: the table's headings are not shown alone, under "None yet".
  assert.match(box, /listed\.hidden = !k\.backups\.length;/);
  assert.match(box, /return app\.setPart\('Your data', app\.setCard\(folder, backups\), note\);/);
  const lock = read('lock.js');
  const lockBox = lock.slice(lock.indexOf('app.appLockBox = () => {'));
  assert.match(lockBox, /app\.setRow\(\{ icon: 'lock', name: 'App lock'/);
  assert.match(lockBox, /name: 'Lock by itself'/);
  assert.match(lockBox, /'What the lock does and does not cover'/, 'the picture-model words are folded, not two paragraphs first');
  const notify = read('notify.js');
  assert.match(notify, /app\.setSwitch\(!!s\.windows, 'Windows notification'/);
  assert.match(notify, /app\.setSwitch\(!!s\.sound, 'Sound'/);
});

test('Permissions: its own page in groups, saved one change at a time', () => {
  const page = app.slice(app.indexOf('app.permissionsPage = () => {'), app.indexOf('app.rulesBox = () => {'));
  for (const part of ['Files and web', 'Screen', 'Coding', 'Research', 'Rules']) assert.ok(page.includes(`app.setPart('${part}'`), part);
  // Each save sends the whole permissions: two at once would undo each other, so they queue.
  assert.match(page, /const save = change => \(queue = queue\.then\(\(\) => saveNow\(change\)\)\);/);
  assert.match(page, /\[\['ask', 'Ask first'\], \['auto', 'Auto'\]\]/);
  const tiers = app.slice(app.indexOf('app.tierRows = save => {'), app.indexOf('/** What a chat\'s model may do (src/permits.ts)'));
  assert.match(tiers, /app\.setSeg\(k\.tiers\.map\(t => \[t, app\.TIER_NAMES\[t\]\]\)/, 'each kind shows its tiers side by side, only those it may have');
  // The chat's own asking card still has its switches (app.permissionRows), unchanged.
  assert.match(app, /app\.permissionRows = \(onChange\) => \{/);
});

test('Night is neutral grey, so blue can mean one thing; navy and sky blue are gone', () => {
  const night = css.slice(css.indexOf(':root[data-theme="night"] {'), css.indexOf('}', css.indexOf(':root[data-theme="night"] {')));
  assert.match(night, /--bg: #15171b;/);
  assert.match(night, /--panel: #1e2126;/);
  assert.match(night, /--accent: #7ea6ff;/);
  for (const navy of ['#050d1a', '#0a1a2f', '#38bbff', '#11324e']) assert.ok(!css.includes(navy), navy);
  // The Colours page says what Night now is, not the old navy.
  assert.match(read('index.html'), /> Night: dark grey and soft blue<\/label>/);
  assert.doesNotMatch(read('index.html'), /deep navy|sky blue/);
});

test('one filled button per screen: list Downloads, Manage staff and the later set-up steps are ordinary buttons', () => {
  const models = read('models.js');
  assert.doesNotMatch(models, /class: 'btn primary', type: 'button', text: `Download/);
  assert.doesNotMatch(models, /class: 'btn primary', type: 'button', text: r\.zips/);
  // The Hire staff tile: two ordinary buttons, Hire and Manage (the Staff menu between them is gone).
  assert.match(read('homeview.js'), /tileButton\('Hire', TILE_PLUS, \(\) => \{ asPage\.fromMenu = true; app\.openHire\(\{ page: true, fromMenu: true \}\); \}\),\n\s+tileButton\('Manage', TILE_LIST, \(\) => \{ asPage\.fromMenu = true; app\.seeAllStaff\(\); \}\)/);
  assert.doesNotMatch(read('index.html'), /id="staff-menu"|id="sm-manage"/);
  const home = read('homeview.js');
  assert.match(home, /const next = steps\.indexOf\(false\);/);
  assert.match(home, /class: `btn\$\{at\+\+ === next \? ' primary' : ''\}`/);
  assert.match(css, /\.blog-form > \.btn \{ justify-self: start; \}/);
  // Links are pressed too, so they are blue; the Settings list keeps its own dark words.
  assert.match(look, /\n\.link \{ color: var\(--accent\);/);
});

test('Network, This PC and Manage updates are rows in white cards; Enable this PC as a node is a switch', () => {
  const html = read('index.html');
  const page = (id: string) => html.slice(html.indexOf(`<section class="nodes" id="${id}"`), html.indexOf('\n</section>\n', html.indexOf(`<section class="nodes" id="${id}"`)));
  for (const id of ['nodes', 'thispc', 'updates-page']) {
    const p = page(id);
    assert.doesNotMatch(p, /class="home-part/, `${id}: no old card`);
    assert.match(p, /<section class="set-part[^"]*"[^>]*>\n\s*<h3[^>]*>[^<]+<\/h3>\n\s*<div class="set-card">/, `${id}: a heading, then a card`);
  }
  assert.match(page('nodes'), /<label class="set-sw"><input type="checkbox" role="switch" id="node-on" aria-labelledby="node-on-label"><i aria-hidden="true"><\/i><\/label>/);
  assert.match(page('nodes'), /<details class="set-row" id="link-help">/);
  assert.match(page('updates-page'), /<section class="set-part" id="node-install"/, 'the section the My PC window borrows keeps its id');
  assert.match(css, /\.set-card > \.node-setup \{ margin: 0;/);
});

test('one page head: Staff, Hire staff, Jobs and Files as pages have the breadcrumb and title, not a window band and Close', () => {
  const home = read('home.js');
  const show = home.slice(home.indexOf('function showAsPage('), home.indexOf('app.showAsPage = showAsPage;'));
  // The breadcrumb names the page it goes back to, then this page; pressing the first name closes it (back there).
  assert.match(show, /el\('nav', \{ class: 'crumbs page-crumbs', 'aria-label': 'Breadcrumb' \}\)/);
  assert.match(show, /el\('button', \{ class: 'link', type: 'button', text: crumbName\(asPage\.back\), onclick: \(\) => dlg\.close\(\) \}\)/);
  assert.match(show, /el\('li', \{ 'aria-current': 'page', text: crumbName\(view\) \}\)/);
  // A crumb is a name: "Chat" (not "the chat", which reads only inside "Close (back to the chat)"), and "Staff" for the Staff pages.
  assert.match(home, /const crumbName = view => \(view === 'chat' \? 'Chat' : view === 'staff' \? 'Staff' : viewName\(view\)\);/);
  const heads = css.slice(css.indexOf('/* ---- Page heads'), css.indexOf('/* ---- Settings rows (app.js setRow)'));
  assert.match(heads, /\.page-crumbs \{ display: none; \}/, 'a window over a chat shows no breadcrumb');
  assert.match(heads, /dialog\.as-page > \.help-body > \.dlg-top \{ position: static;[^}]*background: none; border: 0;/);
  assert.match(heads, /dialog\.as-page :is\(#team-close, #hs-close\), #setup-page > dialog\.as-page > \.help-body > \.dlg-top > form\[method="dialog"\] \{ display: none; \}/);
  assert.match(heads, /@media \(max-width: 760px\) \{ \[data-crumb\] \.back \{ display: none; \} \}/);
});
