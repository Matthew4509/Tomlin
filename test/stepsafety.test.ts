// A step's files are saved all or none, never over a newer change, never through a linked project folder; a link
// request is answered once.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useDeps } from '../src/jobrun/shared.ts';
import { jobRoot } from '../src/jobrun/jobfiles.ts';
import { acceptStep, textHash } from '../src/jobrun/steps.ts';
import { usePairNonce } from '../src/jobrun/node.ts';
import type { Job } from '../src/jobs.ts';

const top = await mkdtemp(join(tmpdir(), 'sm-stepsafety-'));
after(() => rm(top, { recursive: true, force: true }));
const wsDir = join(top, 'ws');
await mkdir(wsDir, { recursive: true });
useDeps({ workspaceDir: async () => wsDir } as never);

const job = (files: string[]): Job => ({ id: 'j' + Math.random().toString(16).slice(2, 10), goal: 'g', notes: '', steps: [{ title: 't', brief: 'b', files, status: 'todo' }] } as unknown as Job);

test('a project folder linked to outside the workspace is refused', async () => {
  const away = join(top, 'away');
  await mkdir(away, { recursive: true });
  await symlink(away, join(wsDir, 'linked'), 'junction');
  await assert.rejects(jobRoot({ folder: 'linked' }), /outside the workspace/);
  assert.equal(await jobRoot({ folder: 'plain' }), join(wsDir, 'plain'));
});

test('a later file that fails puts the earlier ones back', async () => {
  await writeFile(join(wsDir, 'first.js'), 'old');
  const j = job(['first.js', 'second.js']);
  const r = await acceptStep(j, 0, [{ path: 'first.js', text: 'new' }, { path: 'second.js', text: 'x'.repeat((1 << 20) + 1) }], 's');
  assert.ok('error' in r);
  assert.equal(await readFile(join(wsDir, 'first.js'), 'utf8'), 'old');
  assert.equal(j.steps[0]!.status, 'todo');
});

test('a file changed since the step read it is not overwritten', async () => {
  await writeFile(join(wsDir, 'a.js'), 'when the step ran');
  const base = { 'a.js': textHash('when the step ran') };
  await writeFile(join(wsDir, 'a.js'), 'edited after');
  const r = await acceptStep(job(['a.js']), 0, [{ path: 'a.js', text: 'generated' }], 's', false, base);
  assert.ok('error' in r && r.status === 409);
  assert.equal(await readFile(join(wsDir, 'a.js'), 'utf8'), 'edited after');
  const ok = await acceptStep(job(['a.js']), 0, [{ path: 'a.js', text: 'generated' }], 's', false, { 'a.js': textHash('edited after') });
  assert.ok(!('error' in ok));
  assert.equal(await readFile(join(wsDir, 'a.js'), 'utf8'), 'generated');
});

test('a link request is answered once', () => {
  assert.equal(usePairNonce('abc'), true);
  assert.equal(usePairNonce('abc'), false);
  assert.equal(usePairNonce(''), false);
});
