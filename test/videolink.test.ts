// A Videographer on a linked PC (src/videolink.ts): two in-process PCs over the real sealed link. The far one is a small
// worker door on port 8754 that opens each request as src/jobrun/node.ts does and hands it to a VideoNode with a fake
// video runner; this one asks with a RemoteVideoRunner. No graphics card and no other PC is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as link from '../src/link.ts';
import * as share from '../src/share.ts';
import { GUEST_DOORS } from '../src/guestpass.ts';
import { PEER_DOORS } from '../src/peerlink.ts';
import { MAX_START_BYTES, VideoFault, type VideoJob, type VideoProgress, type VideoRunner } from '../src/videotypes.ts';
import { cleanJob, cleanStart, KEEP_MS, RemoteVideoRunner, sealedWire, VIDEO_DOORS, VIDEO_GET, VIDEO_MAKE, VIDEO_MAKE_BODY, VIDEO_PIECE, VideoNode, type VideoHere, type VideoOut, type VideoWire } from '../src/videolink.ts';

const PORT = 8754;
const JOB: VideoJob = { prompt: 'a red kite over a green hill', seconds: 3, width: 512, height: 320, quality: 'draft', model: 'wan-small' };

/** A clip-shaped file: "ftyp" at byte 4, as an mp4 has, then `size` bytes in all. */
function fakeMp4(file: string, size: number) {
  const b = randomBytes(size);
  b.write('ftyp', 4, 'latin1');
  writeFileSync(file, b);
  return b;
}

interface Fake extends VideoRunner {
  calls: number;
  sawAbort: boolean;
  file: string;
  bytes: Buffer | null;
}
/** A video runner that writes a clip of `size` bytes after two progress lines; `hold` keeps it working until Stop. */
function fakeRunner(dir: string, o: { size?: number; hold?: boolean; fault?: VideoFault; between?: number } = {}): Fake {
  const f: Fake = {
    calls: 0,
    sawAbort: false,
    file: join(dir, 'made-there.mp4'),
    bytes: null,
    installed: async () => true,
    async make(job, onProgress, signal) {
      f.calls++;
      onProgress({ stage: 'loading', done: 0, total: 1, secondsLeft: null });
      await new Promise(r => setTimeout(r, o.between ?? 20));
      onProgress({ stage: 'making', done: 1, total: 2, secondsLeft: 4 });
      if (o.hold) {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        f.sawAbort = true;
        throw new VideoFault('stopped', 'Stopped.');
      }
      await new Promise(r => setTimeout(r, o.between ?? 20));
      if (o.fault) throw o.fault;
      f.bytes = fakeMp4(f.file, o.size ?? 9 * 2 ** 20 + 123);
      return { file: f.file, mime: 'video/mp4', bytes: f.bytes.length, seconds: job.seconds, width: job.width, height: job.height, model: job.model, tookMs: 1234 };
    },
  };
  return f;
}

