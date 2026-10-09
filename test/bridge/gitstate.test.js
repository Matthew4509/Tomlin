// Tests for lib/gitstate.js against real little repositories in a temp folder (git must be installed).
// Run: node test/gitstate.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { gitState, safeRemote, changes } = require('../../src/bridge/gitstate');

let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-git-'));
// Removed however the test ends (a failed check or a crash too); a folder something still holds gets a few tries.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', ...a], { stdio: 'pipe' }).toString();
const repo = name => { const d = path.join(tmp, name); fs.mkdirSync(d); git(d, 'init', '-q'); return d; };
const save = (d, file, text) => { fs.writeFileSync(path.join(d, file), text); git(d, 'add', file); git(d, 'commit', '-q', '-m', 'save ' + file); };

(async () => {
  await check('a folder without .git is "none"', async () => {
    const d = path.join(tmp, 'plain'); fs.mkdirSync(d);
    assert.strictEqual((await gitState(d, true)).state, 'none');
  });
  await check('git set up but nothing saved is "empty"', async () => {
    assert.strictEqual((await gitState(repo('empty'), true)).state, 'empty');
  });
  await check('saved, no remote, with changes: "local" and the changed files counted', async () => {
    const d = repo('local'); save(d, 'a.txt', '1');
    fs.writeFileSync(path.join(d, 'a.txt'), '2'); fs.writeFileSync(path.join(d, 'new.txt'), 'x');
    const g = await gitState(d, true);
    assert(g.state === 'local' && g.changes === 2 && g.branch === 'main' && g.remote === null && g.lastCommit, JSON.stringify(g));
  });
  const bare = path.join(tmp, 'backup.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  await check('remote set, never pushed: "unpushed"', async () => {
    const d = repo('unpushed'); save(d, 'a.txt', '1'); git(d, 'remote', 'add', 'origin', bare);
    const g = await gitState(d, true);
    assert(g.state === 'unpushed' && g.pushed === false && g.remoteName === 'origin', JSON.stringify(g));
  });
  const d = repo('pushed');
  await check('pushed: "ok"; one more save: "ahead" 1; an edit: "changes"', async () => {
    save(d, 'a.txt', '1'); git(d, 'remote', 'add', 'origin', bare); git(d, 'push', '-q', '-u', 'origin', 'main');
    assert.strictEqual((await gitState(d, true)).state, 'ok');
    save(d, 'b.txt', '2');
    let g = await gitState(d, true);
    assert(g.state === 'ahead' && g.ahead === 1, JSON.stringify(g));
    fs.writeFileSync(path.join(d, 'b.txt'), '3');
    g = await gitState(d, true);
    assert(g.state === 'changes' && g.changes === 1 && g.ahead === 1, JSON.stringify(g));
  });
  await check('no upstream set (pushed by another tool): compared with origin/<branch>', async () => {
    const e = repo('no-upstream'); save(e, 'a.txt', '1'); git(e, 'remote', 'add', 'origin', bare);
    git(e, 'push', '-q', 'origin', 'main:side'); git(e, 'branch', '-q', '-m', 'side'); git(e, 'fetch', '-q', 'origin');
    const g = await gitState(e, true);
    assert(g.state === 'ok' && g.pushed === true, JSON.stringify(g));
  });
  await check('a repository whose config names a program in core.fsmonitor does not get to run it', async () => {
    const t = repo('trap'); save(t, 'a.txt', '1');
    const marker = path.join(tmp, 'RAN.txt');
    const script = path.join(tmp, 'hook.js');
    fs.writeFileSync(script, 'require("fs").writeFileSync(' + JSON.stringify(marker) + ', "ran")');
    git(t, 'config', 'core.fsmonitor', '"' + process.execPath.replace(/\\/g, '/') + '" "' + script.replace(/\\/g, '/') + '"');
    // Control: plain git status DOES run it, so the trap is real (otherwise this test would pass for nothing).
    try { execFileSync('git', ['-C', t, 'status'], { stdio: 'pipe' }); } catch {}
    assert(fs.existsSync(marker), 'control: plain git status did not run the fsmonitor program, so the trap is not armed');
    fs.unlinkSync(marker);
    const g = await gitState(t, true);
    assert(!fs.existsSync(marker), 'the Bridge ran the program named in core.fsmonitor');
    assert(g.state === 'error' && /could run a program/.test(g.reason || ''), 'a repo with a risky config should be refused: ' + JSON.stringify(g));
  });
  await check('a repository whose config sets a clean/smudge filter is refused, not read', async () => {
    const t = repo('filter'); save(t, 'a.txt', '1');
    const marker = path.join(tmp, 'FILTER-RAN.txt');
    const script = path.join(tmp, 'filt.js').replace(/\\/g, '/');
    fs.writeFileSync(path.join(tmp, 'filt.js'), 'require("fs").writeFileSync(' + JSON.stringify(marker) + ', "ran"); process.stdin.resume();');
    git(t, 'config', 'filter.evil.clean', '"' + process.execPath.replace(/\\/g, '/') + '" "' + script + '"');
    fs.writeFileSync(path.join(t, '.gitattributes'), '* filter=evil\n');
    const g = await gitState(t, true);
    assert(g.state === 'error' && /could run a program/.test(g.reason || ''), JSON.stringify(g));
    assert(!fs.existsSync(marker), 'the Bridge ran a clean filter from a folder it only meant to read');
  });
  await check('reading never rewrites the index (no lock taken)', async () => {
    const idx = path.join(d, '.git', 'index');
    const before = fs.statSync(idx).mtimeMs;
    fs.utimesSync(path.join(d, 'a.txt'), new Date(), new Date()); // a stat change makes plain git status refresh the index
    await new Promise(r => setTimeout(r, 50));
    await gitState(d, true);
    assert.strictEqual(fs.statSync(idx).mtimeMs, before);
    // Control: plain git status in the same state DOES rewrite it, so the check above could have failed.
    execFileSync('git', ['-C', d, 'status'], { stdio: 'pipe' });
    assert.notStrictEqual(fs.statSync(idx).mtimeMs, before, 'control: plain git status did not touch the index either');
  });
  await check('a remote address never carries its user name or token to the page', () => {
    assert.strictEqual(safeRemote('https://bob:ghp_SECRET@github.com/a/b.git'), 'github.com/a/b');
    assert.strictEqual(safeRemote('git@github.com:a/b.git'), 'github.com/a/b');
    assert.strictEqual(safeRemote('ssh://git@example.com:2222/x/y.git'), 'example.com:2222/x/y');
  });

  // See what changed: read only, every kind of change, new files from the folder, binaries named not shown.
  await check('changes: changed, deleted, new and binary files, with their lines; nothing in the repo is changed', async () => {
    const d = repo('diffs');
    save(d, 'keep.txt', 'a\nb\nc\n'); save(d, 'old.txt', 'gone\n');
    fs.writeFileSync(path.join(d, 'keep.txt'), 'a\nB\nc\nd\n'); fs.rmSync(path.join(d, 'old.txt'));
    fs.writeFileSync(path.join(d, 'new file.txt'), 'one\ntwo\n'); fs.writeFileSync(path.join(d, 'bin.dat'), Buffer.from([0, 1, 2]));
    const before = git(d, 'status', '--porcelain');
    const r = await changes(d);
    assert(r.ok, JSON.stringify(r));
    const by = Object.fromEntries(r.files.map(f => [f.path, f]));
    assert.deepStrictEqual([by['keep.txt'].kind, by['keep.txt'].added, by['keep.txt'].removed], ['changed', 2, 1]);
    assert(by['keep.txt'].lines.includes('-b') && by['keep.txt'].lines.includes('+B'));
    assert.deepStrictEqual([by['old.txt'].kind, by['old.txt'].removed], ['deleted', 1]);
    assert.deepStrictEqual([by['new file.txt'].kind, by['new file.txt'].lines], ['new', ['+one', '+two']]);
    assert(by['bin.dat'].binary && !by['bin.dat'].lines.length);
    assert.strictEqual(git(d, 'status', '--porcelain'), before);
  });
  await check('changes: a new folder is one entry (its files are not listed), after the changed files', async () => {
    const d = repo('newdir');
    save(d, 'a.txt', 'one\n');
    for (let i = 0; i < 50; i++) { fs.mkdirSync(path.join(d, 'node_modules', 'p' + i), { recursive: true }); fs.writeFileSync(path.join(d, 'node_modules', 'p' + i, 'x.js'), 'x'); }
    fs.writeFileSync(path.join(d, 'a.txt'), 'two\n');
    const r = await changes(d);
    assert.deepStrictEqual(r.files.map(f => [f.path, f.kind, !!f.folder]), [['a.txt', 'changed', false], ['node_modules/', 'new', true]]);
  });
  await check('changes: a folder with no git, or a risky git config, is refused with a reason', async () => {
    const plain = path.join(tmp, 'plain-2'); fs.mkdirSync(plain);
    const a = await changes(plain);
    const d = repo('risky'); fs.appendFileSync(path.join(d, '.git', 'config'), '[filter "x"]\n\tclean = evil\n');
    const b = await changes(d);
    assert(!a.ok && /not in git/.test(a.error) && !b.ok && /could run a program/.test(b.error), JSON.stringify([a, b]));
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
})();
