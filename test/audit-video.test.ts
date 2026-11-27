// Audit of the video area (clips, the shot list, the video runner and the linked-PC video doors): one test per fault
// found. A test for a fault that blocks a task fails now and passes once it is fixed; a lesser fault is marked todo.
// Everything runs in this process over 127.0.0.1 with stand-in runners: no graphics card, no real runner, no model.
// The far PC of the linked-PC tests is an in-process worker door on port 8793 that opens each request as
// src/jobrun/node.ts does (as test/videolink.test.ts does on its own port).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTestEnv } from './env.ts';

// Every file this test writes is under %LOCALAPPDATA%\Temp\tomlin-audit-video.
const ROOT = join(process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp') : tmpdir(), 'tomlin-audit-video');
mkdirSync(ROOT, { recursive: true });
const home = mkdtempSync(join(ROOT, 'home-'));
useTestEnv({ TOMLIN_HOME: home, TOMLIN_PORT: '0', TOMLIN_OPEN: '', TOMLIN_NO_TOAST: '1', TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_STARTUP_DIR: join(home, 'startup') });
writeFileSync(join(home, 'models-folder.txt'), '');
// The stand-in runners and the far PC write their own temporary files under the system temp folder: kept here too.
process.env.TEMP = process.env.TMP = mkdtempSync(join(ROOT, 'tmp-'));
const tempHere = process.env.TEMP;
const made: string[] = [];
const scratch = (what: string) => {
  const d = mkdtempSync(join(ROOT, `${what}-`));
  made.push(d);
  return d;
};

// Only now the app's modules (some of them find their data folder as they load).
const link = await import('../src/link.ts');
const share = await import('../src/share.ts');
const { VideoFault } = await import('../src/videotypes.ts');
const vl = await import('../src/videolink.ts');
const { SdVideoRunner, VideoTestDoor } = await import('../src/video.ts');
const { Clips, cleanAsk, againAsk, isRunning } = await import('../src/clips.ts');
const { ClipShelf } = await import('../src/gallery.ts');
const { Shots } = await import('../src/shots.ts');
const { expandPrompt } = await import('../src/cards.ts');
const { FakeVideoRunner } = await import('./fakeclip.ts');
const core = await import('../src/server/core.ts');
const serverClips = await import('../src/server/clips.ts');
const serverShots = await import('../src/server/shots.ts');
const people = await import('../src/server/people.ts');
const { WAIT_PAGE } = await import('../src/shots.ts');
const pretend = new FakeVideoRunner({ fps: 2, frameMs: 60 });
serverClips.setVideoRunner(pretend);
type VideoJob = import('../src/videotypes.ts').VideoJob;
type VideoRunner = import('../src/videotypes.ts').VideoRunner;
type VideoOut = import('../src/videolink.ts').VideoOut;
type ClipView = import('../src/clips.ts').ClipView;
type ClipAsk = import('../src/clips.ts').ClipAsk;

const until = async (ok: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`never: ${what}`);
};

test.after(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(tempHere, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  // The server modules keep timers; the test process ends here.
  setTimeout(() => process.exit(0), 300);
});

// ---- A far PC over the real sealed link (as test/videolink.test.ts) ----

const FAR_PORT = 8793;
const JOB: VideoJob = { prompt: 'a red kite over a green hill', seconds: 2, width: 512, height: 320, quality: 'draft', model: 'wan-small' };

function mp4(file: string, size = 64 * 1024) {
  const b = randomBytes(size);
  b.write('ftyp', 4, 'latin1');
  writeFileSync(file, b);
  return b;
}

/** The far PC's sealed answers, as src/jobrun/node.ts gives them. */
function sealedOut(res: ServerResponse, keys: Buffer, id: string): VideoOut {
  let n = 0;
  return {
    json(status, value) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end(link.sealedEvent(keys, id, ++n, 'error', { text: String((value as { error?: unknown }).error) }));
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ v: link.LINK_VERSION, box: link.sealAnswer(keys, id, 0, value) }));
    },
    stream() {
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      return {
        send(event, data) {
          if (!res.destroyed) res.write(link.sealedEvent(keys, id, ++n, event, data));
        },
        end() {
          if (!res.writableEnded) res.end();
        },
      };
    },
    piece(bytes) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(link.sealBytes(link.toHost(keys), bytes, `piece|${id}`));
    },
  };
}

