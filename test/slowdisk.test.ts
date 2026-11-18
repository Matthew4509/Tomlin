// A model on a hard disk: Windows' answer read as a kind per drive, the SSD it could move to, how fast a drive gave up
// its models, and one model's parts moved with the usual move. Run: node --test test/slowdisk.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driveReadSpeeds, kindsFrom, modelFiles, moveFiles, ssdTarget, type Drive } from '../src/modelhome.ts';

const GB = 2 ** 30;
const drive = (letter: string, free: number, more: Partial<Drive> = {}): Drive => ({ drive: letter, label: '', removable: false, fs: 'NTFS', free, total: 2000 * GB, ...more });

test('Windows says HDD or SSD per drive; Unspecified, nothing or junk says nothing', () => {
  assert.deepEqual(kindsFrom('[{"d":"C","m":"SSD"},{"d":"D","m":"HDD"},{"d":"E","m":"Unspecified"}]'), { 'C:': 'ssd', 'D:': 'hdd' });
  // Some Windows versions give the numbers: 3 a hard disk, 4 an SSD, 5 storage-class memory.
  assert.deepEqual(kindsFrom('[{"d":"c","m":"4"},{"d":"D","m":"3"},{"d":"F","m":"5"},{"d":"G","m":"0"}]'), { 'C:': 'ssd', 'D:': 'hdd', 'F:': 'ssd' });
  // One drive alone comes as an object, not a list.
  assert.deepEqual(kindsFrom('{"d":"C","m":"SSD"}'), { 'C:': 'ssd' });
  // A drive letter over two disks, one of them a hard disk: as slow as a hard disk.
  assert.deepEqual(kindsFrom('[{"d":"D","m":"SSD"},{"d":"D","m":"HDD"}]'), { 'D:': 'hdd' });
  assert.deepEqual(kindsFrom(''), {});
  assert.deepEqual(kindsFrom('not json'), {});
  assert.deepEqual(kindsFrom('[{"d":"","m":"SSD"},null,{"m":"HDD"}]'), {});
});

test('a model on a hard disk goes to the chosen models folder when that is on an SSD with room', () => {
  const all = [drive('C:', 300 * GB), drive('D:', 900 * GB)];
  const kinds = { 'C:': 'ssd', 'D:': 'hdd' } as const;
  assert.deepEqual(ssdTarget('D:\\old models\\chat\\big.gguf', 20 * GB, 'C:\\Users\\someone\\TOMLIN\\models', all, kinds), { drive: 'C:', dir: 'C:\\Users\\someone\\TOMLIN\\models', free: 300 * GB, newHome: false });
});

test('the chosen folder on the hard disk: the SSD with the most room, in a new folder that becomes the home', () => {
  const all = [drive('C:', 60 * GB), drive('D:', 900 * GB), drive('E:', 400 * GB)];
  const kinds = { 'C:': 'ssd', 'D:': 'hdd', 'E:': 'ssd' } as const;
  assert.deepEqual(ssdTarget('D:\\TOMLIN models\\chat\\big.gguf', 20 * GB, 'D:\\TOMLIN models', all, kinds), { drive: 'E:', dir: 'E:\\TOMLIN models', free: 400 * GB, newHome: true });
});

