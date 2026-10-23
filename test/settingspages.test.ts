// Settings (his note, 10 Oct): the Set up menu on the left stays there on every page it opens (it used to give way to
// the chat list on Models, Nodes and Link another PC, so he went back to Settings for the next one), and Staff, Jobs
// and Files open as pages beside it, not as windows over it. Read from the page's own files (checked in the browser on
// a scratch copy: each item, Close back to where it was opened from, phone width, night).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

test('the Set up menu stays in the left panel on every page it opens, with that page marked', () => {
  const css = read('style.css');
  for (const view of ['settings', 'models', 'nodes', 'thispc', 'staff', 'jobs', 'files']) {
    assert.ok(css.includes(`.shell:is([data-view="settings"], [data-view="models"], [data-view="nodes"], [data-view="thispc"], [data-view="staff"], [data-view="jobs"], [data-view="files"]) > .rail > :not(#rail-setup-fold) { display: none; }`), 'the menu alone in the left panel');
    assert.ok(css.includes(`:not([data-view="${view}"])`), `${view}: the menu is not hidden there`);
  }
  assert.match(css, /\.rail-links \.link\[aria-current="page"\]/);
  const home = read('home.js');
  assert.match(home, /const SETUP_VIEWS = \['settings', 'models', 'nodes', 'thispc', 'staff', 'jobs', 'files'\];/);
  assert.match(home, /b\.setAttribute\('aria-current', 'page'\)/);
  // Settings itself is in the menu, so every page is one press from every other.
  assert.match(read('index.html'), /data-setup="settings"/);
  assert.match(read('homeview.js'), /b\.dataset\.setup === 'settings'\) app\.openSettings/);
});

test('Staff, Jobs and Files open as pages, not windows over the page', () => {
  assert.doesNotMatch(read('team.js'), /\bdlg\.showModal\(\)/);
  assert.match(read('team.js'), /app\.showAsPage\(dlg, 'staff'\)/);
  assert.doesNotMatch(read('jobs.js'), /jobsDlg\.showModal\(\)/);
  assert.match(read('jobs.js'), /app\.showAsPage\(jobsDlg, 'jobs'\)/);
  assert.doesNotMatch(read('files.js'), /filesDlg\.showModal\(\)/);
  assert.match(read('files.js'), /app\.showAsPage\(filesDlg, 'files'\)/);
  // Shown in place (non-modal) in the page's own section; Close goes back to where it was opened from.
  const home = read('home.js');
  assert.match(home, /if \(!dlg\.open\) dlg\.show\(\);/);
  assert.match(home, /if \(homeUi\.view === asPage\.view\) setView\(asPage\.back\);/);
  assert.match(read('index.html'), /<section class="models-page app-page setup-page" id="setup-page"/);
});

test('the empty-state hints name the Hire staff button that is on screen, not a menu path that no longer exists', () => {
  const pages = ['app.js', 'homeview.js', 'index.html'].map(read).join('\n');
  // The Set up menu has "Staff: hire and edit", not "Staff": the old four-step path sent people looking for nothing.
  assert.doesNotMatch(pages, /Set up, Staff, Hire staff/);
  // Set up is the left panel's own menu, beside Settings, not inside it: no line sends people to "Settings, Set up".
  for (const f of readdirSync(new URL('../public/', import.meta.url)).filter(n => /\.(js|html)$/.test(n))) assert.doesNotMatch(read(f), /Settings, Set up/, f);
  assert.match(read('app.js'), /NOBODY_YET = '[^']*press Hire staff/);
  assert.match(read('homeview.js'), /'Hire someone first: press Hire staff[^']*'/);
});

test('one name for one thing: Hire staff everywhere, the gears say Model settings, no jargon in the first-run line, no text under 12px', () => {
  const homeview = read('homeview.js');
  // The set-up card's button says what it does, like the left panel (not "Team").
  assert.match(homeview, /u\.staff \? 'Manage staff' : 'Hire staff'/);
  assert.doesNotMatch(homeview, /'Team', \(\) =>/);
  // The line under the project form: a Hire staff button and plain words, never "a LLM model".
  assert.doesNotMatch(homeview, /LLM model/);
  assert.match(homeview, /#home-staff-line'\)\.replaceChildren\(/);
  // The panels' gears are the model's own settings: named so, apart from Settings in the top bar.
  const html = read('index.html');
  assert.doesNotMatch(html, /class="btn quiet gear" title="Settings"/);
  assert.match(html, /class="btn quiet gear" title="Model settings" aria-label="Model settings"/);
  // The font floor: no size under 12px.
  for (const m of read('style.css').matchAll(/font-size:\s*(\d+)px/g)) assert.ok(Number(m[1]) >= 12, m[0]);
});
