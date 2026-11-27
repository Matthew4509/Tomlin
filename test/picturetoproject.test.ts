// Pictures saved into a project's folder: a kept picture says where it went or why not, Save to project works for any
// picture in any chat, a second Save says it is already there, and Open folder opens only a project's own pictures
// folder in the workspace. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Picture } from '../src/gallery.ts';
import { useTestEnv } from './env.ts';

const home = mkdtempSync(join(tmpdir(), 'tomlin-pictureto-'));
useTestEnv({ TOMLIN_HOME: home, TOMLIN_PORT: '0', TOMLIN_OPEN: '', TOMLIN_NO_TOAST: '1', TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_STARTUP_DIR: join(home, 'startup') });
writeFileSync(join(home, 'models-folder.txt'), '');
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

const { workPost } = await import('../src/server/work.ts');
const { chats } = await import('../src/server/core.ts');
const { folderOpener, handInPicture, placesPost } = await import('../src/server/places.ts');
const { images } = await import('../src/server/panes.ts');
(await import('../src/server/jobs.ts')).startJobs();
images.onKept = handInPicture;
const workspace = join(home, 'data', 'workspace');

const mock = () => {
  const r = { status: 0, body: undefined as any, writeHead(s: number) { r.status = s; return r; }, end(x: string) { r.body = JSON.parse(x); } };
  return r;
};
const call = async (path: string, b: unknown) => {
  const res = mock();
  await (placesPost as any)[path]({ res, b });
  return { status: res.status, body: res.body };
};
const keep = async (id: string) => {
  const res = mock();
  await images.post({} as any, res as any, new URL('http://x/api/images/keep'), { id, kept: true });
  return { status: res.status, body: res.body };
};

let n = 0;
async function picture(extra: Partial<Picture> = {}): Promise<Picture> {
  const id = `pic${++n}`;
  const output = await images.gallery.save(`${id}.png`, Buffer.from(`picture ${id}`));
  const p: Picture = {
    id, at: new Date().toISOString(), prompt: `a red bicycle ${id}`, modelPrompt: '', negative: 'blurry', mode: 'blog', model: 'm', modelName: 'M', seed: 1, steps: 4, cfg: 1,
    sampler: 'lcm', generated: { width: 64, height: 64 }, target: { width: 64, height: 64 }, fit: 'crop', device: 'cpu', seconds: 1,
    draft: true, original: output, output, format: 'png', bytes: 10, kept: false, ...extra,
  };
  await images.gallery.add(p);
  return p;
}
async function project(name: string, folder: string): Promise<string> {
  const res = mock();
  await (workPost as any)['/api/projects/create']({ res, b: { name, folder, prompt: 'pictures' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.id as string;
}
async function chatIn(projectId: string | null): Promise<string> {
  const c = await chats.create('manager');
  if (projectId) await chats.setProject(c.id, projectId);
  return c.id;
}
const imagesIn = (folder: string) => { try { return readdirSync(join(workspace, folder, 'specialists', 'images')).filter(f => f.endsWith('.png')); } catch { return []; } };

test.after(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  // The job routes keep this process alive; the results are out by now.
  setTimeout(() => process.exit(0), 300);
});

test('a draft kept in a project\'s chat says where it went, and the picture records the project', async () => {
  const shop = await project('Bike shop', 'bikes');
  const p = await picture({ chat: await chatIn(shop) });
  const kept = await keep(p.id);
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.equal(kept.body.kept, true);
  assert.equal(kept.body.saved.project, shop);
  assert.equal(kept.body.saved.name, 'Bike shop');
  assert.match(kept.body.saved.path, /^bikes\/specialists\/images\/.+ a red bicycle pic\d+\.png$/);
  assert.ok(existsSync(join(workspace, ...kept.body.saved.path.split('/'))));
  assert.deepEqual(kept.body.savedTo, [{ project: shop, name: 'Bike shop', path: kept.body.saved.path }]);

  // Save to project once more: already there, nothing new written.
  const again = await call('/api/images/to-project', { id: p.id, project: shop });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.saved.already, true);
  assert.equal(imagesIn('bikes').length, 1);
  // With no project named, the picture's own chat's project is used.
  assert.equal((await call('/api/images/to-project', { id: p.id })).body.saved.already, true);

  // The copy taken away: Save puts it back.
  rmSync(join(workspace, ...kept.body.saved.path.split('/')));
  const back = await call('/api/images/to-project', { id: p.id, project: shop });
  assert.equal(back.status, 200);
  assert.equal(back.body.saved.already, undefined);
  assert.equal(imagesIn('bikes').length, 1);
});

test('a picture kept in a Default chat is not handed in anywhere, and Save to project puts it in any project', async () => {
  const p = await picture({ chat: await chatIn(null) });
  const kept = await keep(p.id);
  assert.equal(kept.status, 200);
  assert.equal(kept.body.saved, undefined, 'no project: nothing said');
  const none = await call('/api/images/to-project', { id: p.id });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /Pick a project/);

  const garden = await project('Garden', 'garden');
  const saved = await call('/api/images/to-project', { id: p.id, project: garden });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.match(saved.body.saved.path, /^garden\/specialists\/images\//);
  assert.equal(saved.body.picture.savedTo.length, 1);
  assert.equal(imagesIn('garden').length, 1);
});

test('a draft saved to a project goes into the gallery first; a picture drawn in no chat can be saved too', async () => {
  const cafe = await project('Cafe', 'cafe');
  const draft = await picture();
  const saved = await call('/api/images/to-project', { id: draft.id, project: cafe });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.picture.kept, true);
  assert.equal((await images.gallery.get(draft.id))?.kept, true);
});

