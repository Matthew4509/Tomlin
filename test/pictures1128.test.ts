// The pictures walk of 27 Nov 2026 (REVIEW-2026-11-27-PICTURES-VIDEO-WALK.md), server side: Character sets in a
// project kept at the top of the workspace say what to do (F4); style samples stay out of the gallery and Home (F11); a
// picture kept again is copied to its project when its copy is gone, and an icon's sizes and .ico go with it (F12); a
// finished queue line names its PC as the rest of the queue does (L4); a picture added to the queue from a chat is kept
// with that chat and names it (L6, F16). In this process, on a temp home; nothing is drawn and no model is loaded: each
// queued picture is one already in the gallery, collected as after a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Picture } from '../src/gallery.ts';
import { useTestEnv } from './env.ts';

const home = mkdtempSync(join(tmpdir(), 'tomlin-pic1128-'));
useTestEnv({ TOMLIN_HOME: home, TOMLIN_PORT: '0', TOMLIN_OPEN: '', TOMLIN_NO_TOAST: '1', TOMLIN_NO_PCLOOK: '1', TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_STARTUP_DIR: join(home, 'startup') });
writeFileSync(join(home, 'models-folder.txt'), '');

await import('../src/server/work.ts');
const core = await import('../src/server/core.ts');
(await import('../src/server/jobs.ts')).startJobs();
const { images } = await import('../src/server/panes.ts');
const { cardsGet } = await import('../src/server/cards.ts');
const { handInPicture } = await import('../src/server/places.ts');
const { queueGet, queuePost, startQueue } = await import('../src/server/queue.ts');
const { ridOf } = await import('../src/outbox.ts');
const { SAMPLE_PROMPT } = await import('../src/styles.ts');
images.onKept = handInPicture;
const workspace = join(home, 'data', 'workspace');

const mock = () => {
  const r = { status: 0, body: undefined as any, writeHead(s: number) { r.status = s; return r; }, end(x: string) { r.body = JSON.parse(x); } };
  return r;
};
const post = async (routes: any, path: string, b: unknown) => {
  const res = mock();
  await routes[path]({ res, b, url: new URL(`http://x${path}`) });
  return { status: res.status, body: res.body };
};
const get = async (routes: any, path: string) => {
  const res = mock();
  const url = new URL(`http://x${path}`);
  await routes[url.pathname]({ res, url });
  return { status: res.status, body: res.body };
};
const keep = async (id: string, kept = true) => {
  const res = mock();
  await images.post({} as any, res as any, new URL('http://x/api/images/keep'), { id, kept });
  return { status: res.status, body: res.body };
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A project as Home saves it (no plan yet): its project.json, with its folder ('' = kept at the top of the workspace). */
function project(id: string, name: string, folder: string): string {
  mkdirSync(join(workspace, 'jobs', id), { recursive: true });
  writeFileSync(join(workspace, 'jobs', id, 'project.json'), JSON.stringify({ id, created: '2026-11-28T09:00:00.000Z', name, folder, team: null, answers: { statement: name } }));
  writeFileSync(join(workspace, 'jobs', id, 'scope.md'), '# Scope\n');
  writeFileSync(join(workspace, 'jobs', id, 'design.md'), '# Design\n');
  if (folder) mkdirSync(join(workspace, ...folder.split('/')), { recursive: true });
  return id;
}

let n = 0;
async function picture(extra: Partial<Picture> = {}, files: Record<string, string> = {}): Promise<Picture> {
  const id = `p1128pic${String(++n).padStart(4, '0')}`;
  const output = await images.gallery.save(`${id}.png`, Buffer.from(`picture ${id}`));
  const icoFiles: string[] = [];
  for (const [name, text] of Object.entries(files)) icoFiles.push(await images.gallery.save(name, Buffer.from(text)));
  const p: Picture = {
    id, at: new Date().toISOString(), prompt: `a paper boat ${id}`, modelPrompt: '', negative: '', mode: 'blog', model: 'dreamshaper-8', modelName: 'DreamShaper 8', seed: 7, steps: 4, cfg: 1,
    sampler: 'lcm', generated: { width: 64, height: 64 }, target: { width: 64, height: 64 }, fit: 'crop', device: 'cpu', seconds: 3,
    draft: false, original: output, output, format: 'png', bytes: 10, kept: false, ...(icoFiles.length ? { icoFiles } : {}), ...extra,
  };
  await images.gallery.add(p);
  return p;
}
const imagesIn = (folder: string) => { try { return readdirSync(join(workspace, folder, 'specialists', 'images')).sort(); } catch { return []; } };
const queueFile = () => JSON.parse(readFileSync(join(home, 'data', 'queue.json'), 'utf8'));

/** The request id the queue asks a queued picture with (src/server/queue.ts runPicture), so one in the gallery is collected. */
function ridOfItem(it: any): string {
  const chosen = { ...(it.quality ? { quality: it.quality } : {}), ...(it.seed !== undefined ? { seed: it.seed } : {}) };
  const refs = it.refs?.length ? { refs: it.refs } : {};
  const look = { ...(it.look ? { look: it.look } : {}), ...(it.sample ? { plain: true } : {}) };
  return ridOf({ queue: it.id, prompt: it.prompt ?? it.title, as: it.as ?? '', mode: it.mode ?? '', width: it.width ?? 0, height: it.height ?? 0, ...(it.negative ? { negative: it.negative } : {}), ...chosen, ...refs, ...look });
}
async function untilDone(ids: string[], ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const items = (await get(queueGet, '/api/queue')).body.items.filter((x: any) => ids.includes(x.id));
    if (items.length === ids.length && items.every((x: any) => x.state !== 'waiting' && x.state !== 'running')) return items;
    if (Date.now() - t0 > ms) throw new Error(`Still running: ${JSON.stringify(items.map((x: any) => [x.state, x.error, x.note]))}`);
    await sleep(200);
  }
}