async function farPc(runner: VideoRunner | null, o: { now?: () => number; delayMake?: number } = {}) {
  const keys = randomBytes(64);
  const token = randomBytes(32).toString('hex');
  const seen = new link.Seen();
  const removed: string[] = [];
  const node = new vl.VideoNode({ name: () => 'Z820', away: () => null, busy: () => null }, { remove: async f => void removed.push(f), now: o.now });
  node.setRunner(runner);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    if (req.headers.authorization !== `Link ${share.hashToken(token)}`) return void res.writeHead(401).end();
    let raw = '';
    for await (const c of req) raw += c;
    const opened = link.openRequest(keys, JSON.parse(raw), p, seen);
    if ('error' in opened) return void res.writeHead(400).end(JSON.stringify(opened));
    // A make request that takes a moment to be read and opened there (a large start picture, a busy PC).
    if (p === vl.VIDEO_MAKE && o.delayMake) await new Promise(r => setTimeout(r, o.delayMake));
    await node.handle(p, opened.body, { key: 'host-a', name: 'This PC' }, sealedOut(res, keys, opened.id));
  });
  await new Promise<void>(r => server.listen(FAR_PORT, '127.0.0.1', r));
  return {
    node,
    removed,
    pc: { name: 'Z820', url: `http://127.0.0.1:${FAR_PORT}`, token, key: link.keysText(keys) },
    close: () => new Promise<void>(r => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

/**
 * A video runner on the far PC that behaves as src/video.ts does: one clip at a time, and Stop takes a moment (the
 * runner's process is ended by PID and waited for) before make() gives up.
 */
function cardRunner(dir: string, o: { stopMs?: number; workMs?: number } = {}) {
  const r = {
    calls: 0,
    busy: false,
    installed: async () => true,
    async make(job: VideoJob, onProgress: (p: { stage: 'loading' | 'making' | 'joining'; done: number; total: number; secondsLeft: number | null }) => void, signal: AbortSignal) {
      r.calls++;
      if (r.busy) throw new VideoFault('busy', 'This PC is making another clip now.');
      r.busy = true;
      try {
        onProgress({ stage: 'loading', done: 0, total: 4, secondsLeft: null });
        onProgress({ stage: 'making', done: 1, total: 4, secondsLeft: 3 });
        const stoppedNow = await new Promise<boolean>(resolve => {
          const t = setTimeout(() => resolve(false), o.workMs ?? 300);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve(true);
          }, { once: true });
        });
        if (stoppedNow) {
          // The process is ended and waited for.
          await new Promise(res => setTimeout(res, o.stopMs ?? 400));
          throw new VideoFault('stopped', 'Stopped. No clip was made.');
        }
        const file = join(dir, `made-${r.calls}.mp4`);
        const b = mp4(file);
        return { file, mime: 'video/mp4' as const, bytes: b.length, seconds: job.seconds, width: job.width, height: job.height, model: job.model, tookMs: 10 };
      } finally {
        r.busy = false;
      }
    },
  };
  return r;
}

const askOf = (extra: Partial<ClipAsk> = {}): ClipAsk => ({ prompt: 'waves on a beach', seconds: 2, width: 832, height: 480, quality: 'draft', model: 'wan-1.3b', who: 'staff:v1', name: 'Vic', chat: 'c1', pc: 'z820', seed: 7, ...extra });

async function endedView(clips: InstanceType<typeof Clips>, id: string, ms = 15_000): Promise<ClipView> {
  let v: ClipView | null = null;
  await until(() => {
    v = clips.view(id);
    return !!v && !isRunning(v.state);
  }, `clip ${id} ended`, ms);
  return v!;
}

// ---- P0 ----

