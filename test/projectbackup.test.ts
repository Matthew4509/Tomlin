// Bridge projects in the node backups (src/projectbackup.ts): what a project's copy takes, and its name in the backup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync, closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_FILE, cleanChosen, keyOf, namesOf, projectFiles } from '../src/projectbackup.ts';

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('the ticked list keeps each folder once, whole paths only', () => {
  const c = cleanChosen({ dirs: ['C:\\Work\\shop', 'c:\\work\\SHOP', '', 7, 'C:\\Work\\blog'] });
  assert.deepEqual(c.dirs.map(d => d.toLowerCase()), ['c:\\work\\shop', 'c:\\work\\blog']);
  assert.deepEqual(cleanChosen(null), { dirs: [] });
});

test('a project is named by its folder; two with the same name each get a mark of their own path, always the same', () => {
  const a = 'C:\\One\\site', b = 'D:\\Two\\site', c = 'C:\\One\\blog';
  const n = namesOf([a, b, c]);
  assert.equal(n.get(keyOf(c)), 'blog');
  assert.match(n.get(keyOf(a))!, /^site [0-9a-f]{6}$/);
  assert.notEqual(n.get(keyOf(a)), n.get(keyOf(b)));
  assert.equal(namesOf([b, a, c]).get(keyOf(a)), n.get(keyOf(a)), 'the order does not change a name');
});

test('a plain folder: everything but .git and node_modules; a file over 256 MB is left out and named', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-pb-'));
  try {
    writeFileSync(join(dir, 'index.html'), '<p>hi</p>');
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'i.js'), '1');
    const big = join(dir, 'video.mp4');
    closeSync(openSync(big, 'w'));
    truncateSync(big, MAX_FILE + 1);
    const got = await projectFiles(dir);
    assert.equal(got.how, 'folder');
    assert.deepEqual(got.files.map(f => f.path), ['index.html']);
    assert.deepEqual(got.left.map(f => f.path), ['video.mp4']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a git repository: what git keeps (saved and new files), never what .gitignore leaves out', { skip: !hasGit && 'git is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-pb-git-'));
  try {
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
    git('init', '-q');
    writeFileSync(join(dir, '.gitignore'), 'dist/\n*.gguf\n');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)\n');
    git('add', '-A');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.org', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first');
    writeFileSync(join(dir, 'new.js'), '2\n');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'built');
    writeFileSync(join(dir, 'model.gguf'), 'weights');
    const got = await projectFiles(dir);
    assert.equal(got.how, 'git');
    assert.deepEqual(got.files.map(f => f.path), ['.gitignore', 'app.js', 'new.js']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a repository whose settings could run a program is not read with git: the plain walk instead, and why', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-pb-risky-'));
  try {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'config'), '[core]\n\tfsmonitor = run-me.exe\n');
    writeFileSync(join(dir, 'a.txt'), 'a');
    const got = await projectFiles(dir);
    assert.equal(got.how, 'folder');
    assert.match(got.note ?? '', /could run a program/);
    assert.deepEqual(got.files.map(f => f.path), ['a.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
