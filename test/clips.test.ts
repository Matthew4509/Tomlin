// A Videographer's clips (src/clips.ts, src/gallery.ts ClipShelf): the ask made safe, one clip at a time on each PC,
// progress with the time left, Stop, the file kept on the Videos shelf with its line in the chat, every fault as a
// plain line, the low-disk line, and nothing sent over the network. Uses the pretend runner in test/fakeclip.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Clips, CLIP_SIZES, FAULT_WORDS, WAIT_MAX, cleanAsk, isRunning, isVideographer, lowDiskLine, progressLine, type ClipAsk, type ClipView } from '../src/clips.ts';
import { ClipShelf, type ClipRecord } from '../src/gallery.ts';
import type { ChatLine } from '../src/store.ts';
import { LOW_DISK_BYTES, MAX_CLIP_SECONDS, VideoFault, type VideoFaultKind, type VideoProgress, type VideoRunner } from '../src/videotypes.ts';
import { FAKE_CLIP, FakeVideoRunner } from './fakeclip.ts';

const GB = 2 ** 30;
const ask = (extra: Partial<ClipAsk> = {}): ClipAsk => ({ prompt: 'waves on a beach', seconds: 2, width: 832, height: 480, quality: 'draft', model: 'wan-1.3b', who: 'staff:v1', name: 'Vic', chat: 'c1', pc: 'here', seed: 7, ...extra });

async function rig(runner: VideoRunner | null, free: number | null = 50 * GB, now?: () => number) {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-clips-'));
  const shelf = new ClipShelf(join(dir, 'videos'));
  const lines: Array<{ chat: string; line: ChatLine }> = [];
  const clips = new Clips({ runner: () => runner, shelf, free: async () => free, saveLine: async (chat, line) => void lines.push({ chat, line }), now });
  return { dir, shelf, lines, clips, done: () => rm(dir, { recursive: true, force: true }) };
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
  assert.ok(!('refused' in v), 'the clip was put in line');
  return v as ClipView;
};

test('the ask is made safe: a prompt, 1 to MAX_CLIP_SECONDS seconds, one of the sizes and qualities', () => {
  assert.equal(MAX_CLIP_SECONDS, 5);
  assert.deepEqual(cleanAsk({ prompt: '  a  fox  ', seconds: 9, size: 'tall', quality: 'best' }, () => 8), { prompt: 'a fox', seconds: 5, width: 480, height: 832, quality: 'best', seed: 8 });
  assert.deepEqual(cleanAsk({ prompt: 'a fox', seconds: 0 }, () => 8), { prompt: 'a fox', seconds: 1, width: CLIP_SIZES[0].width, height: CLIP_SIZES[0].height, quality: 'normal', seed: 8 });
  assert.equal((cleanAsk({ prompt: 'a fox', seconds: 'lots', size: '9999x9999', quality: 'ultra' }) as { seconds: number }).seconds, 3);
  assert.equal((cleanAsk({ prompt: 'a fox', size: '9999x9999' }) as { width: number }).width, 832);
  assert.match((cleanAsk({ prompt: '   ' }) as { error: string }).error, /what the clip should show/);
  assert.match((cleanAsk({ prompt: 'x'.repeat(1001) }) as { error: string }).error, /too long/);
});

test('only the videographer role makes clips', () => {
  assert.equal(isVideographer({ role: 'videographer' }), true);
  assert.equal(isVideographer({ role: 'artist' }), false);
  assert.equal(isVideographer(null), false);
});