test('no button: not on a hard disk, Windows did not say, no SSD has room, or the SSD is removable or FAT', () => {
  const kinds = { 'C:': 'ssd', 'D:': 'hdd' } as const;
  const home = 'C:\\TOMLIN\\models';
  assert.equal(ssdTarget('C:\\TOMLIN\\models\\chat\\a.gguf', GB, home, [drive('C:', 100 * GB)], kinds), null, 'already on an SSD');
  assert.equal(ssdTarget('F:\\m\\a.gguf', GB, home, [drive('C:', 100 * GB), drive('F:', 100 * GB)], kinds), null, 'Windows did not say what F: is');
  // Room means its size and 2 GB to spare.
  assert.equal(ssdTarget('D:\\m\\a.gguf', 10 * GB, home, [drive('C:', 11.9 * GB), drive('D:', 100 * GB)], kinds), null);
  assert.ok(ssdTarget('D:\\m\\a.gguf', 10 * GB, home, [drive('C:', 12.1 * GB), drive('D:', 100 * GB)], kinds));
  const other = { 'D:': 'hdd', 'E:': 'ssd' } as const;
  assert.equal(ssdTarget('D:\\m\\a.gguf', GB, 'D:\\m', [drive('E:', 100 * GB, { removable: true })], other), null, 'a USB stick is not offered');
  assert.equal(ssdTarget('D:\\m\\a.gguf', GB, 'D:\\m', [drive('E:', 100 * GB, { fs: 'FAT32' })], other), null, 'FAT cannot hold a big model');
});

test('a drive\'s read speed: the best of the loads timed from it; none timed, not known', () => {
  assert.deepEqual(driveReadSpeeds([
    { drive: 'D:', bytes: 10 * GB, seconds: 100 },
    { drive: 'D:', bytes: 4 * GB, seconds: 20 },
    { drive: 'C:', bytes: 2 * GB, seconds: 0 },
  ]), { 'D:': (4 * GB) / 20 });
  assert.deepEqual(driveReadSpeeds([]), {});
});

test('one model\'s parts move together into the same place inside the new folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tomlin-ssd-'));
  try {
    const from = join(root, 'hdd', 'chat', 'sub');
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, 'Big-Q4_K_M-00001-of-00002.gguf'), 'aaaa');
    writeFileSync(join(from, 'Big-Q4_K_M-00002-of-00002.gguf'), 'bb');
    writeFileSync(join(from, 'Other.gguf'), 'c');
    const files = modelFiles([join(from, 'Big-Q4_K_M-00001-of-00002.gguf'), join(from, 'Big-Q4_K_M-00002-of-00002.gguf'), join(from, 'gone.gguf')], 'chat/sub');
    assert.deepEqual(files.map(f => [f.rel, f.bytes]), [['chat/sub/Big-Q4_K_M-00001-of-00002.gguf', 4], ['chat/sub/Big-Q4_K_M-00002-of-00002.gguf', 2]], 'a file not there is left out');
    const to = join(root, 'ssd');
    const s = await moveFiles(files, to, { free: async () => Infinity });
    assert.equal(s.state, 'done');
    assert.equal(s.moved, 2);
    assert.equal(readFileSync(join(to, 'chat', 'sub', 'Big-Q4_K_M-00001-of-00002.gguf'), 'utf8'), 'aaaa');
    assert.equal(existsSync(join(from, 'Big-Q4_K_M-00001-of-00002.gguf')), false);
    assert.equal(existsSync(join(from, 'Other.gguf')), true, 'another model in the same folder stays');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the row: the HDD mark, the line, Move to SSD only with a place to go, and nothing blocks a load', () => {
  const pcs = readFileSync(new URL('../public/pcs.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const line = /function diskLine\(v, x\) \{[\s\S]*?\n  \}\n/.exec(pcs)?.[0] ?? '';
  assert.match(line, /if \(!d \|\| \(!d\.hdd && !d\.loadSeconds\)\) return null;/, 'Windows did not say and no time known: nothing');
  assert.match(line, /'Move to SSD for better performance\.'/);
  assert.match(line, /if \(d\.hdd && d\.ssd && d\.canMove\)/);
  assert.match(pcs, /text: 'HDD' \}\) : null\)/);
  const server = readFileSync(new URL('../src/server/modelhome.ts', import.meta.url), 'utf8');
  assert.match(server, /'\/api\/models\/to-ssd'/);
  const panes = readFileSync(new URL('../src/server/panes.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(panes, /hdd|ssdTarget/i, 'loading does not look at the drive');
});
