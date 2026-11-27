// A clip that starts from a picture (image to video) and carries on from a clip's last frame: which models take a start
// picture and the line said when one cannot, the runner's -i, the picture as the page sends it, the queue handing it to
// the runner and removing it after, the start picture kept with the clip (hard-linked into a project's Start frames,
// copied only across drives), the This project list, and the page's buttons wired. The link side is in test/videolink.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Clips, START_SENT_MAX, copiedLine, isRunning, keepStart, picturesIn, startFromPage, type ClipAsk, type ClipView, type StartPlan } from '../src/clips.ts';
import { projectImages, startFrames } from '../src/folders.ts';
import type { ChatLine } from '../src/store.ts';
import { ClipShelf } from '../src/gallery.ts';
import { fitTo } from '../src/imaging.ts';
import { SdVideoRunner, VIDEO_WORDS, videoArgs, type VideoDeps } from '../src/video.ts';
import { VIDEO_MODELS, takesStartPicture, wordsOnlyLine } from '../src/videomodels.ts';
import { isPng, VideoFault, type VideoJob } from '../src/videotypes.ts';
import { FakeVideoRunner } from './fakeclip.ts';

const png = (w = 64, h = 40) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
const dataUrl = (b: Buffer, type = 'image/png') => `data:${type};base64,${b.toString('base64')}`;

test('only the Wan 2.2 5B models start from a picture; the 1.3B says so in a plain line', () => {
  assert.deepEqual(Object.fromEntries(VIDEO_MODELS.map(m => [m.id, m.startPicture])), { 'wan21-t2v-1.3b': false, 'wan22-ti2v-5b-q8': true, 'wan22-ti2v-5b': true });
  assert.equal(takesStartPicture('wan21-t2v-1.3b'), false);
  assert.equal(takesStartPicture('wan22-ti2v-5b-q8'), true);
  assert.equal(wordsOnlyLine('wan21-t2v-1.3b'), 'Wan 2.1 1.3B makes clips from words only: pick Wan 2.2 5B in Edit staff to start from a picture.');
});

test('the runner is given the start picture as -i, and only when there is one', () => {
  const files = { name: 'Wan 2.2 5B', diffusion: 'd.gguf', vae: 'v.safetensors', textEncoder: 't.gguf' };
  const job: VideoJob = { prompt: 'a kite', seconds: 2, width: 832, height: 480, quality: 'draft', model: 'wan22-ti2v-5b-q8' };
  assert.equal(videoArgs(job, files, 'out.webm', 'cuda').includes('-i'), false);
  const a = videoArgs({ ...job, startPicture: 'C:\\clips\\start.png' }, files, 'out.webm', 'cuda');
  assert.equal(a[a.indexOf('-i') + 1], 'C:\\clips\\start.png');
});

