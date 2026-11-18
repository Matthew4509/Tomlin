import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveAdvice, roomSuggested, roomWarned } from '../src/driveadvice.ts';

const GB = 2 ** 30;

test('the drive the models are kept on: twice the RAM free is enough, less than the RAM free is warned about', () => {
  // 32 GB of RAM: 64 GB free is fine.
  assert.equal(driveAdvice(32 * GB, 64 * GB, 'D:'), '');
  assert.equal(roomSuggested(32 * GB), 64 * GB);
  // 256 GB of RAM: 512 GB free is wanted; under it a suggestion, under 256 GB a warning.
  assert.equal(driveAdvice(256 * GB, 512 * GB, 'D:'), '');
  assert.match(driveAdvice(256 * GB, 400 * GB, 'D:'), /400 GB free on D:\. With 256 GB of RAM.*About 512 GB free is suggested.*Nothing is stopped/);
  assert.match(driveAdvice(256 * GB, 100 * GB, 'D:'), /^Only 100 GB free on D:, and this PC has 256 GB of RAM/);
  // 1 TB of RAM: 1 TB free at least (below it a warning), 2 TB preferred.
  assert.equal(roomWarned(1024 * GB), 1024 * GB);
  assert.match(driveAdvice(1024 * GB, 900 * GB, 'E:'), /^Only 900 GB free/);
  assert.match(driveAdvice(1024 * GB, 1500 * GB, 'E:'), /^1\.5 TB free on E:\. With 1 TB of RAM.*About 2 TB free is suggested/);
  assert.equal(driveAdvice(1024 * GB, 2100 * GB, 'E:'), '');
});

test('a small PC is not told 16 GB is plenty; nothing known says nothing; a drive too small for it is said', () => {
  assert.equal(roomSuggested(8 * GB), 64 * GB);
  assert.match(driveAdvice(8 * GB, 20 * GB, 'C:'), /^Only 20 GB free on C:/);
  assert.match(driveAdvice(8 * GB, 40 * GB, 'C:'), /^40 GB free on C:. With 8 GB of RAM/, 'between half the floor and the floor: a suggestion, not a warning');
});

test('advice only: it says nothing when the free space or the RAM is not known', () => {
  assert.equal(driveAdvice(0, 10 * GB), '');
  assert.equal(driveAdvice(64 * GB, null), '');
  assert.equal(driveAdvice(64 * GB, Infinity), '');
  assert.match(driveAdvice(256 * GB, 300 * GB, 'D:', 480 * GB), /The whole drive is 480 GB: a larger one is suggested/);
  assert.doesNotMatch(driveAdvice(256 * GB, 300 * GB, 'D:', 2048 * GB), /whole drive/);
});
