// The clip's controls (as a picture has them): the seed (a random one when none is asked) and the words to leave out
// kept with each clip, the steps asked by hand, Make again with the same or a new seed, the clip viewer and the Videos
// shelf's tools on the page, a project chat's clip copied into specialists\videos, and the time left while the clip
// file is written counted down (never a figure that stands still). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIP_SIZES, Clips, SEED_MAX, STEPS_MAX, againAsk, cleanAsk, clipSizesFor, isRunning, progressLine, sizeIdOf, sizeRefused, type ClipAsk, type ClipView } from '../src/clips.ts';
import { ClipShelf, type ClipRecord } from '../src/gallery.ts';
import { clipPath, picturePath } from '../src/folders.ts';
import { cleanJob, stepsOf, videoArgs } from '../src/video.ts';
import { cleanJob as linkJob } from '../src/videolink.ts';
import type { VideoJob, VideoProgress, VideoRunner } from '../src/videotypes.ts';
import { FakeVideoRunner } from './fakeclip.ts';

const root = join(import.meta.dirname, '..');
const read = (f: string) => readFile(join(root, f), 'utf8');
const ask = (extra: Partial<ClipAsk> = {}): ClipAsk => ({ prompt: 'waves on a beach', seconds: 2, width: 832, height: 480, quality: 'draft', model: 'wan-1.3b', who: 'staff:v1', name: 'Vic', chat: 'c1', pc: 'here', seed: 7, ...extra });