test('F-01: Stop on a clip made on a linked PC lets the next clip waiting for that PC be made', { timeout: 60_000 }, async () => {
  const there = scratch('far');
  const here = scratch('here');
  const runner = cardRunner(there, { workMs: 30_000, stopMs: 400 });
  const peer = await farPc(runner);
  try {
    const lines: string[] = [];
    const shelf = new ClipShelf(join(here, 'videos'));
    const clips = new Clips({
      runner: () => new vl.RemoteVideoRunner({ pc: 'Z820', wire: vl.sealedWire(peer.pc), dir: shelf.dir }),
      shelf,
      free: async () => 100 * 2 ** 30,
      saveLine: async (_c, l) => void lines.push(String(l.content)),
    });
    const a = clips.start(askOf({ prompt: 'first clip' })) as ClipView;
    const b = clips.start(askOf({ prompt: 'second clip' })) as ClipView;
    await until(() => clips.view(a.id)?.state === 'making', 'the first clip is being made there');
    // The person presses Stop on the first: the second, waiting for the same PC, should now be made.
    assert.equal(clips.stop(a.id), true);
    const va = await endedView(clips, a.id);
    assert.equal(va.state, 'stopped');
    // Let the far PC's runner finish its work quickly for the second clip.
    const vb = await endedView(clips, b.id, 45_000);
    assert.equal(vb.state, 'done', `the second clip ended "${vb.state}": ${vb.error}`);
  } finally {
    await peer.close();
    rmSync(there, { recursive: true, force: true });
    rmSync(here, { recursive: true, force: true });
  }
});

/** A stand-in sd-cli process (as test/video.test.ts). */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { pid: 4000 + Math.floor(Math.random() * 1000), stdout, stderr, exitCode: null, signalCode: null });
  child.kill = () => true;
  const end = (code: number | null, signal: string | null = null) => {
    Object.assign(child, { exitCode: code, signalCode: signal });
    child.emit('exit', code, signal);
    stdout.end();
    stderr.end();
    setImmediate(() => child.emit('close', code, signal));
  };
  return { child, end };
}

