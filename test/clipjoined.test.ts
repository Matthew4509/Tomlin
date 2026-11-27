// The clip viewer of a video joined from a shot list (audit L3): it says which shots it joined and the model by name,
// and is never made again from its words (it has no seed and no one prompt). A clip made from words keeps its tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTestEnv } from './env.ts';
import { clipAbout, isJoined } from '../src/clips.ts';
import type { ClipRecord } from '../src/gallery.ts';

const home = mkdtempSync(join(tmpdir(), 'tomlin-clipjoined-'));
useTestEnv({ TOMLIN_HOME: home, TOMLIN_PORT: '0', TOMLIN_OPEN: '', TOMLIN_NO_TOAST: '1', TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_STARTUP_DIR: join(home, 'startup') });
writeFileSync(join(home, 'models-folder.txt'), '');
const { clipsGet, clipsPost, clipShelf } = await import('../src/server/clips.ts');

test.after(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  setTimeout(() => process.exit(0), 300);
});

const call = async (routes: any, path: string, b: unknown, url?: URL) => {
  let status = 0;
  let body: any;
  const res = { writeHead(s: number) { status = s; return res; }, end(x: string) { body = JSON.parse(String(x)); } };
  await routes[path]({ res, b, url: url ?? new URL(`http://x${path}`) });
  return { status, body };
};

const base: ClipRecord = { id: 'aaaaaaaaaaaa', at: '2026-11-28T10:00:00.000Z', prompt: 'a fox in snow', seconds: 2, width: 832, height: 480, quality: 'normal', model: 'wan21-t2v-1.3b', file: '2026-11/video-a.webm', mime: 'video/webm', bytes: 1000, tookMs: 1000, who: 'staff:v1', chat: 'c1', seed: 7 };

test('a joined video says the shots it joined and the model by name; a clip from words is as before', () => {
  const joined: ClipRecord = { ...base, id: 'bbbbbbbbbbbb', quality: 'joined', prompt: "Vic's shot list joined: shots 1, 2, 4, 6 s (not made yet: 3)", seed: undefined, joined: [1, 2, 4] };
  assert.equal(isJoined(joined), true);
  assert.equal(isJoined(base), false);
  assert.deepEqual(clipAbout(joined), { modelName: 'Wan 2.1 1.3B (text to video, small)', joined: [1, 2, 4] });
  assert.deepEqual(clipAbout(base), { modelName: 'Wan 2.1 1.3B (text to video, small)', joined: null });
  // Joined before the shots were kept with it: read from its words.
  assert.deepEqual(clipAbout({ ...joined, joined: undefined }).joined, [1, 2, 4]);
  // A model it does not know is named by its id.
  assert.equal(clipAbout({ ...base, model: 'some-new-model' }).modelName, 'some-new-model');
});

test('the viewer is told so by the server, and a joined video is never made again', async () => {
  const joined: ClipRecord = { ...base, id: 'cccccccccccc', quality: 'joined', prompt: "Vic's shot list joined: shots 1, 3, 4 s", seed: undefined, joined: [1, 3] };
  await clipShelf.add(joined);
  await clipShelf.add(base);
  const one = await call(clipsGet, '/api/clips/one', null, new URL(`http://x/api/clips/one?id=${joined.id}`));
  assert.equal(one.status, 200);
  assert.deepEqual([one.body.joined, one.body.modelName], [[1, 3], 'Wan 2.1 1.3B (text to video, small)']);
  const plain = await call(clipsGet, '/api/clips/one', null, new URL(`http://x/api/clips/one?id=${base.id}`));
  assert.equal(plain.body.joined, null);
  for (const seed of ['same', 'new']) {
    const again = await call(clipsPost, '/api/clips/again', { id: joined.id, seed });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /joined video is made from its shots/);
  }
});

test('the page leaves Make again, Use this prompt and the seed off a joined video and shows the shots it joined', () => {
  const page = readFileSync(join(import.meta.dirname, '..', 'public', 'clips.js'), 'utf8');
  const viewer = page.slice(page.indexOf('app.openClip = async'));
  assert.match(viewer, /if \(joined\) row\('Joined'/);
  assert.match(viewer, /if \(!joined\) row\('Seed'/);
  assert.match(viewer, /row\('Model', about\.modelName \|\| c\.model\)/);
  for (const b of ['Make again, same seed', 'Make again, new seed', 'Use this prompt']) assert.match(viewer, new RegExp(`joined \\? null : el\\('button', \\{ class: 'btn[^']*', type: 'button', text: '${b}'`));
});
