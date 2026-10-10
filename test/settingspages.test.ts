// Settings (his note, 10 Oct): the Set up menu on the left stays there on every page it opens (it used to give way to
// the chat list on Models, Nodes and Link another PC, so he went back to Settings for the next one), and Staff, Jobs
// and Files open as pages beside it, not as windows over it. Read from the page's own files (checked in the browser on
// a scratch copy: each item, Close back to where it was opened from, phone width, night).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

test('the Set up menu stays in the left panel on every page it opens, with that page marked', () => {
  const css = read('style.css');
  for (const view of ['settings', 'models', 'nodes', 'staff', 'jobs', 'files']) {
    assert.ok(css.includes(`.shell:is([data-view="settings"], [data-view="models"], [data-view="nodes"], [data-view="staff"], [data-view="jobs"], [data-view="files"]) > .rail > :not(#rail-setup-fold) { display: none; }`), 'the menu alone in the left panel');
    assert.ok(css.includes(`:not([data-view="${view}"])`), `${view}: the menu is not hidden there`);
  }
  assert.match(css, /\.rail-links \.link\[aria-current="page"\]/);
  const home = read('home.js');
  assert.match(home, /const SETUP_VIEWS = \['settings', 'models', 'nodes', 'staff', 'jobs', 'files'\];/);
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
