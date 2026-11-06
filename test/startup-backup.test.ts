// Slow start after a version change: the Max mode weight
// cache (data/max-cache, rebuildable, ~12 GB on a test PC) is not in a backup and a restore keeps the live one; an older
// TOMLIN started on data a newer one used makes no backup (each switch between versions made another 12 GB zip).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as keep from '../src/keep.ts';
import { zipEntries } from '../src/newcopy.ts';

async function put(file: string, text: string | Buffer) {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, text);
}

async function home() {
  const top = await mkdtemp(join(tmpdir(), 'sm-start-'));
  const root = join(top, 'apps', 'tomlin-2.0.75');
  await put(join(root, 'package.json'), JSON.stringify({ name: 'tomlin', version: '2.0.75' }));
  const h = keep.resolveHome({ TOMLIN_HOME: join(top, 'TOMLIN') });
  await put(join(h.data, 'settings.json'), '{"v":1}');
  await put(join(h.data, 'chats', 'index.json'), '[]');
  return { top, root, h };
}

test('a data backup leaves out the Max mode weight cache (data/max-cache) and keeps chats and settings', async () => {
  const w = await home();
  try {
    await put(join(w.h.data, 'max-cache', 'abc123.bin'), Buffer.alloc(2_000_000, 7));
    const name = await keep.backup(w.h, 'before test');
    const names = (await zipEntries(join(w.h.backups, name))).map(e => e.name);
    assert.ok(names.some(n => /settings\.json$/.test(n)));
    assert.ok(names.some(n => /chats\/index\.json$/.test(n)));
    assert.ok(!names.some(n => /max-cache/.test(n)), names.join(', '));
    assert.ok((await stat(join(w.h.backups, name))).size < 100_000, 'the 2 MB cache file is not in the zip');
  } finally {
    await rm(w.top, { recursive: true, force: true });
  }
});

test('a restore keeps the live weight cache in place (it is never in the backup)', async () => {
  const w = await home();
  try {
    await keep.prepare(w.h, w.root, '2.0.75');
    const name = await keep.backup(w.h, 'by hand');
    await put(join(w.h.data, 'settings.json'), '{"v":2}');
    await put(join(w.h.data, 'max-cache', 'abc123.bin'), 'weights');
    await keep.planNext(w.h, { do: 'restore', name });
    await keep.prepare(w.h, w.root, '2.0.75');
    assert.equal(await readFile(join(w.h.data, 'settings.json'), 'utf8'), '{"v":1}');
    assert.equal(await readFile(join(w.h.data, 'max-cache', 'abc123.bin'), 'utf8'), 'weights');
    assert.ok(!existsSync(`${w.h.data}.old`));
  } finally {
    await rm(w.top, { recursive: true, force: true });
  }
});

test('an older TOMLIN started on data a newer one used makes no backup, says so, and the newer one makes none either when it comes back', async () => {
  const w = await home();
  try {
    await keep.prepare(w.h, w.root, '2.0.72');
    const after72 = (await keep.listBackups(w.h)).length;
    const back = await keep.prepare(w.h, w.root, '2.0.67');
    assert.equal(back.state, 'ready');
    assert.equal((await keep.listBackups(w.h)).length, after72, 'no backup for an older version');
    assert.match(back.state === 'ready' ? back.note ?? '' : '', /TOMLIN 2\.0\.67 is older than the version that last used your data \(2\.0\.72\)/);
    // The data stays marked as 2.0.72's, so going back to 2.0.72 is not a version change: no 12 GB backup again.
    assert.equal(keep.readVersion(w.h)?.app, '2.0.72');
    await keep.prepare(w.h, w.root, '2.0.72');
    assert.equal((await keep.listBackups(w.h)).length, after72);
    // A real update still backs up first.
    await keep.prepare(w.h, w.root, '2.0.75');
    assert.equal((await keep.listBackups(w.h)).length, after72 + 1);
  } finally {
    await rm(w.top, { recursive: true, force: true });
  }
});