async function rig(runner: VideoRunner, o: { now?: () => number; made?: (c: ClipRecord, file: string) => Promise<void> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-clipctl-'));
  const shelf = new ClipShelf(join(dir, 'videos'));
  const clips = new Clips({ runner: () => runner, shelf, free: async () => null, saveLine: async () => undefined, ...o });
  return { dir, shelf, clips, done: () => rm(dir, { recursive: true, force: true }) };
}

async function ended(clips: Clips, id: string): Promise<ClipView> {
  for (let i = 0; i < 400; i++) {
    const v = clips.view(id)!;
    if (!isRunning(v.state)) return v;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('the clip never ended');
}
const started = (v: ReturnType<Clips['start']>): ClipView => {
  assert.ok(!('refused' in v));
  return v as ClipView;
};

// ---- 1. the seed, the words to leave out and the steps ----

test('the ask keeps a seed (a random one when the box is empty), the words to leave out and the steps', () => {
  const base = { prompt: 'a red kite', seconds: 2, size: 'wide', quality: 'draft' };
  const a = cleanAsk(base, () => 4242);
  assert.ok(!('error' in a));
  assert.equal(a.seed, 4242, 'no seed asked: a random one, kept');
  assert.equal(a.negative, undefined);
  assert.equal(a.steps, undefined, 'no steps: the quality\'s own');
  const b = cleanAsk({ ...base, seed: ' 12 ', negative: '  blurry,   text ', steps: '25' }, () => 1);
  assert.ok(!('error' in b));
  assert.equal(b.seed, 12);
  assert.equal(b.negative, 'blurry, text');
  assert.equal(b.steps, 25);
  assert.equal((cleanAsk({ ...base, seed: 0 }) as { seed: number }).seed, 0, 'seed 0 is a seed');
  assert.equal((cleanAsk({ ...base, seed: '', steps: '' }, () => 9) as { seed: number }).seed, 9);
  for (const seed of ['-1', '1.5', 'abc', String(SEED_MAX + 1)]) assert.match((cleanAsk({ ...base, seed }) as { error: string }).error, /seed is a whole number/, seed);
  for (const steps of ['0', '2.5', String(STEPS_MAX + 1)]) assert.match((cleanAsk({ ...base, steps }) as { error: string }).error, /Steps is a whole number/, steps);
  assert.match((cleanAsk({ ...base, negative: 'x'.repeat(1001) }) as { error: string }).error, /too long/);
  // The random seed of the real ask is a whole number in range.
  const r = cleanAsk(base) as { seed: number };
  assert.ok(Number.isInteger(r.seed) && r.seed >= 0 && r.seed <= SEED_MAX);
});

test('the 720p sizes (1280 by 704 and 704 by 1280) are offered only for a model made for 720p', async () => {
  const ids = (m: string) => clipSizesFor(m).map(s => s.id);
  for (const m of ['wan22-ti2v-5b-q8', 'wan22-ti2v-5b']) assert.deepEqual(ids(m), ['wide', 'tall', 'square', 'wide720', 'tall720'], m);
  for (const m of ['wan21-t2v-1.3b', 'some-other-model', '']) assert.deepEqual(ids(m), ['wide', 'tall', 'square'], m);
  assert.deepEqual(CLIP_SIZES.filter(s => s.hd).map(s => [s.width, s.height]), [[1280, 704], [704, 1280]]);
  for (const s of CLIP_SIZES) assert.equal(s.width % 16 + s.height % 16, 0, `${s.id} is a multiple of 16`);
  assert.equal(sizeRefused(1280, 704, 'wan22-ti2v-5b-q8'), '');
  assert.match(sizeRefused(704, 1280, 'wan21-t2v-1.3b'), /^Tall 720p is for a video model made for 720p \(Wan 2\.2 5B\): pick Wide, Tall or Square\.$/);
  assert.equal(sizeRefused(832, 480, 'wan21-t2v-1.3b'), '');
  // The ask takes the size; Make clip refuses it for the hire's model (src/server/clips.ts), and the page offers it only for one.
  const a = cleanAsk({ prompt: 'a fox', size: 'wide720' }, () => 1);
  assert.deepEqual([(a as { width: number }).width, (a as { height: number }).height], [1280, 704]);
  assert.match(await read('src/server/clips.ts'), /const big = sizeRefused\(ask\.width, ask\.height, model\);\s+if \(big\) return json\(res, 400, \{ error: big \}\);/);
  assert.match(await read('src/server/people.ts'), /isHdModel\(model\) \? \{ hd: true \}/);
  assert.match(await read('public/clips.js'), /\.filter\(s => !s\.hd \|\| app\.chatPerson\?\.hd\)/);
  assert.match(await read('public/shots.js'), /!id\.endsWith\('720'\) \|\| app\.chatPerson\?\.hd/);
});

test('the runner is given the seed, the leave-out words and the steps, and the clip on the shelf keeps them', async () => {
  const fake = new FakeVideoRunner();
  const r = await rig(fake);
  try {
    const v = started(r.clips.start(ask({ seed: 99, negative: 'blurry', steps: 25, pc: 'here' })));
    assert.equal(v.seed, 99);
    const end = await ended(r.clips, v.id);
    assert.equal(end.state, 'done');
    assert.equal(fake.made[0].seed, 99);
    assert.equal(fake.made[0].negative, 'blurry');
    assert.equal(fake.made[0].steps, 25);
    const c = end.clip!;
    assert.equal(c.seed, 99);
    assert.equal(c.negative, 'blurry');
    assert.equal(c.steps, 25);
    assert.equal(c.pc, 'this PC');
    // Read back from clips.jsonl by a new shelf: still there.
    const again = await new ClipShelf(r.shelf.dir).get(c.id);
    assert.deepEqual([again?.seed, again?.negative, again?.steps, again?.pc], [99, 'blurry', 25, 'this PC']);
    // Nothing asked: no leave-out words or steps on the record, and a linked PC by its name.
    const w = started(r.clips.start(ask({ seed: 5, pc: 'pc-1', pcName: 'Z820' })));
    const c2 = (await ended(r.clips, w.id)).clip!;
    assert.equal('negative' in c2, false);
    assert.equal('steps' in c2, false);
    assert.equal(c2.pc, 'Z820');
    assert.equal(fake.made[1].negative, undefined);
  } finally {
    await r.done();
  }
});

test('the engine: -n with the words to leave out, --seed, and --steps the hand-set number or the quality\'s', () => {
  const f = { name: 'w', diffusion: 'D.gguf', vae: 'V.safetensors', textEncoder: 'T.gguf' };
  const job = (o: Partial<VideoJob> = {}): VideoJob => ({ prompt: 'a red ball', seconds: 2, width: 480, height: 272, quality: 'draft', model: 'm', ...o });
  const a = videoArgs(cleanJob(job({ negative: '  blurry,  text ', seed: 3, steps: 25 })), f, 'o.webm', 'cuda');
  const at = (flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(at('-n'), 'blurry, text');
  assert.equal(at('--seed'), '3');
  assert.equal(at('--steps'), '25');
  const plain = videoArgs(cleanJob(job()), f, 'o.webm', 'cuda');
  assert.ok(!plain.includes('-n'), 'no words to leave out: no -n');
  assert.equal(plain[plain.indexOf('--steps') + 1], '12', 'Draft\'s own steps');
  assert.equal(cleanJob(job({ steps: 0 })).steps, undefined);
  assert.equal(cleanJob(job({ steps: 2.5 })).steps, undefined);
  assert.equal(cleanJob(job({ steps: 999 })).steps, undefined);
  assert.equal(cleanJob(job({ negative: '   ' })).negative, undefined);
  assert.equal(stepsOf(job({ quality: 'best' })), 30);
  assert.equal(stepsOf(job({ quality: 'best', steps: 8 })), 8);
});

test('a linked PC is sent the words to leave out and the steps, cleaned as it takes them', () => {
  const JOB = { prompt: 'a kite', seconds: 3, width: 512, height: 320, quality: 'draft', model: 'wan-small' };
  const j = linkJob({ ...JOB, negative: ' blurry​,   text ', steps: 20, seed: 11 }) as VideoJob;
  assert.equal(j.negative, 'blurry, text');
  assert.equal(j.steps, 20);
  assert.equal(j.seed, 11);
  assert.equal((linkJob({ ...JOB, negative: 'x'.repeat(5000) }) as VideoJob).negative!.length, 1000);
  assert.equal('negative' in (linkJob(JOB) as VideoJob), false);
  assert.ok('error' in linkJob({ ...JOB, steps: 0 }));
  assert.ok('error' in linkJob({ ...JOB, steps: 61 }));
  assert.ok('error' in linkJob({ ...JOB, steps: 'ten' }));
});

// ---- 2. Make again: the same seed or a new one ----

test('Make again asks for the same clip in its own chat: the same seed, or an empty seed for a new random one', () => {
  const c: ClipRecord = { id: 'a1', at: '2026-11-25T10:00:00.000Z', prompt: 'waves', seconds: 3, width: 480, height: 832, quality: 'best', model: 'wan', file: '2026-11/clip-a1.webm', mime: 'video/webm', bytes: 10, tookMs: 1, who: 'staff:v1', chat: 'c9', seed: 77, negative: 'blurry', steps: 25 };
  assert.deepEqual(againAsk(c, 'same'), { chatId: 'c9', who: 'staff:v1', prompt: 'waves', filled: true, seconds: 3, size: 'tall', quality: 'best', negative: 'blurry', steps: 25, seed: 77 });
  assert.equal(againAsk(c, 'new').seed, '');
  const old = { ...c, seed: undefined, negative: undefined, steps: undefined };
  assert.equal(againAsk(old, 'same').seed, '', 'a clip from before seeds were kept: never seed 0 or undefined');
  assert.equal(againAsk(old, 'same').negative, '');
  // Through cleanAsk: the same seed comes out again; a new one is random.
  const same = cleanAsk(againAsk(c, 'same'), () => 1) as { seed: number; width: number; height: number };
  assert.deepEqual([same.seed, same.width, same.height], [77, 480, 832]);
  assert.equal((cleanAsk(againAsk(c, 'new'), () => 5) as { seed: number }).seed, 5);
  assert.equal(sizeIdOf(624, 624), 'square');
  assert.equal(sizeIdOf(1, 1), 'wide');
});

test('the again route: the shelf clip, refused with words when its seed is not known or its chat is gone', async () => {
  const s = await read('src/server/clips.ts');
  assert.match(s, /'\/api\/clips\/again': async/);
  assert.match(s, /made before seeds were kept\): make it again with a new seed/);
  assert.match(s, /The chat this clip was made in is gone/);
  assert.match(s, /return makeClip\(res, againAsk\(c, b\.seed === 'new' \? 'new' : 'same'\)\)/);
  assert.match(s, /'\/api\/clips\/one': async/);
  // Delete takes one id or several.
  assert.match(s, /Array\.isArray\(b\.ids\) \? b\.ids : \[b\.id\]/);
});

// ---- 3. the clip viewer and the Videos shelf on the page ----

test('the page: More options in the clip row, the clip viewer and its buttons, the shelf tools', async () => {
  const html = await read('public/index.html');
  for (const id of ['clip-more', 'clip-negative', 'clip-seed', 'clip-dice', 'clip-steps', 'clip-viewer', 'clip-viewer-video', 'clip-viewer-meta', 'clip-viewer-actions']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<span>Leave out of the clip<\/span>/);
  const js = await read('public/clips.js');
  for (const words of ['Make again, same seed', 'Make again, new seed', 'Use this prompt', 'Copy prompt', 'Save a copy', 'Delete this clip for good?', 'This chat only', 'Tick all', 'Delete for good', 'See more (']) assert.ok(js.includes(words), words);
  for (const route of ['/api/clips/again', '/api/clips/one', '/api/clips/delete', '/api/clips/shelf']) assert.ok(js.includes(route), route);
  for (const row of ["row('Prompt'", "row('Length'", "row('Size'", "row('Quality'", "row('Seed'", "row('Model'", "row('Made on'", "row('Took'"]) assert.ok(js.includes(row), row);
  // The leave-out words, seed and steps (and the start picture) go with Make clip; Save a copy is a download of the file.
  assert.match(js, /quality: clipQuality\.querySelector\('input:checked'\)\?\.value \?\? 'normal', \.\.\.clipMore\(\), \.\.\.start \}/);
  assert.match(js, /download: clipFileName\(c\)/);
  // Paged: a page at a time, This chat only asks for the open chat's clips.
  assert.match(js, /if \(st\.chatOnly\) qs\.set\('chat', app\.chatId \?\? ''\)/);
  // The chat's clip has Open.
  assert.match(await read('public/app.js'), /app\.openClip\?\.\(clip\.id\)/);
  // The viewer: Carry on from here and Use this frame among its buttons, Started from among its details.
  assert.match(js, /\.\.\.carryButtons\(c, clipViewerVideo, c\.chat,/);
  assert.match(js, /meta\.append\(el\('dt', \{ text: 'Started from' \}\)/);
});

test('Make again of a clip that started from a picture starts from it again', () => {
  const base = { id: 'ab12', at: '', prompt: 'a kite', seconds: 2, width: 832, height: 480, quality: 'draft', model: 'm', file: '2026-11/c.webm', mime: 'video/webm' as const, bytes: 1, tookMs: 1, who: 'staff:v1', chat: 'c1', seed: 5 };
  assert.equal('startFrom' in againAsk(base, 'same'), false);
  assert.deepEqual(againAsk({ ...base, start: { path: 'C:\\x\\kite.png' } }, 'same').startFrom, { clip: 'ab12' });
});

test('the shelf pages newest first, one chat\'s, and a delete of several takes each file', async () => {
  const fake = new FakeVideoRunner();
  const r = await rig(fake);
  try {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await ended(r.clips, started(r.clips.start(ask({ prompt: `clip ${i}`, chat: i % 2 ? 'odd' : 'even' }))).id)).clip!.id);
    const p1 = await r.shelf.list(0, 2);
    assert.deepEqual(p1.clips.map(c => c.prompt), ['clip 4', 'clip 3']);
    assert.equal(p1.total, 5);
    assert.deepEqual((await r.shelf.list(2, 2)).clips.map(c => c.prompt), ['clip 2', 'clip 1']);
    assert.deepEqual((await r.shelf.list(0, 60, '', 'odd')).clips.map(c => c.prompt), ['clip 3', 'clip 1']);
    const gone = (await r.shelf.list(0, 60)).clips.filter(c => c.chat === 'even');
    for (const c of gone) assert.equal(await r.shelf.remove(c.id), true);
    for (const c of gone) assert.equal(existsSync(join(r.shelf.dir, c.file)), false);
    assert.equal((await r.shelf.list()).total, 2);
  } finally {
    await r.done();
  }
});

// ---- 4. a project chat's clip is copied into specialists\videos ----

test('a clip goes to specialists\\videos as a picture goes to specialists\\images, named with the date and time and its words', () => {
  const at = new Date(2026, 10, 25, 18, 40);
  const words = 'Waves rolling onto a beach at sunset';
  assert.equal(clipPath('site', words, '.webm', at), picturePath('site', words, '.webm', at).replace('/specialists/images/', '/specialists/videos/'));
  assert.match(clipPath('site', words, '.webm', at), /^site\/specialists\/videos\/2026-11-25-1840 \S.*\.webm$/);
  assert.match(clipPath('', 'a kite', '.webm', at), /^specialists\/videos\/2026-11-25-1840 /);
});

test('a finished clip is handed to the made hook with its file on the shelf; a hook that fails keeps the clip', async () => {
  const got: Array<{ c: ClipRecord; file: string; there: boolean }> = [];
  const fake = new FakeVideoRunner();
  const r = await rig(fake, { made: async (c, file) => void got.push({ c, file, there: existsSync(file) }) });
  try {
    const v = await ended(r.clips, started(r.clips.start(ask({ chat: 'proj-chat' }))).id);
    assert.equal(v.state, 'done');
    assert.equal(got.length, 1);
    assert.equal(got[0].c.chat, 'proj-chat');
    assert.equal(got[0].file, join(r.shelf.dir, v.clip!.file));
    assert.ok(got[0].there, 'the file is on the shelf when the hook runs');
  } finally {
    await r.done();
  }
  const bad = await rig(new FakeVideoRunner(), { made: async () => { throw new Error('disk full'); } });
  try {
    const v = await ended(bad.clips, started(bad.clips.start(ask())).id);
    assert.equal(v.state, 'done', 'never a fault: the clip is on the shelf either way');
    assert.equal((await bad.shelf.list()).total, 1);
  } finally {
    await bad.done();
  }
});

test('the server copies a project chat\'s clip into that project, as it does a kept picture', async () => {
  const places = await read('src/server/places.ts');
  assert.match(places, /export async function handInClip\(/);
  assert.match(places, /if \(!chat\?\.project\) return;/);
  assert.match(places, /handInTo\(chat\.project, c\.prompt, file, c\.file, 'clip'\)/);
  assert.match(places, /kind === 'clip' \? folders\.clipPath\(folder, prompt, ext \|\| '\.webm'\)/);
  assert.match(places, /if \(kind === 'picture'\) await handInSource/, 'a clip has no image source');
  assert.match(await read('src/server.ts'), /clipHooks\.made = handInClip;/);
  assert.match(await read('src/server/clips.ts'), /made: async \(clip, file\) => \{[\s\S]{0,300}?await clipHooks\.made\?\.\(clip, file\);/);
});

// ---- 5. the time left while the clip file is written ----

class HandRunner implements VideoRunner {
  progress: ((p: VideoProgress) => void) | null = null;
  finish: ((file: string) => void) | null = null;
  async installed() {
    return true;
  }
  make(job: VideoJob, onProgress: (p: VideoProgress) => void, signal: AbortSignal) {
    this.progress = onProgress;
    return new Promise<Awaited<ReturnType<VideoRunner['make']>>>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      this.finish = file => resolve({ file, mime: 'video/webm', bytes: 4, seconds: job.seconds, width: job.width, height: job.height, model: job.model, tookMs: 1000 });
    });
  }
}

test('writing the clip file: the time left counts down from the runner\'s figure, then only the time so far shows', async () => {
  let t = 5_000_000;
  const hand = new HandRunner();
  const r = await rig(hand, { now: () => t });
  try {
    const v = started(r.clips.start(ask()));
    for (let i = 0; i < 400 && !hand.progress; i++) await new Promise(res => setTimeout(res, 2));
    hand.progress!({ stage: 'making', done: 20, total: 20, secondsLeft: 12 });
    t += 1000;
    // The runner says its figure once as the file starts, and nothing after.
    hand.progress!({ stage: 'joining', done: 20, total: 20, secondsLeft: 12 });
    assert.equal(r.clips.view(v.id)!.secondsLeft, 12);
    t += 5000;
    assert.equal(r.clips.view(v.id)!.secondsLeft, 7, 'counted down, not frozen at 12');
    assert.match(progressLine(r.clips.view(v.id)!), /^Writing the clip file · about 7 s left · 6 s so far$/);
    // Said again (a linked PC repeats its last figure): still counted from when the file started.
    hand.progress!({ stage: 'joining', done: 20, total: 20, secondsLeft: 12 });
    assert.equal(r.clips.view(v.id)!.secondsLeft, 7);
    t += 20_000;
    const late = r.clips.view(v.id)!;
    assert.equal(late.secondsLeft, null, 'past the figure: no time left is said');
    assert.equal(progressLine(late), 'Writing the clip file · 26 s so far');
    const f = join(r.dir, 'made.webm');
    await writeFile(f, 'webm');
    hand.finish!(f);
    assert.equal((await ended(r.clips, v.id)).state, 'done');
  } finally {
    await r.done();
  }
});

test('writing the clip file with no figure from the runner shows the time so far only', async () => {
  let t = 1_000;
  const hand = new HandRunner();
  const r = await rig(hand, { now: () => t });
  try {
    const v = started(r.clips.start(ask()));
    for (let i = 0; i < 400 && !hand.progress; i++) await new Promise(res => setTimeout(res, 2));
    hand.progress!({ stage: 'joining', done: 20, total: 20, secondsLeft: null });
    t += 3000;
    assert.equal(progressLine(r.clips.view(v.id)!), 'Writing the clip file · 3 s so far');
    hand.finish!(join(r.dir, 'none.webm'));
    await ended(r.clips, v.id);
  } finally {
    await r.done();
  }
});