await startQueue();
await post(queuePost, '/api/queue/pause', { paused: true });

test.after(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  setTimeout(() => process.exit(0), 300);
});

test('F4: Character sets in a project kept at the top of the workspace say what to do, in plain words', async () => {
  const top = project('20261128-0900-a0a0', 'Whole workspace', '');
  const r = await get(cardsGet, `/api/cards?project=${top}`);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /Make a project for these characters/);
  assert.doesNotMatch(r.body.error, /has no folder of its own for characters and locations\.$/);
  // A project with a folder still lists its cards.
  const story = project('20261128-0901-b1b1', 'Story', 'Story');
  assert.equal((await get(cardsGet, `/api/cards?project=${story}`)).status, 200);
});

test('F11: style samples are kept in data\\stylesamples only: not in the gallery, not on Home', async () => {
  const ella = await core.staff.hire('Ella Example', 'artist', 'default', 'dreamshaper-8');
  const made = await post(queuePost, '/api/stylesamples/make', { as: ella.id });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const items = queueFile().items.filter((x: any) => x.sample && x.as === ella.id);
  assert.ok(items.length >= 5);
  const pics: Picture[] = [];
  for (const it of items) pics.push(await picture({ prompt: SAMPLE_PROMPT, queued: ridOfItem(it), target: { width: it.width ?? 512, height: it.height ?? 512 } }));
  await post(queuePost, '/api/queue/pause', { paused: false });
  const done = await untilDone(items.map((x: any) => x.id));
  await post(queuePost, '/api/queue/pause', { paused: true });
  for (const d of done) assert.equal(d.state, 'done', `${d.title}: ${d.error}`);
  // Each one is a sample.
  const kept = readdirSync(join(home, 'data', 'stylesamples', 'dreamshaper-8'));
  assert.equal(kept.filter(f => f.endsWith('.json')).length, items.length);
  // None of them is a gallery picture any more, kept or draft.
  const live = (await images.gallery.all()).filter(p => !p.removed && pics.some(x => x.id === p.id));
  assert.deepEqual(live.map(p => p.id), [], 'the samples are still in the gallery');
  for (const p of pics) assert.equal(existsSync(join(images.gallery.dir, p.output)), false, `${p.output} is still in the gallery folder`);
  // Home has no "Review photos" line for them.
  const { queueHome } = await import('../src/server/queue.ts');
  const lines = (await queueHome()).lines;
  assert.equal(lines.filter(l => l.kind === 'photos').length, 0, JSON.stringify(lines));
});

test('F12: a picture kept, taken back to drafts and kept again is copied to its project when its copy is not there', async () => {
  const shop = project('20261128-0902-c2c2', 'Bike shop', 'bikes');
  const c = await core.chats.create('manager');
  await core.chats.setProject(c.id, shop);
  const p = await picture({ chat: c.id });
  const first = await keep(p.id);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(imagesIn('bikes').filter(f => f.endsWith('.png')).length, 1);
  // Kept again with its copy still there: no second copy.
  await keep(p.id, false);
  const again = await keep(p.id);
  assert.equal(again.status, 200);
  assert.equal(imagesIn('bikes').filter(f => f.endsWith('.png')).length, 1, 'a second copy was made');
  // The copy taken away, then kept again: it is copied once more.
  rmSync(join(workspace, ...first.body.saved.path.split('/')));
  await keep(p.id, false);
  const back = await keep(p.id);
  assert.equal(back.status, 200);
  assert.ok(back.body.saved?.path, `nothing was handed in: ${JSON.stringify(back.body.saved)}`);
  assert.equal(imagesIn('bikes').filter(f => f.endsWith('.png')).length, 1);
  assert.ok(existsSync(join(workspace, ...back.body.saved.path.split('/'))));
});

