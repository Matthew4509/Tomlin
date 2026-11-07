// current.txt follows the version that started (6 Nov slow-start plan, fix 4): switching between versions
// leaves it naming the one that started last, so the installed program does not start an older one over newer data.
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

test('a copy started from a folder elsewhere is named by its full path', () => {
  const w = install();
  const other = join(w.top, 'unzipped', 'tomlin-9.0.71');
  copy(other, '9.0.71');
  inst.followStarted(other, w.env);
  assert.equal(readFileSync(join(w.root, 'current.txt'), 'utf8'), other);
});

test('with no install (no current.txt), nothing is written', () => {
  const top = mkdtempSync(join(tmpdir(), 'sm-cur-'));
  made.push(top);
  const root = join(top, 'none');
  copy(join(top, 'tomlin-9.0.72'), '9.0.72');
  inst.followStarted(join(top, 'tomlin-9.0.72'), { TOMLIN_INSTALL_ROOT: root });
  assert.throws(() => readFileSync(join(root, 'current.txt')));
});
