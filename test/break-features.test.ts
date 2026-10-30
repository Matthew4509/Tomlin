// Faults found by trying to break the picture queue, the To Do, staff and work projects, each shown to fail before its
// fix. Stand-ins only: a made-up image runner on a free port, no real runner or model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Images } from '../src/images.ts';
import { Store } from '../src/store.ts';
import { Worker } from '../src/worker.ts';
import { slug } from '../src/modes.ts';
import * as T from '../src/todo.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 120, g: 130, b: 140 } } }).png().toBuffer();
const picture = { status: 'completed', result: { images: [{ b64_json: png.toString('base64') }] } };

/** A made-up picture runner: every request is taken as a job, and each look at a job gets what `look` says. */
async function madeUpRunner(look: (res: ServerResponse) => void = res => res.end(JSON.stringify(picture))) {
  const asked: Record<string, unknown>[] = [];
  const server = httpServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST') {
        asked.push(JSON.parse(body) as Record<string, unknown>);
        return void res.end(JSON.stringify({ id: `job${asked.length}` }));
      }
      look(res);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, asked, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}

/** The image pane with one made-up model, "connected" to `base`. */
function rig(dir: string, base: string, store = new Store(join(dir, 'data'))) {
  mkdirSync(join(dir, 'registry'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'registry', 'made-up.json'), JSON.stringify({ id: 'made-up', kind: 'image', name: 'Made Up', about: '', licence: '', quant: '', minRamGB: 0, minVramGB: 0, native: 512,
    files: [{ role: 'model', path: 'made-up.gguf', bytes: 1, sha256: 'x' }, { role: 'taesd', path: 'taesd.gguf', bytes: 1, sha256: 'x' }], defaults: { steps: 4, cfg: 1, sampler: 'euler_a', scheduler: '', negative: '' } }));
  const images = new Images({
    root: dir, models: join(dir, 'models'), data: join(dir, 'data'), store, runtimes: {} as never, hardware: { gpus: [], ram: 8 * 2 ** 30 } as never, sampler: {} as never,
    chatPane: { view: { state: 'disconnected' } } as never, devicesFor: () => ['cpu'], fit: () => ({ level: 'ok', need: 0, free: 0, otherOn: false }),
  });
  const w = images.pane.worker;
  w.view = { ...Worker.empty('auto', 0), state: 'connected', model: 'made-up', modelName: 'Made Up', device: 'cpu' };
  Object.defineProperty(w, 'base', { get: () => base, configurable: true });
  // Mid is drawn with the full decoder: already so, unless a test wants a reload.
  (images as unknown as { decoder: string }).decoder = 'full';
  return images;
}

async function inTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sm-bf-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

type Started = { id: string; state: string; error: string | null; target: { width: number; height: number }; generated: { width: number; height: number }; done: Promise<void>; results: unknown[] };
const started = (r: unknown): Started => {
  assert.ok(r && typeof r === 'object' && 'id' in r, `no job started: ${JSON.stringify(r)}`);
  return r as Started;
};

test('a prompt that is only a size or only where the picture goes is refused, and nothing is drawn', async () => {
  await inTemp(async dir => {
    const runner = await madeUpRunner();
    try {
      const images = rig(dir, runner.base);
      for (const prompt of ['512x512', '600 x 400 px', 'for a blog post', '128px']) {
        const r = await images.generate({ prompt, source: 'page' }) as { status?: number; error?: string };
        assert.equal(r.status, 400, `${prompt}: ${JSON.stringify(r)}`);
        assert.match(String(r.error), /what should the picture show/i);
      }
      assert.equal(runner.asked.length, 0);
    } finally {
      await runner.close();
    }
  });
});

