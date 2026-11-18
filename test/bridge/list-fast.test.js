// The Projects list opens from what was last known: git is read in the background a few folders at a time, rows
// say "checking" until theirs is in, a slow folder gets the time it needs (or a quicker read that leaves new files
// out), and a folder git cannot read says why in plain words, on its row and behind the status bar's link.
// Run: node test/bridge/list-fast.test.js   (git on PATH). Every folder and name here is made up.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { execFileSync } = require('child_process');
const Git = require('../../src/bridge/gitstate');
const P = require('../../src/bridge/projects');

let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-listfast-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', ...a], { stdio: 'pipe' }).toString();
const repo = name => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); git(d, 'init', '-q'); return d; };
const save = (d, file, text) => { fs.writeFileSync(path.join(d, file), text); git(d, 'add', file); git(d, 'commit', '-q', '-m', 'save ' + file); };
const until = async (ok, ms = 20000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 50)); } };

(async () => {
  await check('a folder never read says "checking" at once, without running git', async () => {
    const d = repo('never-read'); save(d, 'a.txt', '1');
    const g = Git.peek(d);
    assert(g.state === 'checking' && g.checking === true, JSON.stringify(g));
  });

  await check('refresh reads in the background: rows say checking until theirs is in, then the state, and the number moves', async () => {
    const dirs = [];
    for (let i = 0; i < 6; i++) { const d = repo('bg-' + i); save(d, 'a.txt', String(i)); dirs.push(d); }
    const before = Git.rev();
    Git.refresh(dirs, false);
    assert.strictEqual(Git.pending(), 6);
    assert(dirs.every(d => Git.peek(d).checking), 'every row is checking while it waits');
    await until(() => Git.pending() === 0);
    for (const d of dirs) { const g = Git.peek(d); assert(g.state === 'local' && !g.checking, JSON.stringify(g)); }
    assert(Git.rev() >= before + 6, 'rev moved for each folder read');
    // Read a moment ago: asked again, nothing is queued (a minute's grace), but Refresh (fresh) reads every one again.
    Git.refresh(dirs, false);
    assert.strictEqual(Git.pending(), 0);
    Git.refresh(dirs, true);
    assert.strictEqual(Git.pending(), 6);
    assert(Git.peek(dirs[0]).state === 'local' && Git.peek(dirs[0]).checking, 'the last state stays on the row while it is read again');
    await until(() => Git.pending() === 0);
  });

  await check('the last known state is kept in a file and shown, marked checking, after a restart', async () => {
    const store = path.join(tmp, 'git-state.json');
    const d = repo('remembered'); save(d, 'a.txt', '1');
    // As a run before this one left it: the folder was "ahead" then.
    fs.writeFileSync(store, JSON.stringify({ folders: { [d.toLowerCase()]: { at: 1, value: { state: 'ahead', ahead: 2, changes: 0 } } } }));
    Git.useStore(store);
    const g = Git.peek(d);
    assert(g.state === 'ahead' && g.ahead === 2 && g.checking === true, JSON.stringify(g));
    Git.refresh([d], false);
    await until(() => Git.pending() === 0);
    assert.strictEqual(Git.peek(d).state, 'local');
    await until(() => { try { return JSON.parse(fs.readFileSync(store, 'utf8')).folders[d.toLowerCase()].value.state === 'local'; } catch { return false; } }, 5000);
  });

  await check('a file of last states that is damaged or odd is ignored, not trusted', async () => {
    const store = path.join(tmp, 'bad-state.json');
    const d = repo('odd-store');
    fs.writeFileSync(store, JSON.stringify({ folders: { [d.toLowerCase()]: { at: 1, value: { state: 7 } }, x: null } }));
    Git.useStore(store);
    assert.strictEqual(Git.peek(d).state, 'checking');
    fs.writeFileSync(store, '{not json');
    Git.useStore(store); // no throw
  });

  const slow = repo('slow'); save(slow, 'a.txt', '1');
  fs.writeFileSync(path.join(slow, 'a.txt'), '2'); fs.writeFileSync(path.join(slow, 'new.txt'), 'x');
  const keep = { ...Git.limits };
  await check('a folder where looking for new files takes too long is still read, without them, and says so', async () => {
    Git.limits.status = 1; // the full read always runs out of time
    const g = await Git.gitState(slow, true);
    assert(g.state === 'local' && g.untrackedSkipped === true && g.changes === 1, JSON.stringify(g));
    // Next time (not Refresh) it goes straight to the quicker read.
    Git.limits.status = keep.status;
    const again = await Git.gitState(slow, false);
    assert(again.untrackedSkipped === true, JSON.stringify(again));
    // Refresh tries the full read again, and counts the new file.
    const full = await Git.gitState(slow, true);
    assert(full.changes === 2 && !full.untrackedSkipped, JSON.stringify(full));
  });
  await check('a folder git cannot read in time says how long it waited, in words', async () => {
    Git.limits.status = 1; Git.limits.statusTracked = 1;
    try {
      const g = await Git.gitState(slow, true);
      assert(g.state === 'error' && /took longer than \d+ seconds/.test(g.reason) && !/Command failed|-c core/.test(g.reason), JSON.stringify(g));
    } finally { Object.assign(Git.limits, keep); }
  });

  await check('a worktree whose main repository is gone is named as that, not as "Command failed"', async () => {
    const main = repo('main-gone'); save(main, 'a.txt', '1');
    const wt = path.join(tmp, 'side-copy');
    git(main, 'worktree', 'add', '-q', wt);
    fs.rmSync(path.join(main, '.git'), { recursive: true, force: true });
    const g = await Git.gitState(wt, true);
    assert(g.state === 'error' && /worktree/.test(g.reason) && /not there any more/.test(g.reason), JSON.stringify(g));
  });

  await check('a worktree that works is read like any repository', async () => {
    const main = repo('main-here'); save(main, 'a.txt', '1');
    const wt = path.join(tmp, 'side-here');
    git(main, 'worktree', 'add', '-q', '-b', 'side', wt);
    const g = await Git.gitState(wt, true);
    assert(g.state === 'local' && g.branch === 'side', JSON.stringify(g));
  });

  await check('another git failure keeps git\'s own reason, without "fatal:" or the command line', async () => {
    const d = path.join(tmp, 'broken'); fs.mkdirSync(path.join(d, '.git'), { recursive: true });
    fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'not a ref');
    const g = await Git.gitState(d, true);
    assert(g.state === 'error' && !/^fatal|Command failed|-c core/.test(g.reason), JSON.stringify(g));
  });

  await check('the list answers from a stale folder walk at once and walks again behind it', async () => {
    const root = path.join(tmp, 'work'); const d = path.join(root, 'shop'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'README.md'), 'A made-up shop for the tests, with a long enough first line.\n');
    const settings = { workingFolders: [root], extraProjects: [], hidden: [] };
    const first = (await P.listProjectsAsync(settings, {}))[0].updated;
    const later = Date.now() + 5000;
    fs.utimesSync(path.join(d, 'README.md'), later / 1000, later / 1000);
    const realNow = Date.now;
    Date.now = () => realNow() + 120000; // the walk is past its minute
    try {
      assert.strictEqual((await P.listProjectsAsync(settings, {}))[0].updated, first, 'the stale walk is used, not waited for');
      await until(() => P.listProjects(settings, { stale: true })[0].updated !== first, 5000);
    } finally { Date.now = realNow; }
    assert(Math.abs(P.listProjects(settings, { stale: true })[0].updated - later) < 2000);
  });

  await check('root launch entries read once still pick only the folder they name', async () => {
    const root = path.join(tmp, 'roots'); fs.mkdirSync(path.join(root, 'shop', 'site'), { recursive: true }); fs.mkdirSync(path.join(root, 'dev'));
    const launch = { configurations: [
      { name: 'shop', runtimeExecutable: 'php', runtimeArgs: ['-S', 'localhost:8100', '-t', 'shop/site'], port: 8100 },
      { name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 8101 },
      { name: 'gone', runtimeExecutable: 'php', runtimeArgs: ['-t', 'dev/missing'], port: 8102 },
    ] };
    const shop = P.startCommands(root, path.join(root, 'shop'), launch, null);
    const dev = P.startCommands(root, path.join(root, 'dev'), launch, null);
    assert.deepStrictEqual(shop.map(c => c.name), ['shop']);
    assert.deepStrictEqual(dev.map(c => c.name), [], '"npm run dev" is not the dev folder, and a path that is not there is not it either');
    assert.deepStrictEqual(P.startCommands(root, path.join(root, 'shop'), 'not an object', null), []);
  });

  // ---- The page: the row's chip and problem line, and the status bar's words (panels.js, run with stand-ins) ----
  const page = vm.createContext({ console, Set, Map, Date, Math, JSON, String, Number });
  vm.runInContext('const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, text: kids.flat().filter(k => typeof k === "string").join("") }); let rows = [];', page);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/bridge/js/panels.js'), 'utf8'), page);
  const run = code => vm.runInContext(code, page);
  await check('page: a row being checked says so, with or without a last state', async () => {
    assert.strictEqual(run('gitLabel({ state: "checking", checking: true }).text'), 'Checking git…');
    assert.strictEqual(run('gitLabel({ state: "local", checking: true }).text'), 'Only on this PC · checking…');
    assert.strictEqual(run('gitLabel({ state: "local" }).text'), 'Only on this PC');
  });
  await check('page: a git problem is named on its row, and the bar says how many with a link of its own', async () => {
    run(`rows = [
      { id: 'a', name: 'Shop', git: { state: 'error', reason: 'git took longer than 30 seconds to read this folder, so its state is not known.' } },
      { id: 'b', name: 'Blog', git: { state: 'error', reason: 'git refuses this folder: it belongs to another user account.' } },
      { id: 'c', name: 'Notes', git: { state: 'local', checking: true } },
      { id: 'd', name: 'Site', git: { state: 'ok' } }]`);
    assert.strictEqual(run('gitProblems().length'), 2);
    const line = run('gitProblemLine(rows[0])');
    assert(line && /^Git problem: git took longer than 30 seconds/.test(line.text), JSON.stringify(line));
    assert.strictEqual(run('gitProblemLine(rows[3])'), null);
    const bar = run('gitSummary()');
    assert(!/error|problem/i.test(bar) && /1 checking/.test(bar) && /1 backed up/.test(bar), bar);
    assert.strictEqual(run('plural(gitProblems().length, "project", "projects") + " with a git problem"'), '2 projects with a git problem');
  });

  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
})();
