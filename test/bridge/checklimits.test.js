// The Push live check at its edges: a saved secret's value inside a big binary file (over 5 MB, read in parts, the
// value also cut in two by the parts), files the .gitignore leaves out that are sent with the tick but could not all be
// seen, and a listed file that cannot be looked at. Each must stop the push, never pass it with a file left out unseen.
// Run: node test/bridge/checklimits.test.js   (git on PATH for the .gitignore cases)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-checklimits-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
process.env.BRIDGE_DATA = path.join(tmp, 'data');
const check = require('../../src/bridge/hosting/check');

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + (e && e.stack || e)); } };
const w = (base, rel, data) => { const p = path.join(base, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
const rules = x => x.findings.map(f => f.rule + ' ' + f.rel);
const MB = 1024 * 1024;
const VALUE = 'made-up-saved-value-7Qx2';

// A binary file (a zero byte at the start) of size bytes with the value written at each of at (as UTF-8, or UTF-16).
function binary(size, at = [], enc = 'utf8') {
  const b = Buffer.alloc(size, 0x41); b[0] = 0; b[1] = 0xff;
  for (const i of at) Buffer.from(VALUE, enc).copy(b, i);
  return b;
}

(async () => {
  await test('a saved value inside a binary file over 5 MB stops the push: at the start, at the end, cut in two by the parts, as UTF-16', async () => {
    const cases = { 'start.bin': [binary(6 * MB, [100])], 'end.bin': [binary(6 * MB, [6 * MB - VALUE.length])],
      'cut.bin': [binary(6 * MB, [MB - 7])], 'wide.bin': [binary(6 * MB, [2 * MB - 11], 'utf16le')], 'none.bin': [binary(6 * MB)] };
    for (const [name, [data]] of Object.entries(cases)) {
      const dir = fs.mkdtempSync(path.join(tmp, 'big-'));
      w(dir, 'index.html', '<h1>Hi</h1>\n');
      w(dir, 'media/' + name, data);
      const x = await check.checkFolder({ projectDir: dir, folder: dir, secrets: { 'live DB_PASS': VALUE } });
      const hit = x.findings.find(f => f.rule === 'VALUE' && f.rel === 'media/' + name);
      if (name === 'none.bin') assert(!hit && x.files.some(f => f.rel === 'media/none.bin' && f.sha.length === 64), name + ': ' + rules(x));
      else assert(hit && /live DB_PASS/.test(hit.what) && hit.canIgnore === false, name + ': ' + rules(x));
    }
  });

  await test('the big-file fingerprint is the file\'s sha256, whether or not values are looked for', async () => {
    const p = w(tmp, 'fp/x.bin', binary(3 * MB + 5, [MB - 3]));
    const sha = require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    assert.strictEqual(check.hashFile(p), sha);
    assert.deepStrictEqual(check.hashFile(p, [VALUE, 'not-in-it-at-all'], true), { sha, hits: [0] });
  });

  const git = spawnSync('git', ['--version']).status === 0;
  await test('files the .gitignore leaves out, sent with the tick: a folder too deep to see among them stops the push', async () => {
    if (!git) return console.log('     (git not on PATH: skipped)');
    const dir = fs.mkdtempSync(path.join(tmp, 'deep-'));
    assert.strictEqual(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0);
    w(dir, '.gitignore', 'vendor/\n');
    w(dir, 'index.php', '<?php require "vendor/lib.php";\n');
    w(dir, 'vendor/lib.php', '<?php // a library\n');
    w(dir, 'vendor/' + Array.from({ length: 22 }, (_, i) => 'd' + i).join('/') + '/deep.php', '<?php\n');
    const sent = await check.checkFolder({ projectDir: dir, folder: dir, sendAnyway: ['gitignored'] });
    assert(sent.findings.some(f => f.rule === 'FOLDER' && /20 folders deep/.test(f.what) && f.canIgnore === false), rules(sent).join(', '));
    // Without the tick they are not sent, so what that walk could not see changes nothing.
    const kept = await check.checkFolder({ projectDir: dir, folder: dir });
    assert(!kept.findings.some(f => f.rule === 'FOLDER'), rules(kept).join(', '));
    assert(kept.files.some(f => f.rel === 'index.php') && kept.left.some(l => l.rel === 'vendor/lib.php' && l.soft === 'gitignored'));
  });

  await test('a listed file that cannot be looked at (no rights) is a stop, not dropped from the list', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'locked-'));
    w(dir, 'index.html', '<h1>Hi</h1>\n');
    const locked = w(dir, 'locked.html', 'x\n');
    const real = fs.statSync;
    fs.statSync = function (p, ...rest) {
      if (path.resolve(String(p)).toLowerCase() === locked.toLowerCase()) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
      return real.call(this, p, ...rest);
    };
    let x;
    try { x = await check.checkFolder({ projectDir: dir, folder: dir }); } finally { fs.statSync = real; }
    assert(x.findings.some(f => f.rule === 'READ' && f.rel === 'locked.html' && /EACCES/.test(f.what) && !f.canIgnore), rules(x).join(', '));
    assert(x.files.some(f => f.rel === 'index.html'));
  });

  await test('a listed file deleted before it is looked at is simply not sent (no stop)', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'gone-'));
    w(dir, 'index.html', '<h1>Hi</h1>\n');
    const gone = w(dir, 'gone.html', 'x\n');
    const real = fs.statSync;
    fs.statSync = function (p, ...rest) {
      if (path.resolve(String(p)).toLowerCase() === gone.toLowerCase()) { const e = new Error('ENOENT: no such file'); e.code = 'ENOENT'; throw e; }
      return real.call(this, p, ...rest);
    };
    let x;
    try { x = await check.checkFolder({ projectDir: dir, folder: dir }); } finally { fs.statSync = real; }
    assert(!x.findings.length && !x.files.some(f => f.rel === 'gone.html') && x.files.some(f => f.rel === 'index.html'), rules(x).join(', '));
  });

  console.log(failures ? failures + ' failed' : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.log('FAIL crashed: ' + (e && e.stack || e)); process.exit(1); });