test('a width or height of 0, below zero or far too big draws at a size that works, and the picture comes out', async () => {
  await inTemp(async dir => {
    const runner = await madeUpRunner();
    try {
      const images = rig(dir, runner.base);
      for (const [width, height] of [[-5, 100], [100_000, 100_000], [1, 4000], [0.4, 0.4], [512, -512]]) {
        const job = started(await images.generate({ prompt: 'a red bicycle', width, height, source: 'api' }));
        await job.done;
        assert.equal(job.state, 'done', `${width} x ${height}: ${job.error}`);
        assert.ok(job.target.width >= 16 && job.target.width <= 4096 && job.target.height >= 16 && job.target.height <= 4096, `${width} x ${height}: target ${JSON.stringify(job.target)}`);
        const sent = runner.asked.at(-1)!;
        assert.ok(Number.isFinite(sent.width) && Number.isFinite(sent.height), `${width} x ${height}: the runner was asked for ${sent.width} x ${sent.height}`);
      }
      // The hint under the prompt box says the same.
      const said: { target?: unknown }[] = [];
      const res = { writeHead: () => res, end: (s: string) => said.push(JSON.parse(s) as { target?: unknown }) } as unknown as ServerResponse;
      await images.get({} as IncomingMessage, res, new URL('http://x/api/images/plan?prompt=a%20cat&width=100000&height=100000'));
      assert.equal(said[0].target, null);
    } finally {
      await runner.close();
    }
  });
});

test('a very long prompt with no spaces (a pasted address) still saves its picture', async () => {
  await inTemp(async dir => {
    const runner = await madeUpRunner();
    try {
      assert.ok(slug('x'.repeat(2000)).length <= 80);
      assert.ok(slug(`${'word'.repeat(60)} ${'other'.repeat(60)} third`).length <= 80);
      assert.doesNotMatch(slug(`${'a'.repeat(59)} ${'c'.repeat(100)}`), /-$/);
      const images = rig(dir, runner.base);
      const job = started(await images.generate({ prompt: `a sign reading ${'x'.repeat(1900)}`, source: 'page' }));
      await job.done;
      assert.equal(job.state, 'done', String(job.error));
      assert.equal(job.results.length, 1);
    } finally {
      await runner.close();
    }
  });
});

test('a runner that no longer knows the job (started again meanwhile) fails the picture: it does not wait for ever', async () => {
  await inTemp(async dir => {
    const runner = await madeUpRunner(res => {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'no such job' } }));
    });
    try {
      const images = rig(dir, runner.base);
      const job = started(await images.generate({ prompt: 'a red bicycle', source: 'page' }));
      const ended = await Promise.race([job.done.then(() => true), sleep(4000).then(() => false)]);
      assert.equal(ended, true, `still ${job.state} after 4 s`);
      assert.equal(job.state, 'failed');
      assert.equal(images.busy(), false);
    } finally {
      await runner.close();
    }
  });
});

test('a runner that sends back an empty or broken picture is a failed picture, with nothing in the gallery', async () => {
  for (const b64 of ['', Buffer.from('this is not a picture').toString('base64')]) {
    await inTemp(async dir => {
      const runner = await madeUpRunner(res => res.end(JSON.stringify({ status: 'completed', result: { images: [{ b64_json: b64 }] } })));
      try {
        const images = rig(dir, runner.base);
        const job = started(await images.generate({ prompt: 'a red bicycle', source: 'page' }));
        await job.done;
        assert.equal(job.state, 'failed', `said ${job.state} for a picture of ${b64.length} characters`);
        assert.equal((await images.gallery.all()).length, 0);
      } finally {
        await runner.close();
      }
    });
  }
});

test('Cancel stays cancelled when the runner\'s last progress line comes after it (it is never drawn again)', async () => {
  await inTemp(async dir => {
    const runner = await madeUpRunner(res => res.end(JSON.stringify({ status: 'generating' })));
    try {
      const images = rig(dir, runner.base);
      const job = started(await images.generate({ prompt: 'a red bicycle', source: 'page' }));
      while (job.state !== 'drawing') await sleep(50);
      await images.cancel(undefined, { restart: false });
      images.pane.worker.onLine?.('  |=====>   | 2/4 - 1.20s/it');
      images.pane.worker.onLine?.('generating image: 1/1');
      assert.equal(job.state, 'cancelled');
      await job.done;
      assert.equal(job.state, 'cancelled');
      assert.equal(images.busy(), false);
    } finally {
      await runner.close();
    }
  });
});

