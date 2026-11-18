// current.txt follows the version that started (6 Nov slow-start plan, fix 4): switching between versions
// leaves it naming the one that started last, so the installed program does not start an older one over newer data.
// Only an installed copy moves it: a dev checkout, a worktree, a test copy or a copy started from a folder never does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as inst from '../src/installer.ts';

const made: string[] = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function copy(dir: string, version: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tomlin', version }));
}

function install() {
  const top = mkdtempSync(join(tmpdir(), 'sm-cur-'));
  made.push(top);
  const root = join(top, 'Programs', 'TOMLIN');
  writeFileSync(join((mkdirSync(root, { recursive: true }), root), 'TOMLIN.exe'), '');
  copy(join(root, 'tomlin-9.0.70'), '9.0.70');
  copy(join(root, 'tomlin-9.0.72'), '9.0.72');
  writeFileSync(join(root, 'current.txt'), 'tomlin-9.0.70');
  return { top, root, env: { TOMLIN_INSTALL_ROOT: root } as NodeJS.ProcessEnv };
}

test('current.txt names the copy that started last, switching between versions', () => {
  const w = install();
  const read = () => readFileSync(join(w.root, 'current.txt'), 'utf8');
  inst.followStarted(join(w.root, 'tomlin-9.0.72'), w.env);
  assert.equal(read(), 'tomlin-9.0.72');
  inst.followStarted(join(w.root, 'tomlin-9.0.70'), w.env);
  assert.equal(read(), 'tomlin-9.0.70');
  inst.followStarted(join(w.root, 'tomlin-9.0.72'), w.env);
  assert.equal(read(), 'tomlin-9.0.72');
});

test('a copy elsewhere is followed only when the installed program started it (tray), by its full path', () => {
  const w = install();
  const other = join(w.top, 'unzipped', 'tomlin-9.0.71');
  copy(other, '9.0.71');
  inst.followStarted(other, w.env);
  assert.equal(readFileSync(join(w.root, 'current.txt'), 'utf8'), 'tomlin-9.0.70');
  inst.followStarted(other, { ...w.env, TOMLIN_TRAY: '1' });
  assert.equal(readFileSync(join(w.root, 'current.txt'), 'utf8'), other);
});

test('a stray start never moves current.txt: a dev checkout, a worktree, the test runner', () => {
  const w = install();
  const read = () => readFileSync(join(w.root, 'current.txt'), 'utf8');
  // A git checkout (a .git folder), even started by the tray.
  const dev = join(w.top, 'projects', 'Tomlin');
  copy(dev, '9.0.73');
  mkdirSync(join(dev, '.git'));
  inst.followStarted(dev, w.env);
  inst.followStarted(dev, { ...w.env, TOMLIN_TRAY: '1' });
  assert.equal(read(), 'tomlin-9.0.70');
  // A git worktree (.git is a file there).
  const tree = join(dev, '.claude', 'worktrees', 'fix-1');
  copy(tree, '9.0.73');
  writeFileSync(join(tree, '.git'), 'gitdir: ../../../.git/worktrees/fix-1');
  inst.followStarted(tree, { ...w.env, TOMLIN_TRAY: '1' });
  assert.equal(read(), 'tomlin-9.0.70');
  // A checkout sitting in the install folder itself is still not followed.
  mkdirSync(join(w.root, 'tomlin-9.0.72', '.git'));
  inst.followStarted(join(w.root, 'tomlin-9.0.72'), w.env);
  assert.equal(read(), 'tomlin-9.0.70');
  // Started by the test runner (node --test sets NODE_TEST_CONTEXT in the processes it starts).
  inst.followStarted(join(w.root, 'tomlin-9.0.72'), { ...w.env, NODE_TEST_CONTEXT: 'child-v8' });
  assert.equal(read(), 'tomlin-9.0.70');
});

test('an in-place update and a tray start of the new copy follow it', () => {
  const w = install();
  copy(join(w.root, 'tomlin-9.0.74'), '9.0.74');
  inst.followStarted(join(w.root, 'tomlin-9.0.74'), { ...w.env, TOMLIN_TRAY: '1' });
  assert.equal(readFileSync(join(w.root, 'current.txt'), 'utf8'), 'tomlin-9.0.74');
});

test('mayFollow: only an installed copy', () => {
  const w = install();
  assert.equal(inst.mayFollow(join(w.root, 'tomlin-9.0.72'), w.root, {}), true);
  assert.equal(inst.mayFollow(join(w.top, 'elsewhere'), w.root, {}), false);
  assert.equal(inst.mayFollow(join(w.top, 'elsewhere'), w.root, { TOMLIN_TRAY: '1' }), true);
  assert.equal(inst.mayFollow(join(w.root, 'tomlin-9.0.72'), w.root, { TOMLIN_DATA: 'x' }), false);
  assert.equal(inst.mayFollow(join(w.root, 'tomlin-9.0.72'), w.root, { NODE_TEST_CONTEXT: 'child' }), false);
});

test('a test copy (TOMLIN_DATA set, as Connect Claude scratch copies are) never moves current.txt', () => {
  const w = install();
  const scratch = join(w.top, 'scratch', 'tomlin-9.0.72');
  copy(scratch, '9.0.72');
  inst.followStarted(scratch, { ...w.env, TOMLIN_DATA: join(w.top, 'scratch-data') });
  inst.followStarted(join(w.root, 'tomlin-9.0.72'), { ...w.env, TOMLIN_DATA: join(w.top, 'scratch-data') });
  assert.equal(readFileSync(join(w.root, 'current.txt'), 'utf8'), 'tomlin-9.0.70');
});

test('with no install (no current.txt), nothing is written', () => {
  const top = mkdtempSync(join(tmpdir(), 'sm-cur-'));
  made.push(top);
  const root = join(top, 'none');
  copy(join(top, 'tomlin-9.0.72'), '9.0.72');
  inst.followStarted(join(top, 'tomlin-9.0.72'), { TOMLIN_INSTALL_ROOT: root });
  assert.throws(() => readFileSync(join(root, 'current.txt')));
});