test('prompt in, clip out: progress, the file on the Videos shelf and a line with a player in the chat, nothing over the network', async () => {
  const runner = new FakeVideoRunner({ fps: 3, frameMs: 2 });
  const r = await rig(runner);
  const fetchWas = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('a clip must never use the network'); }) as typeof fetch;
  try {
    const v = started(r.clips.start(ask({ seconds: 2 })));
    assert.equal(v.prompt, 'waves on a beach');
    const end = await ended(r.clips, v.id);
    assert.equal(end.state, 'done', end.error ?? '');
    assert.equal(runner.made.length, 1);
    assert.deepEqual({ ...runner.made[0] }, { prompt: 'waves on a beach', seconds: 2, width: 832, height: 480, quality: 'draft', model: 'wan-1.3b', seed: 7 });
    const c = end.clip!;
    assert.match(c.file, /^\d{4}-\d{2}\/clip-[0-9a-f]{12}\.webm$/);
    assert.deepEqual(await readFile(join(r.shelf.dir, c.file)), await readFile(FAKE_CLIP));
    assert.equal((await r.shelf.list()).total, 1);
    assert.equal((await r.shelf.file(c.file))?.mime, 'video/webm');
    // The chat has the clip, with its player's file and size.
    assert.equal(r.lines.length, 1);
    const { chat, line } = r.lines[0];
    assert.equal(chat, 'c1');
    assert.equal(line.role, 'assistant');
    assert.deepEqual(line.clip, { id: c.id, file: c.file, mime: 'video/webm', prompt: 'waves on a beach', seconds: 2, width: 832, height: 480 });
    assert.match(line.ran ?? '', /^on this PC in /);
    // Read back from the disk by a new shelf (TOMLIN started again).
    const again = new ClipShelf(r.shelf.dir);
    assert.equal((await again.get(c.id))?.prompt, 'waves on a beach');
  } finally {
    globalThis.fetch = fetchWas;
    await r.done();
  }
});

/** A runner the test moves by hand: each progress step, and when it finishes. */
class HandRunner implements VideoRunner {
  progress: ((p: VideoProgress) => void) | null = null;
  signal: AbortSignal | null = null;
  finish: ((file: string) => void) | null = null;
  async installed() {
    return true;
  }
  make(job: { seconds: number; width: number; height: number; model: string }, onProgress: (p: VideoProgress) => void, signal: AbortSignal) {
    this.progress = onProgress;
    this.signal = signal;
    return new Promise<Awaited<ReturnType<VideoRunner['make']>>>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      this.finish = file => resolve({ file, mime: 'video/webm', bytes: 4, seconds: job.seconds, width: job.width, height: job.height, model: job.model, tookMs: 1000 });
    });
  }
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise(r => setTimeout(r, 2));
  assert.ok(ok());
};

test('the progress line has a time left: the runner\'s, or worked out from the time each frame took', async () => {
  let t = 1_000_000;
  const hand = new HandRunner();
  const r = await rig(hand, 50 * GB, () => t);
  try {
    const v = started(r.clips.start(ask()));
    await until(() => !!hand.progress);
    hand.progress!({ stage: 'loading', done: 0, total: 40, secondsLeft: null });
    assert.match(progressLine(r.clips.view(v.id)!), /^Loading the video model · 1 s so far$/);
    hand.progress!({ stage: 'making', done: 0, total: 40, secondsLeft: null });
    t += 20_000;
    hand.progress!({ stage: 'making', done: 10, total: 40, secondsLeft: null });
    // 2 s a frame, 30 to go: about a minute.
    const mid = r.clips.view(v.id)!;
    assert.equal(mid.secondsLeft, 60);
    assert.equal(progressLine(mid), 'Making the clip · step 10 of 40 · about 1 min left · 20 s so far');
    hand.progress!({ stage: 'making', done: 20, total: 40, secondsLeft: 125 });
    assert.match(progressLine(r.clips.view(v.id)!), /about 2 min 5 s left/);
    const f = join(r.dir, 'made.webm');
    await writeFile(f, 'webm');
    hand.finish!(f);
    assert.equal((await ended(r.clips, v.id)).state, 'done');
    assert.equal(existsSync(f), false, 'the runner\'s file was moved onto the shelf');
  } finally {
    await r.done();
  }
});

test('Stop: the clip being made stops, nothing is kept, and the chat says so', async () => {
  const hand = new HandRunner();
  const r = await rig(hand);
  try {
    const v = started(r.clips.start(ask()));
    await until(() => !!hand.progress);
    hand.progress!({ stage: 'making', done: 3, total: 40, secondsLeft: 30 });
    assert.equal(r.clips.stop(v.id), true);
    assert.equal(hand.signal!.aborted, true);
    const end = await ended(r.clips, v.id);
    assert.equal(end.state, 'stopped');
    assert.equal(end.fault, 'stopped');
    assert.equal((await r.shelf.list()).total, 0);
    assert.deepEqual(r.lines.map(l => [l.line.content, l.line.stopped]), [[FAULT_WORDS.stopped, true]]);
    assert.equal(r.clips.stop(v.id), false, 'a clip that ended cannot be stopped again');
  } finally {
    await r.done();
  }
});