test('F12: an icon kept in a project\'s chat takes its sizes and its .ico to the project', async () => {
  const site = project('20261128-0903-d3d3', 'Site icons', 'site');
  const c = await core.chats.create('manager');
  await core.chats.setProject(c.id, site);
  const p = await picture({ chat: c.id, mode: 'icon', prompt: 'a green leaf icon' }, { 'leaf-16.png': 'sixteen', 'leaf-32.png': 'thirty-two', 'leaf.ico': 'an ico' });
  const kept = await keep(p.id);
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  const files = imagesIn('site');
  const main = kept.body.saved.path.split('/').pop().replace(/\.png$/, '');
  assert.ok(files.includes(`${main}.png`), files.join(', '));
  assert.ok(files.includes(`${main}-16.png`), `no 16 px size: ${files.join(', ')}`);
  assert.ok(files.includes(`${main}-32.png`), `no 32 px size: ${files.join(', ')}`);
  assert.ok(files.includes(`${main}.ico`), `no .ico: ${files.join(', ')}`);
  assert.equal(readFileSync(join(workspace, 'site', 'specialists', 'images', `${main}.ico`), 'utf8'), 'an ico');
});

test('L4: a finished queue line names a linked PC as the rest of the queue does, when two PCs share a name', async () => {
  await core.store.saveSettings({ remotes: [
    { id: 'aa11bb22', name: 'Worker PC', url: 'https://127.0.0.1:9', token: 'x', computer: 'STUDY-TOWER' },
    { id: 'cc33dd44', name: 'Worker PC', url: 'https://127.0.0.1:10', token: 'y', computer: 'GARAGE-BOX' },
  ] as any });
  const ivy = await core.staff.hire('Ivy Example', 'artist', 'default', 'remote:aa11bb22:dreamshaper-8');
  const added = await post(queuePost, '/api/queue/add', { kind: 'picture', prompt: 'a lantern on a jetty', as: ivy.id });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const it = queueFile().items.find((x: any) => x.prompt === 'a lantern on a jetty');
  await picture({ prompt: 'a lantern on a jetty', queued: ridOfItem(it), device: 'on Worker PC', model: 'remote' });
  await post(queuePost, '/api/queue/pause', { paused: false });
  const [done] = await untilDone([it.id]);
  await post(queuePost, '/api/queue/pause', { paused: true });
  assert.equal(done.state, 'done', done.error);
  assert.match(done.result, /^Drawn by Ivy on "Worker PC \(STUDY-TOWER\)" in /);
  assert.equal(done.pc, 'Worker PC (STUDY-TOWER)');
});

test('L6 and F16: pictures added to the queue from an artist\'s chat are kept with it, and the first names the chat', async () => {
  const rowan = await core.staff.hire('Rowan Example', 'artist', 'default', 'dreamshaper-8');
  const c = await core.chats.create(`staff:${rowan.id}`);
  assert.equal(c.title, 'Untitled chat');
  const lines = ['a red kite over a beach', 'a blue kite over a field', 'a yellow kite in a storm'];
  const added = await post(queuePost, '/api/queue/add', { items: lines.map(prompt => ({ kind: 'picture', prompt, as: rowan.id, chat: c.id })) });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.added, 3);
  assert.equal((await core.chats.get(c.id))?.title, 'a red kite over a beach');
  const items = queueFile().items.filter((x: any) => lines.includes(x.prompt));
  assert.deepEqual(items.map((x: any) => x.chat), [c.id, c.id, c.id]);
  // Drawn (collected here), each picture is shown in that chat.
  const pics: Picture[] = [];
  for (const it of items) pics.push(await picture({ prompt: it.prompt, queued: ridOfItem(it) }));
  await post(queuePost, '/api/queue/pause', { paused: false });
  await untilDone(items.map((x: any) => x.id));
  await post(queuePost, '/api/queue/pause', { paused: true });
  for (const p of pics) assert.equal((await images.gallery.get(p.id))?.chat, c.id);
  // A named chat keeps its name.
  await core.chats.rename(c.id, 'Kites');
  await post(queuePost, '/api/queue/add', { kind: 'picture', prompt: 'a green kite', as: rowan.id, chat: c.id });
  assert.equal((await core.chats.get(c.id))?.title, 'Kites');
  // Another chat, not an artist's, is not named by a picture.
  const host = await core.chats.create('manager');
  await post(queuePost, '/api/queue/add', { kind: 'picture', prompt: 'a white kite', as: rowan.id, chat: host.id });
  assert.equal((await core.chats.get(host.id))?.title, 'Untitled chat');
});