/** The far PC's sealed answers, as src/jobrun/node.ts gives them (workerJson, followerOf, a sealed piece). */
function sealedOut(res: ServerResponse, keys: Buffer, id: string, cut: boolean): VideoOut {
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
          // The network drops after the first word of progress.
          if (cut && event === 'progress') res.destroy();
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

interface Peer {
  node: VideoNode;
  here: { away: { since: string } | null; busy: string | null };
  removed: string[];
  close(): Promise<void>;
  /** The host's side of the link to it. */
  pc: { name: string; url: string; token: string; key: string };
  cutNextStream: boolean;
}
async function farPc(runner: VideoRunner | null, o: { now?: () => number } = {}): Promise<Peer> {
  const keys = randomBytes(64);
  const token = randomBytes(32).toString('hex');
  const seen = new link.Seen();
  const here = { away: null as { since: string } | null, busy: null as string | null };
  const removed: string[] = [];
  const v: VideoHere = { name: () => 'Z820', away: () => here.away, busy: () => here.busy };
  const node = new VideoNode(v, { remove: async f => void removed.push(f), now: o.now });
  node.setRunner(runner);
  const peer = { node, here, removed, cutNextStream: false } as Peer;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    if (req.headers.authorization !== `Link ${share.hashToken(token)}`) return void res.writeHead(401).end();
    let raw = '';
    for await (const c of req) raw += c;
    const opened = link.openRequest(keys, JSON.parse(raw), p, seen);
    if ('error' in opened) return void res.writeHead(400).end(JSON.stringify(opened));
    const cut = peer.cutNextStream && p === VIDEO_MAKE;
    if (cut) peer.cutNextStream = false;
    if (!VIDEO_DOORS.includes(p)) return void res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ v: 2, box: link.sealAnswer(keys, opened.id, 0, { error: 'no such door' }) }));
    await node.handle(p, opened.body, { key: 'host-a', name: 'This PC' }, sealedOut(res, keys, opened.id, cut));
  });
  await new Promise<void>(r => server.listen(PORT, '127.0.0.1', r));
  peer.close = () => new Promise<void>(r => {
    server.closeAllConnections();
    server.close(() => r());
  });
  peer.pc = { name: 'Z820', url: `http://127.0.0.1:${PORT}`, token, key: link.keysText(keys) };
  return peer;
}

/** A wire that counts (and may change) the pieces it brings, to show a clip comes in small pieces. */
function counting(w: VideoWire, o: { flip?: boolean } = {}) {
  const sizes: number[] = [];
  const wire: VideoWire = {
    stream: (p, b, s) => w.stream(p, b, s),
    ask: (p, b, s) => w.ask(p, b, s),
    async getPiece(p, b, s) {
      const piece = await w.getPiece(p, b, s);
      sizes.push(piece.length);
      if (o.flip && sizes.length === 2) piece[10] ^= 0xff;
      return piece;
    },
  };
  return { wire, sizes };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'tomlin-videolink-'));

test('a clip made on the linked PC arrives here whole, in pieces, and is deleted there once fetched', { timeout: 60_000 }, async () => {
  const there = tmp();
  const here = tmp();
  const runner = fakeRunner(there);
  const peer = await farPc(runner);
  try {
    const { wire, sizes } = counting(sealedWire(peer.pc));
    const r = new RemoteVideoRunner({ pc: 'Z820', wire, dir: here });
    assert.equal(await r.installed(), true);
    const seen: VideoProgress[] = [];
    const clip = await r.make(JOB, p => seen.push(p), new AbortController().signal);
    assert.equal(runner.calls, 1);
    assert.deepEqual(seen.map(p => p.stage), ['loading', 'making']);
    assert.equal(clip.mime, 'video/mp4');
    assert.equal(clip.bytes, runner.bytes!.length);
    assert.equal(clip.seconds, 3);
    assert.equal(clip.model, 'wan-small');
    assert.ok(clip.file.startsWith(here) && clip.file.endsWith('.mp4'));
    assert.ok(readFileSync(clip.file).equals(runner.bytes!));
    // Never whole in memory: each piece is VIDEO_PIECE at most.
    assert.equal(sizes.length, Math.ceil(runner.bytes!.length / VIDEO_PIECE));
    assert.ok(sizes.every(s => s <= VIDEO_PIECE));
    assert.deepEqual(readdirSync(here).filter(f => f.endsWith('.part')), []);
    // Fetched: dropped there (the file is removed by the far PC).
    await new Promise(res => setTimeout(res, 100));
    assert.deepEqual(peer.removed, [runner.file]);
  } finally {
    await peer.close();
    rmSync(there, { recursive: true, force: true });
    rmSync(here, { recursive: true, force: true });
  }
});