test('one clip at a time on each PC: the next waits its turn, another PC starts at once, too many waiting is busy', async () => {
  const hand = new HandRunner();
  const r = await rig(hand);
  try {
    const a = started(r.clips.start(ask({ prompt: 'first' })));
    const b = started(r.clips.start(ask({ prompt: 'second' })));
    assert.equal(b.state, 'queued');
    assert.match(progressLine(b), /^Waiting for the clip before it/);
    assert.notEqual(r.clips.view(a.id)!.state, 'queued');
    const other = started(r.clips.start(ask({ prompt: 'on the other PC', pc: 'z820' })));
    assert.equal(other.state, 'loading', 'another PC is not held up by this one');
    // Stop on a waiting clip takes it out of line.
    assert.equal(r.clips.stop(b.id), true);
    assert.equal((await ended(r.clips, b.id)).state, 'stopped');
    for (let i = 0; i < WAIT_MAX; i++) started(r.clips.start(ask({ prompt: `more ${i}` })));
    const busy = r.clips.start(ask({ prompt: 'one too many' }));
    assert.ok('refused' in busy);
    assert.equal((busy as { fault: VideoFaultKind }).fault, 'busy');
    r.clips.stopAll();
    await until(() => r.clips.running().length === 0);
  } finally {
    await r.done();
  }
});

test('each fault is a plain line in the chat, and no clip is kept', async () => {
  const cases: Array<[string, VideoRunner | null, Partial<ClipAsk>, number | null, RegExp | string]> = [
    ['no runner set up', null, {}, 50 * GB, FAULT_WORDS['not-installed']],
    ['runner not installed', new FakeVideoRunner({ installed: false }), {}, 50 * GB, FAULT_WORDS['not-installed']],
    ['no model chosen', new FakeVideoRunner(), { model: '' }, 50 * GB, /^Vic has no video model yet/],
    ['under 2 GB free', new FakeVideoRunner(), {}, 1.5 * GB, /^Under 2 GB free where clips are kept \(1\.5 GB\)/],
    ['missing model', new FakeVideoRunner({ fail: 'missing-model' }), {}, 50 * GB, FAULT_WORDS['missing-model']],
    ['out of memory', new FakeVideoRunner({ fail: 'out-of-memory', failAt: 2 }), {}, 50 * GB, FAULT_WORDS['out-of-memory']],
    ['crashed', new FakeVideoRunner({ fail: 'crashed', failAt: 1 }), {}, 50 * GB, FAULT_WORDS.crashed],
    ['busy', new FakeVideoRunner({ fail: 'busy' }), {}, 50 * GB, FAULT_WORDS.busy],
    ['pc off', new FakeVideoRunner({ fail: 'pc-off' }), {}, 50 * GB, FAULT_WORDS['pc-off']],
    ['the runner\'s own words', { installed: async () => true, make: async () => { throw new VideoFault('out-of-memory', 'The 3060 ran out of memory at frame 12.'); } }, {}, 50 * GB, 'The 3060 ran out of memory at frame 12.'],
    ['any other fault', { installed: async () => true, make: async () => { throw new Error('sd.exe exited with code 3'); } }, {}, 50 * GB, 'The clip could not be made: sd.exe exited with code 3.'],
  ];
  for (const [what, runner, extra, free, said] of cases) {
    const r = await rig(runner, free);
    try {
      const v = started(r.clips.start(ask(extra)));
      const end = await ended(r.clips, v.id);
      assert.equal(end.state, 'failed', what);
      assert.equal(r.lines.length, 1, what);
      const line = r.lines[0].line;
      assert.equal(line.failed, true, what);
      if (typeof said === 'string') assert.equal(line.content, said, what);
      else assert.match(line.content, said, what);
      assert.equal(end.error, line.content, what);
      assert.equal((await r.shelf.list()).total, 0, what);
    } finally {
      await r.done();
    }
  }
});

