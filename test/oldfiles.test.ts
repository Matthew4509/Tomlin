// Files left behind (src/oldfiles.ts, src/diskcare.ts sweepOldParts): a ".part" nothing wrote to for 7 days goes from
// the known folders only, one still being written stays, nothing else is touched; runner zips no pin names go. On real
// temp folders.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PART_AGE_MS, sweepParts, sweepUnpinned } from '../src/oldfiles.ts';
import { partFolders, sweepOldParts } from '../src/diskcare.ts';
import { Runtimes } from '../src/runtimes.ts';

const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-oldfiles-'));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const DAY = 24 * 3600_000;
/** A small file, last written `days` ago. */
const put = (file: string, days = 0, bytes = 100) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, Buffer.alloc(bytes));
  const t = new Date(Date.now() - days * DAY);
  utimesSync(file, t, t);
  return file;
};

test('a part untouched for 7 days goes; a newer one, another name, or one in a folder inside stays', async () => {
  const dir = tmp();
  const stale = put(join(dir, 'Qwen3-8B-Q4_K_M.gguf.part'), 8, 300);
  const young = put(join(dir, 'gemma.gguf.part'), 6);
  const model = put(join(dir, 'old-model.gguf'), 400);
  const deeper = put(join(dir, 'sub', 'x.gguf.part'), 30);
  const bare = put(join(dir, '.part'), 30);
  mkdirSync(join(dir, 'folder.part'));
  const r = await sweepParts([dir, dir.toUpperCase(), join(dir, 'not there')]);
  assert.deepEqual({ files: r.files, bytes: r.bytes, names: r.names }, { files: 1, bytes: 300, names: [stale] });
  for (const f of [young, model, deeper, bare]) assert.ok(existsSync(f), f);
  assert.ok(existsSync(join(dir, 'folder.part')));
  assert.equal(PART_AGE_MS, 7 * DAY);
  // A part being written now is written to: it stays however old the download is.
  const live = put(join(dir, 'live.gguf.part'), 30);
  writeFileSync(live, Buffer.alloc(200), { flag: 'a' });
  assert.equal((await sweepParts([dir])).files, 0);
  // Only the ending asked for (a restore point's ".zip.part").
  const point = put(join(dir, '2026-10-06 101500 by hand.zip.part'), 9);
  assert.equal((await sweepParts([dir], { ending: '.zip.part' })).files, 1);
  assert.ok(!existsSync(point) && existsSync(live));
});

test('the old parts of a home: models folders, runner downloads and restore points sent here, and nothing beside them', async () => {
  const home = tmp();
  const models = join(home, 'models');
  const other = join(home, 'D-models');
  const keptRoot = join(home, 'backups from other PCs');
  const gone = [
    put(join(models, 'chat', 'a.gguf.part'), 10),
    put(join(other, 'image', 'flux.gguf.part'), 10),
    put(join(models, 'image', 'loras', 'l.safetensors.part'), 10),
    put(join(models, 'helpers', 'taesd.safetensors.part'), 10),
    put(join(home, 'runtime', '_downloads', 'llama-cuda.zip.part'), 10),
    put(join(keptRoot, 'aaaa1111', '2026-10-06 101500 by hand.zip.part'), 10),
  ];
  const stays = [
    put(join(models, 'chat', 'b.gguf.part'), 1),
    put(join(models, 'chat', 'whole.gguf'), 100),
    put(join(home, 'data', 'chat.json.part'), 100),
    put(join(home, 'workspace.part'), 100),
    put(join(keptRoot, 'aaaa1111', 'notes.part'), 100),
    put(join(keptRoot, 'aaaa1111', 'projects.git', 'incoming', `${'a'.repeat(40)}.part`), 100),
  ];
  assert.deepEqual(partFolders([models]), [join(models, 'chat'), join(models, 'image'), join(models, 'image', 'loras'), join(models, 'helpers')]);
  const r = await sweepOldParts({ models: () => [models, other], keptRoot, runtimes: { downloadsDir: join(home, 'runtime', '_downloads'), downloadNames: () => [] } });
  assert.equal(r.files, gone.length);
  for (const f of gone) assert.ok(!existsSync(f), f);
  for (const f of stays) assert.ok(existsSync(f), f);
});

test('runner zips no pin names go at the start; a pinned zip, its part, and folders stay; no pins read, nothing goes', async () => {
  const home = tmp();
  const pins = join(home, 'runtimes.json');
  writeFileSync(pins, JSON.stringify({ runtimes: {
    'llama-cuda': { engine: 'llama', device: 'cuda', name: 'llama.cpp b12250, CUDA 12.4', licence: 'MIT', parts: [{ url: 'https://example.invalid/b12250/llama-b12250-bin-win-cuda-12.4-x64.zip', bytes: 1, sha256: 'x' }, { url: 'https://example.invalid/b12250/cudart-llama-bin-win-cuda-12.4-x64.zip', bytes: 1, sha256: 'y' }] },
  } }));
  const rt = new Runtimes(join(home, 'app-runtime'), pins, join(home, 'runtime'));
  assert.equal(rt.downloadsDir, join(home, 'runtime', '_downloads'));
  assert.deepEqual(rt.downloadNames(), ['llama-b12250-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip']);
  const dl = rt.downloadsDir;
  const old = [put(join(dl, 'llama-b11284-bin-win-cuda-12.4-x64.zip'), 0, 500), put(join(dl, 'llama-b11284-bin-win-cuda-12.4-x64.zip.part'), 0, 50)];
  const kept = [put(join(dl, 'llama-b12250-bin-win-cuda-12.4-x64.zip')), put(join(dl, 'CUDART-llama-bin-win-cuda-12.4-x64.zip.part')), put(join(dl, 'inner', 'old.zip'))];
  assert.deepEqual(await sweepUnpinned(dl, []), { files: 0, bytes: 0, names: [] });
  const r = await sweepUnpinned(dl, rt.downloadNames());
  assert.equal(r.files, 2);
  assert.equal(r.bytes, 550);
  for (const f of old) assert.ok(!existsSync(f), f);
  for (const f of kept) assert.ok(existsSync(f), f);
  assert.deepEqual(await sweepUnpinned(join(home, 'none'), rt.downloadNames()), { files: 0, bytes: 0, names: [] });
});
