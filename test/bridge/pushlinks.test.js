// Push live never follows a link: a link in the upload folder can point anywhere on this PC, so what it points at could
// go to the web server. Each one is named under "Left out", and nothing behind it is sent. A junction needs no special
// rights on Windows; a link to one file does (Developer Mode), so that check runs only where one can be made.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkFolder } = require('../../src/bridge/hosting/check');

const git = (dir, ...args) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '-c', 'user.name=Made Up', '-c', 'user.email=made-up@example.test', '-C', dir, ...args], { stdio: 'ignore' });

/** A site folder and, beside it, a folder that must never go live. */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-links-'));
  const site = path.join(dir, 'site');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(site);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>Made-up page</h1>');
  fs.writeFileSync(path.join(outside, 'private.txt'), 'made-up private note');
  return { dir, site, outside };
}
// The junction goes first, so the folder it points at is never reached through it.
function clean(dir, ...links) {
  for (const l of links) fs.rmSync(l, { force: true, recursive: false });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
const sent = out => out.files.map(f => f.rel);
const named = (out, rel) => out.left.find(l => l.rel === rel);

test('a junction in a folder that is not a git repository is named as left out, and nothing behind it is sent', async () => {
  const { dir, site, outside } = setup();
  const link = path.join(site, 'linked');
  fs.symlinkSync(outside, link, 'junction');
  try {
    const out = await checkFolder({ projectDir: site, folder: site, secrets: {}, details: [] });
    assert.deepEqual(sent(out), ['index.html']);
    assert.match(named(out, 'linked')?.why ?? '', /link/i, JSON.stringify(out.left));
  } finally { clean(dir, link); }
});

test('a file git still lists, whose folder has become a junction to somewhere else, is not sent', async () => {
  const { dir, site, outside } = setup();
  const sub = path.join(site, 'notes');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'private.txt'), 'the file the site had');
  git(site, 'init', '-q');
  git(site, 'add', '.');
  git(site, 'commit', '-q', '-m', 'made-up');
  fs.rmSync(sub, { recursive: true });
  fs.symlinkSync(outside, sub, 'junction');
  try {
    const out = await checkFolder({ projectDir: site, folder: site, secrets: {}, details: [] });
    assert.ok(!sent(out).some(r => r.startsWith('notes/')), `sent: ${sent(out)}`);
    assert.ok(named(out, 'notes/private.txt'), JSON.stringify(out.left));
    assert.deepEqual(sent(out), ['index.html']);
  } finally { clean(dir, sub); }
});

test('a link to one file outside the site is not sent', async t => {
  const { dir, site, outside } = setup();
  const link = path.join(site, 'note.txt');
  try { fs.symlinkSync(path.join(outside, 'private.txt'), link, 'file'); } catch (e) {
    clean(dir);
    return t.skip(`this PC cannot make a file link (${e.code})`);
  }
  try {
    const out = await checkFolder({ projectDir: site, folder: site, secrets: {}, details: [] });
    assert.deepEqual(sent(out), ['index.html']);
    assert.ok(named(out, 'note.txt'), JSON.stringify(out.left));
  } finally { clean(dir, link); }
});