test('a fault while starting a picture (the settings cannot be saved) fails that picture: it does not spin for ever', async () => {
  await inTemp(async dir => {
    const runner = await madeUpRunner();
    const store = new Store(join(dir, 'data'));
    try {
      const images = rig(dir, runner.base, store);
      // The next picture needs the other decoder, so the model is loaded again, and that writes the settings: it fails.
      Object.assign(images, { decoder: 'fast', lastConnect: { id: 'made-up', asked: 'auto', threads: 0 } });
      images.registry.installed = () => true;
      store.saveSettings = () => Promise.reject(new Error('the disk is full'));
      const lost: unknown[] = [];
      const onLost = (e: unknown) => lost.push(e);
      process.on('unhandledRejection', onLost);
      const job = started(await images.generate({ prompt: 'a red bicycle', source: 'page' }));
      await job.done;
      await sleep(50);
      process.off('unhandledRejection', onLost);
      assert.deepEqual(lost, []);
      assert.equal(job.state, 'failed');
      assert.match(String(job.error), /the disk is full/);
    } finally {
      await runner.close();
    }
  });
});

test('Generate pressed in the moment the model is between unloading and loading again is an answer, not a crash', async () => {
  await inTemp(async dir => {
    const images = rig(dir, 'http://127.0.0.1:9');
    const w = images.pane.worker;
    // As Cancel leaves it: the old runner ended, the new one not asked for yet.
    w.view = { ...Worker.empty('auto', 0) };
    Object.assign(images, { restarting: true, lastConnect: null });
    const r = await images.generate({ prompt: 'a red bicycle', source: 'page' }) as { status?: number; error?: string };
    assert.equal(r.status, 409, JSON.stringify(r));
  });
});

test('a mode nobody knows (a queue line edited by hand or sent by another program) draws as Auto', async () => {
  await inTemp(async dir => {
    const runner = await madeUpRunner();
    try {
      const images = rig(dir, runner.base);
      const job = started(await images.generate({ prompt: 'a red bicycle', mode: 'banana' as never, source: 'api' }));
      await job.done;
      assert.equal(job.state, 'done', String(job.error));
    } finally {
      await runner.close();
    }
  });
});

test('a runner that dies mid-picture fails that picture and the one behind it, and the pane is free again', async () => {
  await inTemp(async dir => {
    const runner = await madeUpRunner(res => res.end(JSON.stringify({ status: 'generating' })));
    const images = rig(dir, runner.base);
    const first = started(await images.generate({ prompt: 'a red bicycle', source: 'page' }));
    const second = started(await images.generate({ prompt: 'a blue bicycle', source: 'page' }));
    while (first.state !== 'drawing') await sleep(50);
    assert.equal(second.state, 'queued', 'one at a time');
    await runner.close();
    await Promise.all([first.done, second.done]);
    assert.equal(first.state, 'failed');
    assert.equal(second.state, 'failed');
    assert.equal(images.busy(), false);
  });
});

test('Remove on a due quick check: it does not come straight back, and it is due again at its next date', () => {
  const s = T.normalize(null);
  const A = 'job:aaaa';
  const MON = '2026-10-26';
  T.setCheck(s, A, 'week', 'Alpha', MON);
  assert.equal(T.pullChecks(s, MON), 1);
  const row = s.items[0];
  assert.equal(T.remove(s, row.id, MON).ok, true);
  assert.equal(T.pullChecks(s, MON), 0, 'not back the same day');
  assert.equal(T.pullChecks(s, '2026-10-27'), 0, 'not back the next day');
  assert.equal(T.pullChecks(s, '2026-11-02'), 1, 'back a week on');
  // A check that is done and then removed keeps the date its tick set; a plain row changes nothing.
  const done = s.items[0];
  T.done(s, done.id, true, '2026-11-02');
  T.remove(s, done.id, '2026-11-02');
  assert.equal(s.checks[A].next, '2026-11-09');
  const plain = T.add(s, { project: A, zone: 'today' }, '2026-11-02') as { item: T.Item };
  T.remove(s, plain.item.id, '2026-11-02');
  assert.equal(s.checks[A].next, '2026-11-09');
});

