// The disk line in the log (src/disklog.ts): at start and every 6 hours, the free and total space of the data drive, of
// the models drive when it is another, and the size of the weight cache. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISK_LOG_MS, diskLine, diskWords, driveOf, folderSize, startDiskLog } from '../src/disklog.ts';

const GB = 2 ** 30;

test('the line in plain words: the data drive, the models drive when it is another, the weight cache', () => {
  assert.equal(diskWords({ data: { drive: 'C:', free: 113.4 * GB, total: 238 * GB }, cache: 24 * GB }), 'Disk: C: has 113 GB free of 238 GB; weight cache 24 GB.');
  assert.equal(diskWords({ data: { drive: 'C:', free: 3.24 * GB, total: 238 * GB }, models: { drive: 'D:', free: 500 * GB, total: 931 * GB }, cache: 0.5 * GB }), 'Disk: C: has 3.2 GB free of 238 GB; D: (models) has 500 GB free of 931 GB; weight cache 0.5 GB.');
  // The same drive is said once; no cache folder yet; a drive that could not be read.
  assert.equal(diskWords({ data: { drive: 'C:', free: 50 * GB, total: 100 * GB }, models: { drive: 'C:', free: 50 * GB, total: 100 * GB }, cache: null }), 'Disk: C: has 50 GB free of 100 GB; no weight cache.');
  assert.equal(diskWords({ data: null, cache: null }), 'Disk: the data drive could not be read; no weight cache.');
});

test('the drive of a folder', { skip: process.platform !== 'win32' }, () => {
  assert.equal(driveOf('c:\\Users\\x\\TOMLIN'), 'C:');
  assert.equal(driveOf('D:/models'), 'D:');
});

test('the cache folder is measured with the folders under it; a missing one is null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-disklog-'));
  try {
    await mkdir(join(dir, 'rpc', 'a'), { recursive: true });
    await writeFile(join(dir, 'rpc', 'one.bin'), Buffer.alloc(1000));
    await writeFile(join(dir, 'rpc', 'a', 'two.bin'), Buffer.alloc(2500));
    assert.equal(await folderSize(dir), 3500);
    assert.equal(await folderSize(join(dir, 'not-there')), null);
    // The whole line from real folders: this drive once (models on the same drive), and the cache's size.
    const line = await diskLine({ dataDir: dir, modelsDir: () => join(dir, 'models'), cacheDir: dir });
    assert.match(line, /^Disk: \S+ has [\d.]+ GB free of [\d.]+ GB; weight cache 0\.0 GB\.$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('it is said at the start and then every 6 hours, and stops when asked', async () => {
  assert.equal(DISK_LOG_MS, 6 * 3600_000);
  const dir = await mkdtemp(join(tmpdir(), 'sm-disklog-'));
  try {
    const said: string[] = [];
    const stop = startDiskLog({ dataDir: dir, modelsDir: () => dir, cacheDir: join(dir, 'none'), say: l => said.push(l), firstMs: 0, everyMs: 60 });
    await new Promise(r => setTimeout(r, 250));
    stop();
    const n = said.length;
    assert.ok(n >= 2, `${n} lines`);
    assert.match(said[0], /^Disk: .*; no weight cache\.$/);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(said.length, n, 'nothing after the stop');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // Started with the node's other timers, into the log.
  const node = await readFile(fileURLToPath(new URL('../src/jobrun/node.ts', import.meta.url)), 'utf8');
  assert.match(node, /startDiskLog\(\{ dataDir: d\.store\.dir, modelsDir: \(\) => d\.carry\.chatDir, cacheDir: cacheDirOf\(d\.store\.dir\), say: line => log\.info\('disk', line\)/);
});
