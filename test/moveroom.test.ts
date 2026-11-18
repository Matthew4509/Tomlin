// The Move window's tiles: the free space shown, and "not enough", are the drive a model would be written to on that PC
// (its models folder's drive), not its backup disk. An older PC that names no drives: its one disk, as before.
// Run: node --test test/moveroom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanDriveLetter, modelRoom } from '../src/carry.ts';

const GB = 2 ** 30;
const drives = [
  { drive: 'C:', label: '', total: 500 * GB, free: 20 * GB },
  { drive: 'D:', label: 'Models', total: 4000 * GB, free: 1500 * GB },
];

test('a PC that keeps its models on D: shows D:\'s free space, not its backup disk\'s', () => {
  assert.deepEqual(modelRoom({ disk: { total: 500 * GB, free: 20 * GB }, drives, modelsDrive: 'D:' }), { drive: 'D:', label: 'Models', total: 4000 * GB, free: 1500 * GB });
  // Models on C:, backups on D:: C: is what counts for a model.
  assert.equal(modelRoom({ disk: { total: 4000 * GB, free: 1500 * GB }, drives, modelsDrive: 'C:' })!.free, 20 * GB);
});

test('an older PC (no drives, or no models drive said): its one disk, as before; nothing known: null', () => {
  assert.deepEqual(modelRoom({ disk: { total: 500 * GB, free: 20 * GB } }), { drive: '', label: '', total: 500 * GB, free: 20 * GB });
  assert.deepEqual(modelRoom({ disk: { total: 500 * GB, free: 20 * GB }, drives, modelsDrive: '' }), { drive: '', label: '', total: 500 * GB, free: 20 * GB });
  // A models drive not in its list (a drive unplugged since): its one disk.
  assert.equal(modelRoom({ disk: { total: 1, free: 1 }, drives, modelsDrive: 'F:' })!.free, 1);
  assert.equal(modelRoom({ disk: null }), null);
});

test('the models drive in a hello is a drive letter or nothing', () => {
  assert.equal(cleanDriveLetter('d:'), 'D:');
  assert.equal(cleanDriveLetter('\\\\nas\\share'), '');
  assert.equal(cleanDriveLetter('D:\\models'), '');
  assert.equal(cleanDriveLetter(undefined), '');
});

test('the node says its models drive, the targets use it, and the tile names the drive and judges against it', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const node = read('../src/jobrun/node.ts');
  assert.match(node, /const modelsDrive = driveOf\(d\.carry\.chatDir\);/);
  assert.equal((node.match(/installed, disk, drives, modelsDrive, runner: runnerHello\(\)/g) ?? []).length, 2, 'in both hellos (away and not)');
  assert.match(read('../src/jobrun/links.ts'), /modelsDrive: carry\.cleanDriveLetter\(data\.modelsDrive\)/);
  assert.match(read('../src/jobrun/copies.ts'), /disk: carry\.modelRoom\(pc\) \}\)\);/);
  const move = read('../public/modelmove.js');
  assert.match(move, /const noRoom = t\.disk && t\.disk\.free < m\.bytes && !held\(t\);/);
  assert.match(move, /`Free space\$\{t\.disk\.drive \? ` on \$\{t\.disk\.drive\}` : ''\}: /);
});