test('F-02: two clips asked of this PC at the same moment never run two video runners on the card', { timeout: 30_000 }, async () => {
  const dir = scratch('sdrun');
  try {
    const files = { name: 'Wan test', diffusion: join(dir, 'wan.gguf'), vae: join(dir, 'wan_vae.safetensors'), textEncoder: join(dir, 'umt5.gguf') };
    for (const f of [files.diffusion, files.vae, files.textEncoder]) writeFileSync(f, 'x');
    const kids: ReturnType<typeof fakeChild>[] = [];
    const deps = {
      findExe: () => ({ exe: join(dir, 'sd-cli.exe'), device: 'cuda' as const, pin: 'sd-cuda' }),
      resolve: async () => files,
      outDir: join(dir, 'clips'),
      // Reading the free space takes a moment (a statfs on a busy disk).
      freeBytes: async () => {
        await new Promise(r => setTimeout(r, 30));
        return 100 * 2 ** 30;
      },
      start: () => {
        const k = fakeChild();
        kids.push(k);
        return k.child as never;
      },
      killTree: async (c: unknown) => kids.find(k => k.child === c)?.end(null, 'SIGTERM'),
      now: () => Date.now(),
    };
    // A Videographer's clip here and a linked PC's clip (src/videolink.ts VideoNode) arrive together.
    const mine = new SdVideoRunner(deps);
    const theirs = new SdVideoRunner(deps);
    const ac = new AbortController();
    const p1 = mine.make(JOB, () => undefined, ac.signal).catch(e => e);
    const p2 = theirs.make({ ...JOB, prompt: 'another clip' }, () => undefined, ac.signal).catch(e => e);
    await new Promise(r => setTimeout(r, 300));
    const started = kids.length;
    ac.abort();
    for (const k of kids) k.end(null, 'SIGTERM');
    await Promise.all([p1, p2]);
    assert.equal(started, 1, `${started} video runners were started on the card at once`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F-04: Make again works for a clip whose prompt named characters (@names)', () => {
  // The clip is asked with a short prompt naming two cards; the clip is put in line with the prompt filled in
  // (src/server/clips.ts makeClip), and that is the prompt the shelf keeps (src/clips.ts record.prompt = ask.prompt).
  const card = (name: string, words: string) => ({ kind: 'character' as const, name, words, avoid: '', refs: [], at: '' });
  const typed = '@Ember and @Rook cross the frozen river at dawn, slow tracking shot';
  const e = expandPrompt(typed, [card('Ember', `a young red fox with ${'a bright white tail tip, '.repeat(20)}`.slice(0, 600)), card('Rook', `an old black crow with ${'grey ragged wing feathers, '.repeat(20)}`.slice(0, 600))]);
  assert.ok(typed.length < 100 && e.used.length === 2);
  const first = cleanAsk({ prompt: typed });
  assert.ok(!('error' in first), 'the first ask is taken');
  const record = { id: 'c1', chat: 'chat1', who: 'staff:v1', prompt: e.prompt, seconds: 3, width: 832, height: 480, quality: 'normal', seed: 5 } as never;
  const again = cleanAsk(againAsk(record, 'same'));
  assert.ok(!('error' in again), `Make again was refused: ${'error' in again ? again.error : ''}`);
});

// ---- The server's own routes in a throwaway home (as test/shotsroute.test.ts) ----



const call = async (routes: any, path: string, b: unknown, url?: URL) => {
  let status = 0;
  let body: any;
  let type = '';
  const res = {
    writeHead(s: number, h: Record<string, string>) {
      status = s;
      type = h?.['content-type'] ?? '';
      return this;
    },
    end(x: string | Buffer) {
      if (!type.startsWith('image/')) body = JSON.parse(String(x));
    },
  };
  await routes[path]({ res, b, url: url ?? new URL(`http://x${path}`) });
  return { status, body };
};

const clipsFor = (chat: string) => serverClips.clips.running().filter(v => v.chat === chat);

test('F-03: deleting a Videographer\'s chat stops its shot list and its clip, and nothing is written back to it', { timeout: 60_000 }, async () => {
  const vic = await core.staff.hire('Dee Example', 'videographer', 'default', 'wan22-ti2v-5b');
  const who = `staff:${vic.id}`;
  const a = await call(serverShots.shotsPost, '/api/shots/add', { chatId: '', who, prompt: 'a lighthouse at dusk', seconds: 3, size: 'wide', quality: 'draft' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const chat = a.body.chat as string;
  for (const p of ['waves hit the rocks', 'gulls circle the lamp', 'the beam sweeps the sea']) await call(serverShots.shotsPost, '/api/shots/add', { chatId: chat, prompt: p, seconds: 3, size: 'wide', quality: 'draft' });
  const r = await call(serverShots.shotsPost, '/api/shots/run', { chatId: chat, do: 'start' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => clipsFor(chat).some(v => v.state === 'making'), 'the first shot is being made');
  const file = join(core.store.dir, core.chats.file(chat));
  try {
    const d = await call(people.peoplePost, '/api/chats/delete', { id: chat });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(existsSync(file), false, 'the chat file is gone');
    // Within a few seconds nothing is made for the deleted chat any more, and its file is not written again.
    const before = pretend.made.length;
    await new Promise(res => setTimeout(res, 4_000));
    const facts = { list: serverShots.shots.get(chat)?.run ?? 'gone', clipsMadeSince: pretend.made.length - before, chatFileBack: existsSync(file) };
    assert.deepEqual(facts, { list: 'gone', clipsMadeSince: 0, chatFileBack: false });
  } finally {
    await serverShots.shots.stop(chat);
    for (const v of serverClips.clips.running()) serverClips.clips.stop(v.id);
  }
});

test('F-06: a shot list whose carried-on clip was deleted from the Videos shelf says so, and does not wait for ever', { timeout: 60_000 }, async () => {
  const vic = await core.staff.hire('Eli Example', 'videographer', 'default', 'wan22-ti2v-5b');
  const who = `staff:${vic.id}`;
  await until(() => !serverClips.clips.running().length, 'this PC is free');
  const a = await call(serverShots.shotsPost, '/api/shots/add', { chatId: '', who, prompt: 'a red door', seconds: 1, size: 'wide', quality: 'draft' });
  const chat = a.body.chat as string;
  const b = await call(serverShots.shotsPost, '/api/shots/add', { chatId: chat, prompt: 'the door opens', seconds: 1, size: 'wide', quality: 'draft', start: { kind: 'last' } });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const second = b.body.shot as string;
  try {
    await call(serverShots.shotsPost, '/api/shots/run', { chatId: chat, do: 'start' });
    await until(() => serverShots.shots.get(chat)?.said === WAIT_PAGE, 'the list waits for the last frame', 20_000);
    const take = serverShots.shots.get(chat)!.shots[0].takes[0];
    // The person deletes that clip from the Videos shelf.
    const del = await call(serverClips.clipsPost, '/api/clips/delete', { id: take.clip });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    // The page could never read its last frame now (the file is gone): the list should stop asking for it and say why.
    const asked = async () => (await call(serverShots.shotsGet, '/api/shots/frames', {})).body.frames.some((f: any) => f.shot === second);
    let stuck = false;
    try {
      await until(async () => !(await asked()), 'the list stopped asking for a frame of a deleted clip', 5_000);
    } catch {
      stuck = true;
    }
    const l = serverShots.shots.get(chat)!;
    assert.ok(!stuck, `the list still asks the page for the deleted clip's last frame and says "${l.said}" (shot 2 is "${l.shots[1].state}")`);
  } finally {
    await serverShots.shots.stop(chat);
  }
});

// ---- P1 (todo) ----

test('F-07: a clip kept on the linked PC and never collected is deleted there after KEEP_MS, with no other request', { timeout: 30_000 }, async () => {
  const there = scratch('keep');
  let t = Date.now();
  const runner = cardRunner(there, { workMs: 10 });
  const removed: string[] = [];
  const node = new vl.VideoNode({ name: () => 'Z820', away: () => null, busy: () => null }, { remove: async f => void removed.push(f), now: () => t });
  node.setRunner(runner);
  const quiet: VideoOut = { json: () => undefined, stream: () => ({ send: () => undefined, end: () => undefined }), piece: () => undefined };
  try {
    // The asking PC sends the job, then is switched off before it collects the clip.
    await node.handle(vl.VIDEO_MAKE, { cid: randomBytes(16).toString('hex'), job: JOB }, { key: 'host-a', name: 'This PC' }, quiet);
    assert.equal(runner.calls, 1);
    t += vl.KEEP_MS + 60_000;
    await new Promise(res => setTimeout(res, 300));
    assert.equal(removed.length, 1, 'the clip is still on the linked PC long after KEEP_MS (only a later request sweeps it)');
  } finally {
    rmSync(there, { recursive: true, force: true });
  }
});

test('F-08: a shot list held by a "busy" clip says the true reason, not "being used by its owner"', async () => {
  const dir = scratch('held');
  try {
    const views = new Map<string, ClipView>();
    const maker = {
      start(ask: ClipAsk) {
        const v = { id: randomBytes(4).toString('hex'), state: 'failed', fault: 'busy', error: '"Z820" is set to Backups only, so it takes no other work.', chat: ask.chat } as unknown as ClipView;
        views.set(v.id, v);
        return v;
      },
      view: (id: string) => views.get(id) ?? null,
      stop: () => true,
    };
    const shots = await Shots.load({ file: join(dir, 'shots.json'), clips: maker, starts: { give: async ask => ({ ask }) } });
    const hire = { who: 'staff:v', name: 'Vic', pc: 'z820', pcName: 'Z820', model: 'wan-1.3b' };
    await shots.add('c1', hire, { prompt: 'a door', seconds: 1 });
    await shots.start('c1', hire);
    await until(async () => {
      await shots.settled();
      shots.turn();
      await shots.settled();
      return shots.get('c1')!.run === 'held';
    }, 'the list is held');
    assert.doesNotMatch(shots.get('c1')!.said, /being used by its owner/, 'a Backups only PC is said to be in use by its owner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F-09: Stop pressed while the next shot is being put in line leaves no clip made for it', async () => {
  const dir = scratch('race');
  try {
    const started: string[] = [];
    let release: () => void = () => undefined;
    const maker = {
      start(ask: ClipAsk) {
        started.push(ask.prompt);
        return { id: 'j1', state: 'loading', chat: ask.chat } as unknown as ClipView;
      },
      view: () => ({ id: 'j1', state: 'loading' }) as unknown as ClipView,
      stop: () => true,
    };
    // The @names are filled in (or a start picture fitted) while the list waits.
    const shots = await Shots.load({ file: join(dir, 'shots.json'), clips: maker, starts: { give: async ask => ({ ask }) }, expand: p => new Promise(r => (release = () => r(p))) });
    const hire = { who: 'staff:v', name: 'Vic', pc: 'here', pcName: 'this PC', model: 'wan-1.3b' };
    await shots.add('c1', hire, { prompt: 'a door', seconds: 1 });
    await shots.start('c1', hire);
    await new Promise(r => setTimeout(r, 20));
    await shots.stop('c1');
    release();
    await shots.settled();
    assert.deepEqual(started, [], 'a clip was put in line after Stop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F-10: Stop pressed at once on a linked PC\'s clip stops it there too', { timeout: 30_000 }, async () => {
  const there = scratch('early');
  const runner = cardRunner(there, { workMs: 2_000 });
  // The make request takes a moment to be read there; the Stop request is quicker.
  const peer = await farPc(runner, { delayMake: 300 });
  try {
    const r = new vl.RemoteVideoRunner({ pc: 'Z820', wire: vl.sealedWire(peer.pc), dir: scratch('early-here') });
    const ac = new AbortController();
    const going = r.make(JOB, () => undefined, ac.signal).catch(e => e);
    await new Promise(res => setTimeout(res, 100));
    ac.abort();
    assert.equal((await going).kind, 'stopped');
    await new Promise(res => setTimeout(res, 600));
    assert.equal(runner.busy, false, 'the linked PC is making the clip that was stopped here');
  } finally {
    await new Promise(res => setTimeout(res, 2_000));
    await peer.close();
    rmSync(there, { recursive: true, force: true });
  }
});

test('F-11: a prompt longer than the link takes is refused with a reason, not cut', () => {
  // A 1,000-character prompt naming three cards of 600 words each is about 2,900 characters once filled in.
  const job = vl.cleanJob({ ...JOB, prompt: `${'a fox runs. '.repeat(250)}` });
  assert.ok('error' in job, `the linked PC took ${'error' in job ? 0 : job.prompt.length} of 3000 characters without a word`);
});

test('F-12: two Test clip presses at once start one test clip', async () => {
  let makes = 0;
  const runner: VideoRunner = {
    installed: () => new Promise(r => setTimeout(() => r(true), 20)),
    make: () => {
      makes++;
      return new Promise(() => undefined);
    },
  };
  const door = new VideoTestDoor(runner);
  const [a, b] = await Promise.all([door.start({ model: 'wan' }), door.start({ model: 'wan' })]);
  assert.deepEqual([a.status, b.status, makes], [202, 409, 1]);
});

test('F-13: a card\'s words to leave out are added to a clip\'s and a shot\'s negative prompt, as for a picture', async () => {
  const { readFile } = await import('node:fs/promises');
  const clips = await readFile(new URL('../src/server/clips.ts', import.meta.url), 'utf8');
  const shots = await readFile(new URL('../src/server/shots.ts', import.meta.url), 'utf8');
  assert.match(clips, /withAvoid|\.avoid/, 'makeClip drops e.avoid');
  assert.match(shots, /withAvoid|\.avoid/, 'the shot list drops e.avoid');
});

test('F-14: pictures kept for a shot list go when their shot is deleted', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4oaGBFTEMLQkAgl1GAWqNFmsAAAAASUVORK5CYII=', 'base64');
  const vic = await core.staff.hire('Fay Example', 'videographer', 'default', 'wan22-ti2v-5b');
  const pic = await call(serverShots.shotsPost, '/api/shots/picture', { data: `data:image/png;base64,${png.toString('base64')}` });
  const a = await call(serverShots.shotsPost, '/api/shots/add', { chatId: '', who: `staff:${vic.id}`, prompt: 'a door', seconds: 1, start: { kind: 'picture', file: pic.body.file, name: 'door' } });
  await call(serverShots.shotsPost, '/api/shots/delete', { chatId: a.body.chat, id: a.body.shot });
  assert.equal(existsSync(join(core.HOME.data, 'shots', 'pictures', pic.body.file)), false);
});

test('F-05: a shot list can be stopped from its chat after its Videographer left the team', { timeout: 60_000 }, async () => {
  const vic = await core.staff.hire('Gus Example', 'videographer', 'default', 'wan22-ti2v-5b');
  const who = `staff:${vic.id}`;
  await until(() => !serverClips.clips.running().length, 'this PC is free', 20_000);
  const a = await call(serverShots.shotsPost, '/api/shots/add', { chatId: '', who, prompt: 'a kettle boils', seconds: 3, size: 'wide', quality: 'draft' });
  const chat = a.body.chat as string;
  for (const p of ['steam rises', 'a hand lifts it']) await call(serverShots.shotsPost, '/api/shots/add', { chatId: chat, prompt: p, seconds: 3, size: 'wide', quality: 'draft' });
  await call(serverShots.shotsPost, '/api/shots/run', { chatId: chat, do: 'start' });
  await until(() => clipsFor(chat).some(v => v.state === 'making'), 'a shot is being made');
  try {
    await core.staff.fire(vic.id);
    const stop = await call(serverShots.shotsPost, '/api/shots/run', { chatId: chat, do: 'stop' });
    assert.deepEqual([stop.status, serverShots.shots.get(chat)?.run], [200, 'idle'], stop.body.error);
  } finally {
    await serverShots.shots.stop(chat);
    for (const v of serverClips.clips.running()) serverClips.clips.stop(v.id);
  }
});

test('F-15: a linked PC that takes the clip and never answers ends the clip in a short time, not after minutes', { timeout: 30_000 }, async () => {
  const server = createServer(async req => {
    for await (const _ of req);
    // Accepted, read, and never answered (its TOMLIN is stuck).
  });
  await new Promise<void>(r => server.listen(FAR_PORT, '127.0.0.1', r));
  try {
    const pc = { name: 'Z820', url: `http://127.0.0.1:${FAR_PORT}`, token: 't', key: link.keysText(randomBytes(64)) };
    const r = new vl.RemoteVideoRunner({ pc: 'Z820', wire: vl.sealedWire(pc), dir: scratch('never'), quietMs: 500, pollMs: 200, lostMs: 1500 });
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 6_000);
    const got = await r.make(JOB, () => undefined, ac.signal).catch(e => e);
    clearTimeout(t);
    assert.equal(ac.signal.aborted, false, `still waiting after 6 s (it ended "${got?.kind}" only because the test stopped it)`);
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});

test('F-16: a clip that was made but could not be put on the shelf is not reported as never made, and its file is not left behind', { timeout: 30_000 }, async () => {
  const dir = scratch('shelf');
  const shelf = new ClipShelf(join(dir, 'videos'));
  // The shelf's list cannot be written (a full disk, a folder where the file should be).
  mkdirSync(join(dir, 'videos', 'clips.jsonl'), { recursive: true });
  const lines: string[] = [];
  const clips = new Clips({ runner: () => new FakeVideoRunner({ fps: 1 }), shelf, free: async () => 100 * 2 ** 30, saveLine: async (_c, l) => void lines.push(String(l.content)) });
  const v = clips.start(askOf({ pc: 'here' })) as ClipView;
  const end = await endedView(clips, v.id);
  const month = new Date().toISOString().slice(0, 7);
  const left = existsSync(join(dir, 'videos', month)) ? readdirSync(join(dir, 'videos', month)) : [];
  assert.deepEqual({ state: end.state, filesLeft: left.length }, { state: 'failed', filesLeft: 0 }, `${end.error} (${left.length} clip file(s) left on the shelf folder, on no list)`);
  assert.doesNotMatch(end.error ?? '', /could not be made/, 'the clip was made; it is the shelf that failed');
});