test('"I need to use the pc" and the owner\'s lock on the linked PC stop new clips, in plain words', { timeout: 30_000 }, async () => {
  const there = tmp();
  const runner = fakeRunner(there);
  const peer = await farPc(runner);
  try {
    const r = new RemoteVideoRunner({ pc: 'Z820', wire: sealedWire(peer.pc), dir: there });
    peer.here.away = { since: new Date().toISOString() };
    await assert.rejects(r.make(JOB, () => undefined, new AbortController().signal), (e: VideoFault) => {
      assert.equal(e.kind, 'busy');
      assert.match(e.message, /"Z820" is being used by its owner .*I need to use the pc.*no new clips/);
      return true;
    });
    peer.here.away = null;
    peer.here.busy = 'it is drawing a picture';
    await assert.rejects(r.make(JOB, () => undefined, new AbortController().signal), (e: VideoFault) => e.kind === 'busy' && /drawing a picture/.test(e.message));
    assert.equal(runner.calls, 0);
  } finally {
    await peer.close();
    rmSync(there, { recursive: true, force: true });
  }
});

test('one clip at a time there: a second is told busy while the first is made', { timeout: 30_000 }, async () => {
  const there = tmp();
  const runner = fakeRunner(there, { hold: true });
  const peer = await farPc(runner);
  try {
    const r = new RemoteVideoRunner({ pc: 'Z820', wire: sealedWire(peer.pc), dir: there });
    const ac = new AbortController();
    let started!: () => void;
    const making = new Promise<void>(res => (started = res));
    const first = r.make(JOB, p => p.stage === 'making' && started(), ac.signal);
    await making;
    assert.ok(peer.node.working());
    await assert.rejects(r.make(JOB, () => undefined, new AbortController().signal), (e: VideoFault) => e.kind === 'busy' && /already making a clip/.test(e.message));
    ac.abort();
    await assert.rejects(first, (e: VideoFault) => e.kind === 'stopped');
  } finally {
    await peer.close();
    rmSync(there, { recursive: true, force: true });
  }
});

test('Stop here stops the clip there', { timeout: 30_000 }, async () => {
  const there = tmp();
  const runner = fakeRunner(there, { hold: true });
  const peer = await farPc(runner);
  try {
    const r = new RemoteVideoRunner({ pc: 'Z820', wire: sealedWire(peer.pc), dir: there });
    const ac = new AbortController();
    const made = r.make(JOB, p => p.stage === 'making' && ac.abort(), ac.signal);
    await assert.rejects(made, (e: VideoFault) => e.kind === 'stopped' && e.message === 'Stopped.');
    for (let i = 0; i < 50 && !runner.sawAbort; i++) await new Promise(res => setTimeout(res, 20));
    assert.equal(runner.sawAbort, true);
    for (let i = 0; i < 50 && peer.node.working(); i++) await new Promise(res => setTimeout(res, 20));
    assert.equal(peer.node.working(), null);
  } finally {
    await peer.close();
    rmSync(there, { recursive: true, force: true });
  }
});

test('a linked PC that is off says so, with what the chat needs to offer the backup choices', { timeout: 30_000 }, async () => {
  const keys = randomBytes(64);
  // Nothing listens on the port: the PC is off.
  const pc = { name: 'Z820', url: `http://127.0.0.1:${PORT}`, token: randomBytes(32).toString('hex'), key: link.keysText(keys) };
  const r = new RemoteVideoRunner({ pc: 'Z820', wire: sealedWire(pc), dir: tmpdir(), hire: { id: 'staff-ava', first: 'Ava' } });
  assert.equal(await r.installed(), false);
  await assert.rejects(r.make(JOB, () => undefined, new AbortController().signal), (e: VideoFault & { reasons?: string[]; backup?: string; off?: boolean }) => {
    assert.equal(e.kind, 'pc-off');
    assert.match(e.message, /^Ava cannot make the clip now: "Z820" is off or not answering\. Pick a backup for Ava in their chat, or move Ava to another PC\.$/);
    assert.equal(e.backup, 'staff-ava');
    assert.equal(e.off, true);
    // The chat's own test for "the PC is off" (src/server/chat.ts) matches these reasons.
    assert.ok(e.reasons!.some(x => /is off|not answering|log off|using it/.test(x)));
    return true;
  });
});