test('unknown pictures and projects are refused in words', async () => {
  const p = await picture();
  assert.equal((await call('/api/images/to-project', { id: 'no-such-picture', project: 'x' })).status, 404);
  const gone = await call('/api/images/to-project', { id: p.id, project: 'no-such-project' });
  assert.equal(gone.status, 404);
  assert.match(gone.body.error, /not in this workspace/);
  assert.equal((await images.gallery.get(p.id))?.kept, false, 'refused before anything changed');
  const removed = await picture({ removed: true });
  assert.equal((await call('/api/images/to-project', { id: removed.id, project: 'x' })).status, 404);
});

test('a hand-in that fails says why, and the picture stays in the gallery', async () => {
  const stuck = await project('Stuck', 'stuck');
  mkdirSync(join(workspace, 'stuck'), { recursive: true });
  writeFileSync(join(workspace, 'stuck', 'specialists'), 'a file where the folder should be');
  const p = await picture({ chat: await chatIn(stuck) });
  const kept = await keep(p.id);
  assert.equal(kept.status, 200);
  assert.equal(kept.body.kept, true);
  assert.equal(kept.body.saved.name, 'Stuck');
  assert.ok(kept.body.saved.error.length > 3, JSON.stringify(kept.body.saved));
  assert.equal(kept.body.savedTo, undefined);
  const again = await call('/api/images/to-project', { id: p.id, project: stuck });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /^Not saved to Stuck: .+\. It is in the gallery\.$/);
});

test('a project folder that leads outside the workspace is never written to or opened', { skip: process.platform !== 'win32' && 'junctions' }, async () => {
  const away = await project('Away', 'away');
  const outside = join(home, 'outside');
  mkdirSync(outside, { recursive: true });
  rmSync(join(workspace, 'away'), { recursive: true, force: true });
  symlinkSync(outside, join(workspace, 'away'), 'junction');
  const p = await picture();
  const r = await call('/api/images/to-project', { id: p.id, project: away });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /outside the workspace/);
  assert.deepEqual(readdirSync(outside), []);
  const opened: string[] = [];
  const was = folderOpener.open;
  folderOpener.open = async dir => (opened.push(dir), true);
  try {
    const o = await call('/api/images/open-folder', { project: away });
    assert.equal(o.status, 400);
    assert.deepEqual(opened, []);
  } finally {
    folderOpener.open = was;
  }
});

test('Open folder opens only a project\'s own pictures folder, inside the workspace', async () => {
  const opened: string[] = [];
  const was = folderOpener.open;
  folderOpener.open = async dir => (opened.push(dir), true);
  try {
    const pond = await project('Pond', 'pond');
    assert.equal((await call('/api/images/open-folder', { project: 'no-such-project' })).status, 404);
    assert.equal((await call('/api/images/open-folder', {})).status, 404);
    const empty = await call('/api/images/open-folder', { project: pond });
    assert.equal(empty.status, 404);
    assert.match(empty.body.error, /No pictures have been saved to Pond yet/);
    const p = await picture();
    assert.equal((await call('/api/images/to-project', { id: p.id, project: pond })).status, 200);
    // A path from the page is never used.
    const o = await call('/api/images/open-folder', { project: pond, dir: 'C:\\Windows' });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    assert.deepEqual(opened, [join(workspace, 'pond', 'specialists', 'images')]);
  } finally {
    folderOpener.open = was;
  }
});

test('the server tells the keep route where a kept picture went', () => {
  assert.match(read('src/server.ts'), /images\.onKept = handInPicture;/);
  assert.match(read('src/images.ts'), /return send\(res, 200, saved \? \{ \.\.\.picture, saved \} : picture\), true;/);
});
