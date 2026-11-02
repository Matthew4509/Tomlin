// Cancel while a picture is being asked for, drawn or sharpened, against a made-up runner that holds its answers back:
// the picture stays cancelled, nothing late brings it back, and the app is free at once. Also what a failure on a card
// leads to: only words of running out of memory move the picture to RAM or the CPU. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Images } from '../src/images.ts';
import { Store } from '../src/store.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const PNG = (await sharp({ create: { width: 512, height: 512, channels: 3, background: '#336699' } }).png().toBuffer()).toString('base64');

type Route = 'img_gen' | 'jobs' | 'upscale';
/** The made-up runner cuts the connection instead of answering. */
const DROP = Symbol('drop');
/**
 * What the made-up runner does with each kind of request: answer now, (null) hold it back until released, (DROP) cut
 * the connection, or a function of how many times that kind was asked before that says which.
 */
type Answers = Partial<Record<Route, unknown | null>>;

async function withRunner(answers: Answers, fn: (r: {
  im: any; held: Record<Route, ServerResponse[]>; closed: () => number; seen: Route[]; release: (route: Route, answer: unknown) => void; heldYet: (route: Route) => Promise<void>;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-imagecancel-'));
  mkdirSync(join(dir, 'registry'));
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'registry', 'fake.json'), JSON.stringify({ id: 'fake', kind: 'image', name: 'Fake', about: '', licence: '', quant: '', minRamGB: 0, minVramGB: 0, native: 512, files: [{ role: 'model', path: 'fake.gguf', bytes: 1, sha256: 'x' }], defaults: { steps: 4, cfg: 1, sampler: 'euler_a', scheduler: '', negative: '' } }));
  const held: Record<Route, ServerResponse[]> = { img_gen: [], jobs: [], upscale: [] };
  const seen: Route[] = [];
  let closed = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const route: Route = req.url!.includes('img_gen') ? 'img_gen' : req.url!.includes('upscale') ? 'upscale' : 'jobs';
    const before = seen.filter(s => s === route).length;
    seen.push(route);
    req.resume();
    const given = answers[route];
    const answer = typeof given === 'function' ? given(before) : given;
    if (answer === DROP) return void req.socket.destroy();
    if (answer === null) {
      held[route].push(res);
      res.on('close', () => {
        held[route] = held[route].filter(r => r !== res);
        if (!res.writableEnded) closed++;
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const im: any = new Images({ root: dir, models: join(dir, 'models'), data: join(dir, 'data'), store: new Store(join(dir, 'data')), runtimes: {}, hardware: { gpus: [], ram: 8 * 2 ** 30 }, sampler: {}, chatPane: { view: { state: 'disconnected' } }, devicesFor: () => ['cpu'], fit: () => ({ level: 'ok', need: 1, free: 1e10, otherOn: false }) } as any);
  Object.assign(im.pane.view, { state: 'connected', model: 'fake', device: 'cpu', asked: 'cpu' });
  Object.defineProperty(im.pane.worker, 'base', { get: () => base, configurable: true });
  im.decoder = 'full';
  try {
    await fn({
      im, held, seen, closed: () => closed,
      release: (route, answer) => held[route].shift()?.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer)),
      heldYet: async route => {
        for (let i = 0; i < 100 && !held[route].length; i++) await sleep(50);
        assert.ok(held[route].length, `the runner was asked (${route})`);
      },
    });
  } finally {
    for (const list of Object.values(held)) for (const res of list) res.destroy();
    server.closeAllConnections();
    await new Promise(ok => server.close(ok));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Whether the job's `done` settles within a second, with the runner still holding its answer. */
const settles = async (job: { done: Promise<void> }) => {
  let settled = false;
  void job.done.then(() => { settled = true; });
  for (let i = 0; i < 20 && !settled; i++) await sleep(50);
  return settled;
};

const ask = (im: any, extra: object = {}) => im.generate({ prompt: 'a red boat on a lake', source: 'api', full: true, ...extra });
const completed = { status: 'completed', result: { images: [{ b64_json: PNG }] } };

test('Cancel while the picture is being asked for: it stops at once and stays cancelled', { timeout: 20_000 }, async () => {
  await withRunner({ img_gen: null, jobs: { status: 'failed', error: { message: 'made up' } } }, async ({ im, heldYet, closed, seen }) => {
    const job = await ask(im);
    await heldYet('img_gen');
    await im.cancel(job.id, { restart: false });
    assert.ok(await settles(job), 'done settles with the request still unanswered');
    assert.equal(job.state, 'cancelled');
    assert.equal(job.error, null);
    assert.equal(im.busy(), false);
    await sleep(100);
    assert.equal(closed(), 1, 'the request itself was ended');
    assert.ok(!seen.includes('jobs'), 'nothing is asked after it');
  });
});

test('Cancel while waiting on a silent runner: the app is free at once', { timeout: 20_000 }, async () => {
  await withRunner({ img_gen: { id: 'one' }, jobs: null }, async ({ im, heldYet, closed }) => {
    const job = await ask(im);
    await heldYet('jobs');
    assert.equal(job.state, 'drawing');
    await im.cancel(job.id, { restart: false });
    assert.ok(await settles(job), 'done settles with the look still unanswered');
    assert.equal(job.state, 'cancelled');
    assert.equal(im.busy(), false);
    await sleep(100);
    assert.equal(closed(), 1, 'the request itself was ended');
  });
});

test('the Cancel button (which loads the model again) ends a held request the same way', { timeout: 20_000 }, async () => {
  await withRunner({ img_gen: { id: 'one' }, jobs: null }, async ({ im, heldYet }) => {
    let restarts = 0;
    im.restart = async () => { restarts++; return true; };
    const job = await ask(im);
    await heldYet('jobs');
    assert.deepEqual(await im.cancel(), { restarted: true });
    assert.ok(await settles(job));
    assert.equal(job.state, 'cancelled');
    assert.equal(restarts, 1);
    assert.match(job.note, /Cancelled/);
  });
});

test('an answer that arrives as Cancel is pressed never saves a picture or changes the state', { timeout: 20_000 }, async () => {
  for (const [what, late] of Object.entries({ completed, failed: { status: 'failed', error: { message: 'made up' } }, unknown: {} })) {
    await withRunner({ img_gen: { id: 'one' }, jobs: null }, async ({ im, heldYet, release }) => {
      const job = await ask(im);
      await heldYet('jobs');
      // Both in one breath: the answer is on its way when Cancel lands.
      release('jobs', late);
      await im.cancel(job.id, { restart: false });
      await job.done;
      assert.equal(job.state, 'cancelled', what);
      assert.equal(job.error, null, what);
      assert.equal(job.results.length, 0, what);
      assert.equal((await im.gallery.list()).total, 0, what);
    });
  }
});

test('Cancel while a picture is being sharpened: the long request ends too, and no picture is saved', { timeout: 20_000 }, async () => {
  await withRunner({ img_gen: { id: 'one' }, jobs: completed, upscale: null }, async ({ im, heldYet, closed }) => {
    im.upscaler = () => ({ path: 'x', name: 'made-up-sharpener' });
    im.upscalerReady = () => true;
    const job = await ask(im, { quality: 'high', full: false });
    await heldYet('upscale');
    await im.cancel(job.id, { restart: false });
    assert.ok(await settles(job), 'done settles with the sharpener still unanswered');
    assert.equal(job.state, 'cancelled');
    assert.equal(job.error, null);
    assert.match(job.note, /Cancelled/, 'it says cancelled, not that the sharpener failed');
    assert.deepEqual(job.results, []);
    assert.equal(im.busy(), false);
    await sleep(100);
    assert.equal(closed(), 1, 'the request itself was ended');
  });
});

test('Cancel during the move to the CPU after running out of memory: the redraw does not start', { timeout: 20_000 }, async () => {
  await withRunner({ img_gen: { id: 'one' }, jobs: { status: 'failed', error: { message: 'out of memory' } } }, async ({ im, seen }) => {
    Object.assign(im.pane.view, { device: 'vulkan', asked: 'auto' });
    let moved!: (ok: boolean) => void;
    im.restart = () => new Promise<boolean>(ok => { moved = ok; });
    const job = await ask(im);
    for (let i = 0; i < 100 && !moved; i++) await sleep(50);
    assert.ok(moved, 'the move began');
    await im.cancel(job.id, { restart: false });
    moved(true);
    await job.done;
    assert.equal(job.state, 'cancelled');
    assert.equal(seen.filter(r => r === 'img_gen').length, 1, 'not asked a second time');
  });
});

test('after a Cancel the next picture draws as normal', { timeout: 20_000 }, async () => {
  await withRunner({ img_gen: { id: 'one' }, jobs: null }, async ({ im, heldYet, release, closed }) => {
    const first = await ask(im);
    await heldYet('jobs');
    await im.cancel(first.id, { restart: false });
    await first.done;
    // The made-up runner notices the ended request a moment later.
    for (let i = 0; i < 100 && closed() < 1; i++) await sleep(20);
    const next = await ask(im);
    await heldYet('jobs');
    release('jobs', completed);
    await next.done;
    assert.equal(next.state, 'done', next.error ?? '');
    assert.equal(next.results.length, 1);
  });
});

test('a picture that is not cancelled still fails plainly when the runner goes away', { timeout: 20_000 }, async () => {
  await withRunner({ img_gen: { id: 'one' }, jobs: null }, async ({ im, heldYet, held }) => {
    const job = await ask(im);
    await heldYet('jobs');
    held.jobs[0].destroy();
    await job.done;
    assert.equal(job.state, 'failed');
    assert.match(job.error, /stopped while drawing/);
  });
});

test('a deleted or private picture cannot be drawn again or finalised: nothing is sent to the runner', { timeout: 20_000 }, async () => {
  await withRunner({ img_gen: { id: 'one' }, jobs: completed }, async ({ im, seen }) => {
    const base = { at: new Date().toISOString(), prompt: 'a red boat', modelPrompt: 'a red boat', negative: '', kept: false, original: '2026-10/x.png', output: '2026-10/x.png', generated: { width: 512, height: 512 }, target: { width: 512, height: 512 }, mode: 'custom', steps: 4, seed: 1, cfg: 1, sampler: 'euler_a', fit: 'crop' };
    await im.gallery.add({ ...base, id: 'deleted', removed: true });
    await im.gallery.add({ ...base, id: 'hidden', private: true });
    await im.gallery.add({ ...base, id: 'fine' });
    for (const id of ['deleted', 'hidden', 'not-there']) {
      for (const how of ['again', 'finalOf']) {
        const r = await im.generate({ prompt: '', source: 'page', [how]: id });
        assert.equal(r.status, 404, `${how} ${id}`);
        assert.match(r.error, /not in the gallery/);
      }
    }
    assert.deepEqual(seen, []);
    const ok = await im.generate({ prompt: '', source: 'page', again: 'fine' });
    assert.ok(ok.id, 'a picture still there draws again');
    await ok.done;
  });
});

// ---- A failure on a card: only words of running out of memory move the picture to RAM or the CPU ----

/** Lines every sd.cpp runner writes as it loads a model on a card: "memory" and "alloc" in them say nothing. */
const LOADING = [
  '[INFO ] stable-diffusion.cpp:592 - total params memory size = 2135.66MB (VRAM 2135.66MB, RAM 0.00MB)',
  '[DEBUG] ggml_extend.hpp:1201 - vae compute buffer size: 1664.00 MB(VRAM), allocating',
  '[INFO ] image.cpp:899  - sampling completed, taking 11.84s',
];

/** The made-up runner as a card's: Auto, on CUDA, its process `pid` (null: it has stopped), these last lines. */
function onCard(im: any, lines: string[], pid: () => number | null = () => 4242): string[] {
  Object.assign(im.pane.view, { device: 'cuda', asked: 'auto' });
  Object.defineProperty(im.pane.worker, 'pid', { get: pid, configurable: true });
  im.pane.worker.log = lines;
  const why: string[] = [];
  im.fallBack = async (_job: unknown, _plan: unknown, _m: unknown, w: string) => void why.push(w);
  return why;
}

test('On a card, a picture that fails with no word of running out of memory is not drawn again on the CPU', { timeout: 20_000 }, async () => {
  await withRunner({ img_gen: { id: 'one' }, jobs: { status: 'failed', error: { message: 'made up' } } }, async ({ im }) => {
    const fellBack = onCard(im, LOADING);
    const job = await ask(im);
    await job.done;
    assert.deepEqual(fellBack, [], 'the loading lines alone are no reason to move it');
    assert.equal(job.state, 'failed');
    assert.match(job.error, /made up/);
  });
});

test('On a card, running out of memory still moves the picture, and says which line said so', { timeout: 20_000 }, async () => {
  for (const [message, line] of [['made up', 'CUDA error: out of memory'], ['generate_image returned no results', '']]) {
    await withRunner({ img_gen: { id: 'one' }, jobs: { status: 'failed', error: { message } } }, async ({ im }) => {
      const fellBack = onCard(im, line ? [...LOADING, line] : LOADING);
      await (await ask(im)).done;
      assert.equal(fellBack.length, 1, `moved for "${message}"`);
      assert.equal(fellBack[0].split('\n')[0], line || message);
    });
  }
});

test('On a card, a look at the runner that is cut while the runner still runs is tried again, not drawn again on the CPU', { timeout: 20_000 }, async () => {
  await withRunner({ img_gen: { id: 'one' }, jobs: (n: number) => (n === 0 ? DROP : completed) }, async ({ im }) => {
    const fellBack = onCard(im, LOADING);
    const job = await ask(im);
    await job.done;
    assert.deepEqual(fellBack, []);
    assert.equal(job.state, 'done');
  });
});

test('On a card, a runner that stopped with no word of memory fails in plain words, not drawn again on the CPU', { timeout: 20_000 }, async () => {
  await withRunner({ img_gen: { id: 'one' }, jobs: DROP }, async ({ im }) => {
    const fellBack = onCard(im, LOADING, () => null);
    const job = await ask(im);
    await job.done;
    assert.deepEqual(fellBack, []);
    assert.equal(job.state, 'failed');
    assert.match(job.error, /stopped while drawing/);
  });
});