test('a stream cut part way is followed again by its id: the clip is made once and still arrives', { timeout: 60_000 }, async () => {
  const there = tmp();
  const here = tmp();
  const runner = fakeRunner(there, { size: 300_000, between: 200 });
  const peer = await farPc(runner);
  try {
    peer.cutNextStream = true;
    const r = new RemoteVideoRunner({ pc: 'Z820', wire: sealedWire(peer.pc), dir: here, pollMs: 50 });
    const clip = await r.make(JOB, () => undefined, new AbortController().signal);
    assert.equal(runner.calls, 1);
    assert.ok(readFileSync(clip.file).equals(runner.bytes!));
  } finally {
    await peer.close();
    rmSync(there, { recursive: true, force: true });
    rmSync(here, { recursive: true, force: true });
  }
});

test('a take cut by a restart here is asked for by its kept link id: the linked PC hands it over, never makes it twice', { timeout: 60_000 }, async () => {
  const there = tmp();
  const here = tmp();
  const runner = fakeRunner(there, { size: 300_000, between: 300 });
  const peer = await farPc(runner);
  try {
    const linkId = randomBytes(16).toString('hex');
    // The copy here that asked first went away mid-clip (TOMLIN restarted): its request was sent and then dropped.
    const gone = new AbortController();
    const first = sealedWire(peer.pc).stream(VIDEO_MAKE, { cid: linkId, job: JOB }, gone.signal).catch(() => null);
    await new Promise(r => setTimeout(r, 100));
    gone.abort();
    await first;
    // The new copy asks again under the same id: it follows that clip, which is made once and arrives here.
    const r = new RemoteVideoRunner({ pc: 'Z820', wire: sealedWire(peer.pc), dir: here, pollMs: 50 });
    const clip = await r.make({ ...JOB, linkId }, () => undefined, new AbortController().signal);
    assert.equal(runner.calls, 1);
    assert.ok(readFileSync(clip.file).equals(runner.bytes!));
    // A new id makes a new clip; a malformed one is not used (a new id is made instead).
    await r.make({ ...JOB, linkId: 'not-an-id' }, () => undefined, new AbortController().signal);
    assert.equal(runner.calls, 2);
  } finally {
    await peer.close();
    rmSync(there, { recursive: true, force: true });
    rmSync(here, { recursive: true, force: true });
  }
});

test('a clip changed on the way is not kept, and leaves no part file', { timeout: 60_000 }, async () => {
  const there = tmp();
  const here = tmp();
  const peer = await farPc(fakeRunner(there));
  try {
    const { wire } = counting(sealedWire(peer.pc), { flip: true });
    const r = new RemoteVideoRunner({ pc: 'Z820', wire, dir: here });
    await assert.rejects(r.make(JOB, () => undefined, new AbortController().signal), (e: VideoFault) => e.kind === 'crashed' && /changed on the way/.test(e.message));
    assert.deepEqual(readdirSync(here), []);
  } finally {
    await peer.close();
    rmSync(there, { recursive: true, force: true });
    rmSync(here, { recursive: true, force: true });
  }
});

test('the runner\'s own fault there comes back as the same kind and words; no runner there is not-installed', { timeout: 30_000 }, async () => {
  const there = tmp();
  const peer = await farPc(fakeRunner(there, { fault: new VideoFault('out-of-memory', 'The graphics card on "Z820" ran out of memory. Pick a smaller size.') }));
  try {
    const r = new RemoteVideoRunner({ pc: 'Z820', wire: sealedWire(peer.pc), dir: there });
    await assert.rejects(r.make(JOB, () => undefined, new AbortController().signal), (e: VideoFault) => e.kind === 'out-of-memory' && e.message === 'The graphics card on "Z820" ran out of memory. Pick a smaller size.');
    peer.node.setRunner(null);
    assert.equal(await r.installed(), false);
    await assert.rejects(r.make(JOB, () => undefined, new AbortController().signal), (e: VideoFault) => e.kind === 'not-installed' && /no video runner installed/.test(e.message));
  } finally {
    await peer.close();
    rmSync(there, { recursive: true, force: true });
  }
});