test('every fault kind has its own plain words', () => {
  const kinds: VideoFaultKind[] = ['not-installed', 'missing-model', 'out-of-memory', 'low-disk', 'crashed', 'stopped', 'busy', 'pc-off'];
  for (const k of kinds) assert.match(FAULT_WORDS[k], /^[A-Z].+\.$/, k);
  assert.equal(new Set(kinds.map(k => FAULT_WORDS[k])).size, kinds.length);
});

test('the low-disk line shows under 2 GB free and not otherwise', () => {
  assert.equal(LOW_DISK_BYTES, 2 * GB);
  assert.equal(lowDiskLine(null), '');
  assert.equal(lowDiskLine(2 * GB), '');
  assert.match(lowDiskLine(0.4 * GB), /^Under 2 GB free where clips are kept \(0\.4 GB\)/);
});

test('the Videos shelf: newest first, search, one chat, delete takes the file, only its own files are served', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomlin-shelf-'));
  try {
    const shelf = new ClipShelf(dir);
    const rec = (id: string, prompt: string, chat: string): ClipRecord => ({ id, at: new Date().toISOString(), prompt, seconds: 2, width: 832, height: 480, quality: 'normal', model: 'm', file: '', mime: 'video/webm', bytes: 4, tookMs: 5, who: 'staff:v', chat });
    for (const [id, prompt, chat] of [['a', 'a red fox running', 'c1'], ['b', 'rain on a window', 'c2'], ['c', 'a fox asleep', 'c1']] as const) {
      const src = join(dir, `${id}.webm`);
      await writeFile(src, id);
      await shelf.add({ ...rec(id, prompt, chat), file: await shelf.take(src, `clip-${id}.webm`) });
    }
    assert.deepEqual((await shelf.list()).clips.map(c => c.id), ['c', 'b', 'a']);
    assert.deepEqual((await shelf.list(0, 60, 'fox')).clips.map(c => c.id), ['c', 'a']);
    assert.deepEqual((await shelf.list(0, 60, '', 'c2')).clips.map(c => c.id), ['b']);
    const a = (await shelf.get('a'))!;
    assert.ok(await shelf.file(a.file));
    assert.equal(await shelf.file('../gallery.jsonl'), null);
    assert.equal(await shelf.file('2026-11/not-a-clip.webm'), null);
    assert.equal(await shelf.file(a.file.replace('.webm', '.exe')), null);
    assert.equal(await shelf.remove('a'), true);
    assert.equal(existsSync(join(dir, a.file)), false);
    assert.equal(await shelf.file(a.file), null);
    assert.equal(await shelf.remove('a'), false);
    assert.deepEqual((await new ClipShelf(dir).list()).clips.map(c => c.id), ['c', 'b'], 'the delete is kept on the disk');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the page and the server are wired: the clip choices, Make clip, the player, the Videos shelf, the routes', async () => {
  const root = join(import.meta.dirname, '..');
  const read = (f: string) => readFile(join(root, f), 'utf8');
  const html = await read('public/index.html');
  for (const id of ['clip-row', 'clip-seconds', 'clip-size', 'clip-quality', 'clip-lowdisk', 'clip-shelf-open', 'clips-dlg', 'clips-list']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /data-shelf="videos"/);
  assert.match(html, /<script src="clips\.js"><\/script>/);
  assert.match(await read('public/chatview.js'), /app\.isClipChat\?\.\(\)\) return void app\.makeClip\(message\)/);
  assert.match(await read('public/app.js'), /l\.clip \? clipBubble\(l\.clip/);
  assert.match(await read('public/images.js'), /shelf === 'videos'/);
  const js = await read('public/clips.js');
  for (const bit of ['/api/clips/make', '/api/clips/stop', '/api/clips/job', '/api/clips/shelf', '/api/clips/delete']) assert.ok(js.includes(bit), bit);
  const server = await read('src/server.ts');
  assert.match(server, /clipsGet/);
  assert.match(server, /clipsPost/);
  assert.match(server, /clipFile\(req, res, p\)/);
  // The engine comes in by injection: the clip code never imports the runner itself.
  for (const f of ['src/clips.ts', 'src/server/clips.ts']) assert.doesNotMatch(await read(f), /from ['"][./]+video\.ts['"]/, f);
  // A text answer is never asked of a Videographer.
  assert.match(await read('src/server/chat.ts'), /isVideographer\(member\)/);
});