test('the runner refuses a start picture for a words-only model, and a start picture that is not there', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-clipstart-'));
  try {
    const deps: VideoDeps = { findExe: () => null, resolve: async () => null, outDir: dir, freeBytes: async () => null, start: () => { throw new Error('not started'); }, killTree: async () => undefined, now: Date.now };
    const r = new SdVideoRunner(deps);
    const job: VideoJob = { prompt: 'a kite', seconds: 2, width: 832, height: 480, quality: 'draft', model: 'wan21-t2v-1.3b', startPicture: join(dir, 'start.png') };
    await assert.rejects(r.make(job, () => undefined, new AbortController().signal), (e: VideoFault) => e.kind === 'missing-model' && e.message === wordsOnlyLine('wan21-t2v-1.3b'));
    await assert.rejects(r.make({ ...job, model: 'wan22-ti2v-5b-q8' }, () => undefined, new AbortController().signal), (e: VideoFault) => e.kind === 'crashed' && e.message === VIDEO_WORDS.noStartPicture);
    // With the picture there, it goes on to the usual checks (no runner here).
    await writeFile(job.startPicture!, await png());
    await assert.rejects(r.make({ ...job, model: 'wan22-ti2v-5b-q8' }, () => undefined, new AbortController().signal), (e: VideoFault) => e.kind === 'not-installed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the start picture as the page sends it: a PNG data URL, size-capped, checked as a PNG', async () => {
  const p = await png();
  assert.equal(startFromPage(undefined), null);
  assert.equal(startFromPage(''), null);
  assert.ok(isPng(startFromPage(dataUrl(p)) as Buffer));
  assert.match((startFromPage(dataUrl(p, 'image/jpeg')) as { error: string }).error, /not a PNG/);
  assert.match((startFromPage(dataUrl(Buffer.from('GIF89a not a png at all'))) as { error: string }).error, /not a PNG/);
  assert.match((startFromPage('data:image/png;base64,<script>') as { error: string }).error, /not a PNG/);
  assert.match((startFromPage(42) as { error: string }).error, /not a PNG/);
  assert.match((startFromPage(dataUrl(Buffer.alloc(START_SENT_MAX + 3))) as { error: string }).error, /too large/);
});

test('the picture is cropped to the clip size before the clip is asked', async () => {
  const fitted = await fitTo(await png(1000, 400), { width: 832, height: 480 }, 'crop');
  const m = await sharp(fitted).metadata();
  assert.deepEqual([m.width, m.height, m.format], [832, 480, 'png']);
});

test('the queue hands the start picture to the runner and removes it once the clip ends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-clipstart-'));
  try {
    const runner = new FakeVideoRunner({ fps: 2, frameMs: 1 });
    const clips = new Clips({ runner: () => runner, shelf: new ClipShelf(join(dir, 'videos')), free: async () => null, saveLine: async () => undefined });
    const start = join(dir, 'start.png');
    await writeFile(start, await png());
    const ask: ClipAsk = { prompt: 'the kite climbs', seconds: 1, width: 832, height: 480, quality: 'draft', model: 'wan22-ti2v-5b-q8', who: 'staff:v1', name: 'Vic', chat: 'c1', pc: 'here', seed: 7, startPicture: start };
    const v = clips.start(ask) as ClipView;
    assert.equal(v.start, true);
    for (let i = 0; i < 400 && isRunning(clips.view(v.id)!.state); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(clips.view(v.id)!.state, 'done');
    assert.equal(runner.made[0].startPicture, start);
    for (let i = 0; i < 100 && existsSync(start); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(existsSync(start), false, 'removed once the clip ended');
    // Without one, none is sent.
    const w = clips.start({ ...ask, startPicture: undefined }) as ClipView;
    assert.equal(w.start, false);
    for (let i = 0; i < 400 && isRunning(clips.view(w.id)!.state); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal('startPicture' in runner.made[1], false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a start picture is removed when its clip is stopped while it waits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-clipstart-'));
  try {
    const runner = new FakeVideoRunner({ fps: 4, frameMs: 20 });
    const clips = new Clips({ runner: () => runner, shelf: new ClipShelf(join(dir, 'videos')), free: async () => null, saveLine: async () => undefined });
    const start = join(dir, 'start.png');
    await writeFile(start, await png());
    const base: ClipAsk = { prompt: 'first', seconds: 2, width: 832, height: 480, quality: 'draft', model: 'wan22-ti2v-5b-q8', who: 'staff:v1', name: 'Vic', chat: 'c1', pc: 'here', seed: 7 };
    const first = clips.start(base) as ClipView;
    const second = clips.start({ ...base, prompt: 'second', startPicture: start }) as ClipView;
    assert.equal(clips.view(second.id)!.state, 'queued');
    assert.equal(clips.stop(second.id), true);
    for (let i = 0; i < 100 && existsSync(start); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(existsSync(start), false);
    clips.stop(first.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the page is wired: the picker\'s three tabs, Make a clip from this picture, Carry on from here, Use this frame, Started from', async () => {
  const root = join(import.meta.dirname, '..');
  const read = (f: string) => readFile(join(root, f), 'utf8');
  const js = await read('public/clips.js');
  for (const bit of ['Add a picture', "'This project'", "'Gallery'", "'A file'", "'Drafts'", "'Remove'", 'Carry on from here', 'Use this frame', 'Started from', "text: 'Open'", 'app.clipFromPicture', 'app.clipActs', 'Hire staff', 'Which Videographer makes it?', "toDataURL('image/png')", 'lastFrameOf', '/api/clips/project-pictures', '/api/clips/start?id=']) assert.ok(js.includes(bit), bit);
  // It opens on This project when the chat belongs to a project.
  assert.match(js, /await show\(proj\.project \? 'project' : 'gallery'\)/);
  // A new picture goes as `start`, one already here as `startFrom`; the slot empties after.
  assert.match(js, /sent\.png \? \{ start: sent\.png \} : \{ startFrom: sent\.from \}/);
  // The last frame: the player seeks to its end, in the browser.
  // The end itself, not 0.05 s short: that showed frame 118 of 120, and each carried-on shot started two frames back
  // (measured on the 26 Nov Z820 shot list: shot n+1's first frame matched frame 118 of shot n at every join).
  assert.match(js, /v\.currentTime = v\.duration;/);
  assert.doesNotMatch(js, /v\.duration - 0\.05/);
  const images = await read('public/images.js');
  assert.equal(images.match(/app\.clipFromPicture\?\.\(fileUrl\(p\.output\), \{ gallery: p\.id \}, p\.prompt\)/g)?.length, 2, 'the viewer and the picture in an Artist\'s chat');
  const app = await read('public/app.js');
  assert.match(app, /app\.clipFromPicture\?\.\(pictureUrl\(pic\.output\), \{ gallery: pic\.output \}, pic\.prompt\)/);
  assert.match(app, /app\.clipActs\?\.\(clip, video\)/);
  assert.match(await read('public/chats.js'), /app\.videographers = \(\) => chatUi\.people\.filter\(p => p\.video\)/);
  const route = await read('src/server/clips.ts');
  assert.match(route, /startChosen\(b\)/);
  assert.match(route, /fitTo\(chosen\.png, \{ width: ask\.width, height: ask\.height \}, 'crop'\)/);
  assert.match(route, /takesStartPicture\(model\)/);
  assert.match(route, /folders\.startFrames\(folder\)/);
  assert.match(route, /folders\.projectImages\(folder\)/);
});

const plan = (file: string, o: Partial<StartPlan> = {}): StartPlan => ({ file, fresh: false, name: 'a red kite', ...o });

test('a start picture outside a project stays where it is: the clip keeps its path, no copy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-clipstart-'));
  try {
    const pic = join(dir, 'pic.png');
    await writeFile(pic, await png());
    assert.deepEqual(await keepStart(plan(pic)), { path: pic });
    assert.deepEqual(readdirSync(dir), ['pic.png']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('in a project, a picture already here is hard-linked into Start frames: the same file, no extra space', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-clipstart-'));
  try {
    const pic = join(dir, 'gallery.png');
    await writeFile(pic, await png());
    const into = { dir: join(dir, 'ws', 'Kites', 'specialists', 'videos', 'Start frames'), rel: startFrames('Kites') };
    assert.equal(into.rel, 'Kites/specialists/videos/Start frames');
    const now = new Date(2026, 10, 25, 18, 40);
    const k = await keepStart(plan(pic, { into }), now);
    assert.equal(k.path, pic);
    assert.equal(k.project, 'Kites/specialists/videos/Start frames/2026-11-25-1840 a red kite.png');
    assert.equal(k.copied, undefined);
    const linked = join(into.dir, '2026-11-25-1840 a red kite.png');
    assert.equal(statSync(linked).ino, statSync(pic).ino, 'one file');
    assert.equal(statSync(pic).nlink, 2);
    // A second in the same minute gets " 2", never written over.
    const k2 = await keepStart(plan(pic, { into }), now);
    assert.equal(k2.project, 'Kites/specialists/videos/Start frames/2026-11-25-1840 a red kite 2.png');
    // A project picture's own date and time is not doubled.
    const k3 = await keepStart(plan(pic, { into, name: '2026-11-24-0900 a blue kite' }), now);
    assert.equal(k3.project, 'Kites/specialists/videos/Start frames/2026-11-25-1840 a blue kite.png');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('only when Start frames is on another drive is the picture copied, and the clip line says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-clipstart-'));
  try {
    const pic = join(dir, 'gallery.png');
    await writeFile(pic, await png());
    const into = { dir: join(dir, 'Start frames'), rel: 'Kites/specialists/videos/Start frames' };
    const otherDrive = Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    const k = await keepStart(plan(pic, { into }), new Date(2026, 10, 25, 18, 40), { link: async () => { throw otherDrive; }, rename });
    assert.equal(k.copied, true);
    assert.equal(k.path, pic);
    const copy = join(into.dir, '2026-11-25-1840 a red kite.png');
    assert.notEqual(statSync(copy).ino, statSync(pic).ino);
    assert.equal(copiedLine(k.project!), 'The start picture was copied into Kites\\specialists\\videos\\Start frames (not linked): that folder is on another drive.');
    // Any other refusal is not hidden by a copy.
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
    await assert.rejects(keepStart(plan(pic, { into }), new Date(), { link: async () => { throw denied; }, rename }), /denied/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a new PNG (a file, a Carry on frame) is moved into Start frames as a plain file, not linked or copied', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-clipstart-'));
  try {
    const fresh = join(dir, 'start-ab12.png');
    await writeFile(fresh, await png());
    const into = { dir: join(dir, 'Start frames'), rel: 'Kites/specialists/videos/Start frames' };
    const k = await keepStart(plan(fresh, { fresh: true, name: 'the kite climbs last frame', into }), new Date(2026, 10, 25, 9, 5));
    assert.equal(k.path, join(into.dir, '2026-11-25-0905 the kite climbs last frame.png'));
    assert.equal(existsSync(fresh), false);
    assert.equal(statSync(k.path).nlink, 1);
    assert.equal(k.copied, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the clip record keeps the start picture, the chat line shows Started from, and a copy is said', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-clipstart-'));
  try {
    const runner = new FakeVideoRunner({ fps: 2, frameMs: 1 });
    const lines: ChatLine[] = [];
    const shelf = new ClipShelf(join(dir, 'videos'));
    const clips = new Clips({ runner: () => runner, shelf, free: async () => null, saveLine: async (_c, l) => void lines.push(l), keepStart: async p => ({ path: p.file, project: 'Kites/specialists/videos/Start frames/2026-11-25-1840 kite.png', copied: true }) });
    const run = join(dir, 'run.png');
    const pic = join(dir, 'kite.png');
    await writeFile(run, await png());
    await writeFile(pic, await png());
    const v = clips.start({ prompt: 'the kite climbs', seconds: 1, width: 832, height: 480, quality: 'draft', model: 'wan22-ti2v-5b-q8', who: 'staff:v1', name: 'Vic', chat: 'c1', pc: 'here', seed: 7, startPicture: run, start: plan(pic) }) as ClipView;
    for (let i = 0; i < 400 && isRunning(clips.view(v.id)!.state); i++) await new Promise(r => setTimeout(r, 5));
    const rec = await shelf.get(v.id);
    assert.deepEqual(rec?.start, { path: pic, project: 'Kites/specialists/videos/Start frames/2026-11-25-1840 kite.png', copied: true });
    assert.deepEqual(lines[0].clip?.start, { name: '2026-11-25-1840 kite.png', copied: true });
    assert.match(lines[0].content, /copied into Kites\\specialists\\videos\\Start frames \(not linked\): that folder is on another drive/);
    // The picture it started from stays (it is the gallery's or the project's); only the runner's cropped copy goes.
    assert.equal(existsSync(pic), true);
    for (let i = 0; i < 100 && existsSync(run); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(existsSync(run), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a fresh start picture is not kept when its clip fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-clipstart-'));
  try {
    const runner = new FakeVideoRunner({ fail: 'out-of-memory', failAt: 1, fps: 2, frameMs: 1 });
    const clips = new Clips({ runner: () => runner, shelf: new ClipShelf(join(dir, 'videos')), free: async () => null, saveLine: async () => undefined });
    const fresh = join(dir, 'start-ab.png');
    await writeFile(fresh, await png());
    const v = clips.start({ prompt: 'x', seconds: 1, width: 832, height: 480, quality: 'draft', model: 'wan22-ti2v-5b-q8', who: 'staff:v1', name: 'Vic', chat: 'c1', pc: 'here', seed: 7, start: plan(fresh, { fresh: true }) }) as ClipView;
    for (let i = 0; i < 400 && isRunning(clips.view(v.id)!.state); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(clips.view(v.id)!.state, 'failed');
    for (let i = 0; i < 100 && existsSync(fresh); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(existsSync(fresh), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('This project lists the pictures in specialists\\images, newest first, PNG and WebP only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-clipstart-'));
  try {
    const rel = projectImages('Kites');
    assert.equal(rel, 'Kites/specialists/images');
    const at = join(dir, ...rel.split('/'));
    await mkdir(at, { recursive: true });
    for (const n of ['2026-11-24-0900 old kite.png', '2026-11-25-1840 new kite.webp', '2026-11-25-1200 mid kite.png', 'notes.txt', 'kite.jpg']) await writeFile(join(at, n), 'x');
    const list = await picturesIn(at, rel);
    assert.deepEqual(list.map(p => p.name), ['2026-11-25-1840 new kite.webp', '2026-11-25-1200 mid kite.png', '2026-11-24-0900 old kite.png']);
    assert.equal(list[0].path, 'Kites/specialists/images/2026-11-25-1840 new kite.webp');
    assert.deepEqual(await picturesIn(join(dir, 'none'), 'none'), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