test('each link sees only its own clips, and a clip not fetched in time is deleted there', async () => {
  const there = tmp();
  let now = 1_000_000;
  const runner = fakeRunner(there, { size: 5000, between: 1 });
  const removed: string[] = [];
  const node = new VideoNode({ name: () => 'Z820', away: () => null, busy: () => null }, { remove: async f => void removed.push(f), now: () => now });
  node.setRunner(runner);
  const answers: { status: number; value: Record<string, unknown> }[] = [];
  const events: string[] = [];
  const out: VideoOut = {
    json: (status, value) => void answers.push({ status, value: value as Record<string, unknown> }),
    stream: () => ({ send: e => void events.push(e), end: () => undefined }),
    piece: () => assert.fail('no piece should be given'),
  };
  try {
    const cid = randomBytes(16).toString('hex');
    await node.handle(VIDEO_MAKE, { cid, job: JOB }, { key: 'host-a', name: 'A' }, out);
    assert.deepEqual(events, ['progress', 'progress', 'clip']);
    await node.handle(VIDEO_GET, { cid, at: 0 }, { key: 'host-b', name: 'B' }, out);
    assert.equal(answers.at(-1)!.status, 404);
    now += KEEP_MS + 1;
    await node.handle('/worker/video-state', { cid }, { key: 'host-a', name: 'A' }, out);
    assert.equal(answers.at(-1)!.status, 404);
    assert.deepEqual(removed, [runner.file]);
  } finally {
    rmSync(there, { recursive: true, force: true });
  }
});

test('guests and direct peers are never let through the clip doors', () => {
  for (const door of VIDEO_DOORS) {
    assert.ok(!GUEST_DOORS.includes(door), door);
    assert.ok(!Object.values(PEER_DOORS).flat().includes(door), door);
  }
});

test('a job from the link is cleaned as the picture door cleans a prompt, and refused when out of range', () => {
  const j = cleanJob({ ...JOB, prompt: '  a​ red   kite‮\n over a hill ' });
  assert.ok(!('error' in j));
  assert.equal((j as VideoJob).prompt, 'a red kite over a hill');
  // A prompt longer than the link takes is refused with a reason, never cut.
  assert.equal((cleanJob({ ...JOB, prompt: 'x'.repeat(2000) }) as VideoJob).prompt.length, 2000);
  assert.match((cleanJob({ ...JOB, prompt: 'x'.repeat(5000) }) as { error: string }).error, /5,000 characters .*2,000 at most/);
  assert.ok('error' in cleanJob({ ...JOB, seconds: 6 }));
  assert.ok('error' in cleanJob({ ...JOB, prompt: '​ ' }));
  assert.ok('error' in cleanJob({ ...JOB, quality: 'ultra' }));
  assert.ok('error' in cleanJob({ ...JOB, width: 10 }));
  assert.ok('error' in cleanJob({ ...JOB, model: '' }));
});

// ---- A start picture (image to video) goes with the job ----

/** PNG-shaped bytes: PNG's signature, then `size` bytes in all (only the signature is checked on the link). */
const fakePng = (size = 40_000) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(size - 8)]);

test('a start picture goes with the job inside the sealed request, reaches the runner there as a file, and is removed after', { timeout: 60_000 }, async () => {
  const there = tmp();
  const here = tmp();
  const base = fakeRunner(there, { size: 5000, between: 1 });
  const got: { path?: string; bytes?: Buffer; keys?: string[] } = {};
  const runner: VideoRunner = {
    installed: async () => true,
    async make(job, onProgress, signal) {
      got.path = job.startPicture;
      got.bytes = job.startPicture ? readFileSync(job.startPicture) : undefined;
      got.keys = Object.keys(job).sort();
      return base.make(job, onProgress, signal);
    },
  };
  const peer = await farPc(runner);
  try {
    const start = join(here, 'start.png');
    const pic = fakePng();
    writeFileSync(start, pic);
    const r = new RemoteVideoRunner({ pc: 'Z820', wire: sealedWire(peer.pc), dir: here });
    const clip = await r.make({ ...JOB, model: 'wan22-ti2v-5b-q8', startPicture: start }, () => undefined, new AbortController().signal);
    assert.ok(clip.bytes > 0);
    // There, it is a file of its own (never this PC's path), with the same bytes, and the base64 is not left in the job.
    assert.ok(got.path && got.path !== start && got.path.startsWith(join(tmpdir(), 'tomlin-clip-starts')));
    assert.ok(got.bytes!.equals(pic));
    assert.ok(!got.keys!.includes('start'));
    assert.equal(existsSync(got.path!), false, 'removed there once the clip ended');
    // Here, the picture is left for the queue to remove.
    assert.equal(existsSync(start), true);
  } finally {
    await peer.close();
    rmSync(there, { recursive: true, force: true });
    rmSync(here, { recursive: true, force: true });
  }
});

