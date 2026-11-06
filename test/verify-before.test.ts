// Run and check (6 Nov known fault 5): the files before a repair round were kept in memory only, so a restart between a
// repair and its check lost them and a repair that made the project worse could no longer be put back.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useDeps } from '../src/jobrun/shared.ts';
import { clearBeforeRepair, loadBeforeRepair, saveBeforeRepair } from '../src/jobrun/jobfiles.ts';

const wsDir = await mkdtemp(join(tmpdir(), 'tomlin-verify-before-'));
after(() => rm(wsDir, { recursive: true, force: true }));
useDeps({ workspaceDir: async () => wsDir } as never);
await mkdir(join(wsDir, 'jobs', 'j1'), { recursive: true });

test('the files before a repair are kept in the job folder and read back (as after a restart)', async () => {
  const files = { 'index.html': '<p>before</p>', 'app.js': 'let a = 1;\n' };
  await saveBeforeRepair('j1', files);
  assert.deepEqual(JSON.parse(await readFile(join(wsDir, 'jobs', 'j1', 'verify-before.json'), 'utf8')), files);
  assert.deepEqual(await loadBeforeRepair('j1'), files);
});

test('cleared after use: nothing to put back', async () => {
  await saveBeforeRepair('j1', { 'a.js': 'x' });
  await clearBeforeRepair('j1');
  assert.equal(await loadBeforeRepair('j1'), null);
  await clearBeforeRepair('j1');
});

test('a missing, broken or wrong-shaped file is no snapshot', async () => {
  assert.equal(await loadBeforeRepair('none'), null);
  const f = join(wsDir, 'jobs', 'j1', 'verify-before.json');
  await writeFile(f, '{not json');
  assert.equal(await loadBeforeRepair('j1'), null);
  await writeFile(f, JSON.stringify(['a.js']));
  assert.equal(await loadBeforeRepair('j1'), null);
  await writeFile(f, JSON.stringify({ 'a.js': 5 }));
  assert.equal(await loadBeforeRepair('j1'), null);
});

test('the run-and-check code uses the kept file, not a list in memory', async () => {
  const src = await readFile(new URL('../src/jobrun/actions.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /verifySnapshots/);
  assert.match(src, /const before = await loadBeforeRepair\(id\);/);
  assert.match(src, /await saveBeforeRepair\(id, texts\);/);
});
