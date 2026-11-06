// 6 Nov slow-start plan, fix 6: a backup that would fill the drive is not started; the start goes on and says why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BACKUP_SPARE, noRoomWhy } from '../src/keep.ts';

const GB = 2 ** 30;

test('a backup that fits with the spare room left starts', () => {
  assert.equal(noRoomWhy(1 * GB, 1 * GB + BACKUP_SPARE), null);
  assert.equal(noRoomWhy(0, BACKUP_SPARE), null);
});

test('one that would leave less than the spare room is not started, and says how much is needed and free', () => {
  const why = noRoomWhy(12 * GB, 5 * GB);
  assert.ok(why);
  assert.match(why, /not enough free space/);
  assert.match(why, /14\.0 GB is needed and 5\.0 GB is free/);
});

test('a drive whose free space could not be read does not stop a backup', () => {
  assert.equal(noRoomWhy(100 * GB, null), null);
});

test('the backup checks the room before it writes the zip', () => {
  const src = readFileSync(new URL('../src/keep.ts', import.meta.url), 'utf8');
  const at = src.indexOf('const noRoom = noRoomWhy(');
  assert.ok(at > 0 && at < src.indexOf('const made = await writeZip(part, items);'));
  assert.match(src, /if \(noRoom\) throw new Error\(noRoom\);/);
});