test('a start picture that is not a PNG, too big or missing is refused before anything is sent', { timeout: 30_000 }, async () => {
  const here = tmp();
  let sent = 0;
  const wire: VideoWire = {
    stream: async () => { sent++; throw new Error('should not be sent'); },
    ask: async () => { sent++; return { status: 200, body: {} }; },
    getPiece: async () => { sent++; return Buffer.alloc(0); },
  };
  try {
    const r = new RemoteVideoRunner({ pc: 'Z820', wire, dir: here });
    const bad = join(here, 'bad.png');
    writeFileSync(bad, Buffer.from('GIF89a, not a PNG'));
    const big = join(here, 'big.png');
    writeFileSync(big, fakePng(MAX_START_BYTES + 1));
    for (const startPicture of [bad, big, join(here, 'gone.png')]) {
      await assert.rejects(r.make({ ...JOB, startPicture }, () => undefined, new AbortController().signal), (e: VideoFault) => e.kind === 'crashed' && /start picture could not be sent to "Z820"/.test(e.message));
    }
    assert.equal(sent, 0);
  } finally {
    rmSync(here, { recursive: true, force: true });
  }
});

test('the linked PC checks the start picture itself: a PNG of MAX_START_BYTES or less, or the clip is refused', async () => {
  const there = tmp();
  const runner = fakeRunner(there, { size: 5000, between: 1 });
  const node = new VideoNode({ name: () => 'Z820', away: () => null, busy: () => null }, { startDir: there });
  node.setRunner(runner);
  const answers: { status: number; value: Record<string, unknown> }[] = [];
  const out: VideoOut = {
    json: (status, value) => void answers.push({ status, value: value as Record<string, unknown> }),
    stream: () => ({ send: () => undefined, end: () => undefined }),
    piece: () => assert.fail('no piece should be given'),
  };
  try {
    for (const start of [Buffer.from('not a png').toString('base64'), fakePng(MAX_START_BYTES + 9).toString('base64'), '<<not base64>>', 42]) {
      await node.handle(VIDEO_MAKE, { cid: randomBytes(16).toString('hex'), job: { ...JOB, start } }, { key: 'host-a', name: 'A' }, out);
      assert.equal(answers.at(-1)!.status, 400);
      assert.match(String(answers.at(-1)!.value.error), /start picture is not a PNG/);
    }
    assert.equal(runner.calls, 0);
    assert.equal(cleanStart({ ...JOB }), null);
    assert.ok((cleanStart({ ...JOB, start: fakePng(100).toString('base64') }) as Buffer).length === 100);
    // The make door's body limit takes the largest start picture, sealed.
    const sealed = JSON.stringify(link.sealRequest(randomBytes(64), VIDEO_MAKE, { cid: 'x'.repeat(32), job: { ...JOB, start: fakePng(MAX_START_BYTES).toString('base64') } }));
    assert.ok(sealed.length <= VIDEO_MAKE_BODY, `${sealed.length} <= ${VIDEO_MAKE_BODY}`);
    assert.match(readFileSync(join(import.meta.dirname, '..', 'src', 'jobrun', 'node.ts'), 'utf8'), /p === VIDEO_MAKE \? VIDEO_MAKE_BODY/);
  } finally {
    rmSync(there, { recursive: true, force: true });
  }
});