test('the To Do: a file of the wrong shape reads as empty, ids that are not there are refused, two adds at once both stay', async () => {
  await inTemp(async dir => {
    const file = join(dir, 'todo.json');
    for (const body of ['[]', '5', '{"items":"x","checks":[1],"settings":"x"}', '{"items":[null,5,{"id":"zz"}]}']) {
      writeFileSync(file, body);
      const store = new T.TodoStore(file, () => '2026-10-26');
      const v = await store.view({});
      assert.deepEqual(v.zones.map(z => z.items.length), [0, 0, 0], body);
      assert.equal((await store.done('abcdef12', true)).ok, false, body);
      assert.equal((await store.move('abcdef12', 'today', null)).ok, false, body);
    }
    rmSync(file);
    const store = new T.TodoStore(file, () => '2026-10-26');
    await Promise.all(Array.from({ length: 20 }, () => store.add({ project: 'job:aaaa', zone: 'today', size: 15 })));
    assert.equal((await store.view({ 'job:aaaa': 'Alpha' })).zones[0].items.length, 20);
  });
});

const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

test('staff.json with a hire who has no name or a bad list still opens every page; Clear keeps the picture a stopped project waits for', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sm-bf-'));
  mkdirSync(join(home, 'startup'));
  mkdirSync(join(home, 'data'));
  writeFileSync(join(home, 'models-folder.txt'), '');
  writeFileSync(join(home, 'data', 'staff.json'), JSON.stringify({ staff: [{ id: 'no-name' }, { id: 'odd', name: 5, role: 7, group: 5, model: 9 }, { id: 'fine', name: 'Pat Example', role: 'coder', level: 'default' }], auditions: 'x', gone: 'x' }));
  // Stopped with the picture back and the project still to carry on from it.
  writeFileSync(join(home, 'data', 'queue.json'), JSON.stringify({ paused: true, items: [
    { id: 'proj1', kind: 'project', state: 'waiting', title: 'A shop page', added: '2026-10-26T10:00:00.000Z', project: 'p1', waitFor: 'pic1' },
    { id: 'pic1', kind: 'picture', state: 'done', title: 'A shop front', added: '2026-10-26T10:00:00.000Z', project: 'p1', step: 2, result: 'Drawn.' },
    { id: 'pic2', kind: 'picture', state: 'done', title: 'Something else', added: '2026-10-26T10:00:00.000Z', project: '' },
  ] }));
  const port = await freePort();
  const server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: { ...process.env, TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_OPEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  server.stdout.on('data', d => (said += d));
  server.stderr.on('data', d => (said += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 200 && !said.includes('is running at'); i++) await sleep(300);
    assert.match(said, /is running at/, said);
    for (const p of ['/api/chats', '/api/staff', '/api/faces', '/api/projects/setup']) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.status, 200, `${p}: ${await r.text()}`);
    }
    const people = await (await fetch(`${base}/api/staff`)).json() as { staff: { id: string; name: string }[] };
    assert.deepEqual(people.staff.map(m => typeof m.name), ['string', 'string', 'string']);
    const r = await fetch(`${base}/api/queue/clear`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 200);
    const left = (await r.json() as { items: { id: string }[] }).items.map(x => x.id).sort();
    assert.deepEqual(left, ['pic1', 'proj1'], 'the other finished line goes; the one the project waits for stays');
  } finally {
    server.kill();
    await sleep(300);
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('one damaged project file does not take down the To Do, the queue or Home', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sm-bf-'));
  mkdirSync(join(home, 'startup'));
  writeFileSync(join(home, 'models-folder.txt'), '');
  const port = await freePort();
  const server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: { ...process.env, TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_OPEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  server.stdout.on('data', d => (said += d));
  server.stderr.on('data', d => (said += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 200 && !said.includes('is running at'); i++) await sleep(300);
    assert.match(said, /is running at/, said);
    const { folder } = await (await fetch(`${base}/api/files`)).json() as { folder: string };
    const put = (id: string, name: string, body: string) => {
      mkdirSync(join(folder, 'jobs', id), { recursive: true });
      writeFileSync(join(folder, 'jobs', id, name), body);
    };
    put('20260101-0900-aaaa', 'project.json', '{ broken');
    put('20260101-0900-bbbb', 'plan.json', '{ broken');
    put('20260101-0900-cccc', 'plan.json', '{}');
    put('20260101-0900-dddd', 'project.json', JSON.stringify({ name: 'Still here', created: '2026-01-01T09:00:00.000Z' }));
    for (const p of ['/api/todo', '/api/queue/projects', '/api/jobs', '/api/home', '/api/chats']) {
      const r = await fetch(`${base}${p}`);
      assert.ok(r.status < 500, `${p}: ${r.status} ${await r.text()}`);
    }
    const { projects } = await (await fetch(`${base}/api/queue/projects`)).json() as { projects: { name: string }[] };
    assert.ok(projects.some(x => x.name === 'Still here'), 'the sound project is still listed');
  } finally {
    server.kill();
    await sleep(300);
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('a queued picture stopped while its model loads is not drawn; one stopped just as it starts is stopped', { timeout: 60_000 }, async () => {
  // Run apart: the server's parts read their folders when they are first loaded.
  const home = mkdtempSync(join(tmpdir(), 'sm-bf-'));
  mkdirSync(join(home, 'data'));
  writeFileSync(join(home, 'models-folder.txt'), '');
  const script = join(home, 'try.mts');
  const src = (f: string) => JSON.stringify(new URL(`../src/${f}`, import.meta.url).href);
  writeFileSync(script, `
    const { queuedPicture } = await import(${src('server/pictures.ts')});
    const { images } = await import(${src('server/panes.ts')});
    const { staff } = await import(${src('server/core.ts')});
    const w = images.pane.worker;
    await staff.hire('Ari Example', 'artist', 'default', 'made-up');
    images.has = () => true;
    images.list = () => [{ id: 'made-up', name: 'Made Up', fit: { level: 'ok' } }];
    const calls = { generate: 0, cancel: 0 };
    const connected = () => { w.view = { ...w.view, state: 'connected', model: 'made-up' }; };
    images.generate = async () => { calls.generate++; const job = { id: 'j1', state: 'drawing', results: [], error: null, done: new Promise(r => { images.cancel = async () => { calls.cancel++; job.state = 'cancelled'; r(); return { restarted: false }; }; setTimeout(r, 1500); }) }; return job; };

    // Stopped while the model loads: it loads, and no picture is asked for.
    const ac = new AbortController();
    images.connect = async () => { setTimeout(() => { ac.abort(); connected(); }, 100); return { ok: true }; };
    const one = await queuedPicture({ prompt: 'a red bicycle', as: staff.list()[0].id }, ac.signal, () => undefined);
    const afterLoad = { ...calls };

    // Stopped in the moment the picture is asked for: it is cancelled, not left to run.
    const ac2 = new AbortController();
    const asked = images.generate;
    images.generate = async o => { ac2.abort(); return asked(o); };
    const two = await queuedPicture({ prompt: 'a red bicycle', as: staff.list()[0].id }, ac2.signal, () => undefined);
    console.log('RESULT ' + JSON.stringify({ one, afterLoad, two, calls }));
    process.exit(0);
  `);
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, TOMLIN_HOME: home, TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: home, TOMLIN_OPEN: '', TOMLIN_PORT: String(await freePort()) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  child.stdout.on('data', d => (said += d));
  child.stderr.on('data', d => (said += d));
  try {
    await new Promise(r => child.on('exit', r));
    const line = said.split('\n').find(l => l.startsWith('RESULT '));
    assert.ok(line, said);
    const r = JSON.parse(line!.slice(7)) as { one: { error?: string }; afterLoad: { generate: number }; two: { error?: string }; calls: { generate: number; cancel: number } };
    assert.equal(r.afterLoad.generate, 0, 'nothing drawn after a stop while loading');
    assert.equal(r.one.error, 'Stopped.');
    assert.equal(r.calls.cancel, 1, 'the picture asked for in the moment of the stop is cancelled');
    assert.equal(r.two.error, 'Stopped.');
  } finally {
    child.kill();
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

