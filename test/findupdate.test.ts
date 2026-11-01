// Finding the update (2.0.63: it was hard to find): Update this install (on This PC: models and updates) was
// reached only by scrolling that page, or from Settings' foot. Now: an Update TOMLIN entry of its own in the Set up
// menu, the version and Check git at the head of Settings, Update TOMLIN in the My PC window, and the no-release line
// says what to do instead. Read from the page's own files, as test/settingspages.test.ts does; the line is a pure
// function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { noRelease } from '../src/release.ts';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const page = (f: string) => read(`public/${f}`);

test('the Settings menu has Updates of its own, after This PC, opening Update this install', () => {
  const html = page('index.html');
  const thispc = html.indexOf('data-setup="thispc"');
  const update = html.indexOf('data-setup="update"');
  assert.ok(thispc > 0 && update > thispc, 'an Updates entry after This PC');
  assert.match(html.slice(update, update + 900), /Updates<\/button>/);
  // One press from the menu: the same opener Settings' button uses (home.js app.openUpdateInstall).
  assert.match(page('homeview.js'), /b\.dataset\.setup === 'update'\) app\.openUpdateInstall\?\.\(\)/);
  assert.match(page('home.js'), /app\.openUpdateInstall = async \(\) => \{/);
  // The page it opens is This PC: models and updates, so that menu entry is the one marked there (SETUP_VIEWS unchanged).
  assert.match(page('home.js'), /const SETUP_VIEWS = \['settings', 'models', 'nodes', 'thispc', 'staff', 'jobs', 'files', 'data', 'colours'\];/);
});

test('Update this install has Check git, one function for it, and a download followed on its own page', () => {
  const html = page('index.html');
  assert.ok(html.includes('id="node-install-git"'), 'Check git is on the page Updates opens');
  const home = page('home.js');
  assert.match(home, /async function checkGit\(btn, say, download\)/);
  assert.match(home, /\$\('#node-install-git'\)\.addEventListener\('click', e => \{\n[^\n]*\n\s*checkGit\(e\.currentTarget, gitSay, getGit\);/);
});

test('the My PC window has Update TOMLIN beside its version line', () => {
  const pcs = page('pcs.js');
  const here = pcs.slice(pcs.indexOf('if (v.here) {'), pcs.indexOf("const head = el('div', { class: 'pc-head' }"));
  assert.match(here, /text: 'Update TOMLIN'/);
  assert.match(here, /dlg\.close\(\);\s*\n?\s*app\.openUpdateInstall\?\.\(\);/);
});

test('with no release on GitHub, Check git says what to do instead (Check zip, or the zip\'s Install TOMLIN.cmd)', () => {
  // A made-up repo: the real one carries its owner's name, which the publish check keeps out of the public copy.
  const line = noRelease('someone/tomlin-copy', '2.0.62');
  assert.match(line, /^There is no release of TOMLIN on GitHub yet \(github\.com\/someone\/tomlin-copy\)\. This PC runs 2\.0\.62\./);
  assert.match(line, /Check zip/);
  assert.match(line, /tomlin-<version>\.zip and its \.zip\.sig/);
  assert.match(line, /Install TOMLIN\.cmd/);
  assert.ok(line.length < 400, 'one short paragraph');
  assert.match(read('src/server/selfupdate.ts'), /if \(r\.status === 404\) return noRelease\(REPO, VERSION\);/);
});

test('Help and the README name the new ways in', () => {
  const html = page('index.html');
  const help = html.slice(html.indexOf('id="help-copies"'), html.indexOf('id="help-git"'));
  assert.match(help, /<b>Updates<\/b>/);
  assert.match(help, /under Settings/);
  assert.match(help, /My PC window/);
  assert.match(read('README.md'), /\*\*Updates\*\* \(under Settings; also Update TOMLIN in the My PC window\)/);
});
