// Audit of the pictures area (Images, Character sets, reference pictures, the gallery, the queue's pictures): each test
// is named after its finding. A P0 test fails until its fault is fixed; P1 tests are todo. Two parts: an Images pane on a
// made-up picture runner in this process (as test/picturefaults.test.ts), and one real TOMLIN copy on a temp home for
// the card, gallery and queue routes (test/pcs.ts). Nothing here loads a model or starts a real runner.
// Run alone: node --test test/audit-pictures.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { Images, refPictures } from '../src/images.ts';
import { Store } from '../src/store.ts';
import { cleanRefImages } from '../src/drawrefs.ts';
import { drawChoices } from '../src/nodestaff.ts';
import { readSources, writeSource, sourceOf } from '../src/sources.ts';
import { expandPrompt, type Card } from '../src/cards.ts';
import { promptWhy } from '../src/images.ts';
import { ridOf } from '../src/outbox.ts';
import { startPc, type Pc } from './pcs.ts';

const GB = 2 ** 30;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const SCRATCH = join(process.env.LOCALAPPDATA ?? process.env.TEMP ?? '.', 'Temp', 'tomlin-audit-pictures');
mkdirSync(SCRATCH, { recursive: true });

// ---- Odd pictures, made byte by byte ----

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A PNG header that claims `w` x `h` and has no picture data at all (a decoder that trusts it reserves w*h*3 bytes). */
function claimedPng(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
}
const GOOD_PNG = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#336699' } }).png().toBuffer();
const PNG512 = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#996633' } }).png().toBuffer();

// ---- An Images pane on a made-up runner (as test/picturefaults.test.ts) ----

type Handler = (url: string, body: string, req: IncomingMessage) => { status?: number; type?: string; text: string } | null;

async function withPane(handler: Handler, fn: (im: any, bodies: any[]) => Promise<void>, o: { refs?: number } = {}) {
  const dir = mkdtempSync(join(SCRATCH, 'pane-'));
  mkdirSync(join(dir, 'registry'));
  mkdirSync(join(dir, 'data'));
  mkdirSync(join(dir, 'models', 'image'), { recursive: true });
  writeFileSync(join(dir, 'models', 'image', 'm.gguf'), 'x');
  writeFileSync(join(dir, 'registry', 'm.json'), JSON.stringify({ id: 'm', kind: 'image', name: 'Made-up model', about: '', licence: 'test', quant: '', minRamGB: 1, minVramGB: 0, native: 512, quality: { draft: 512, mid: 512, high: 512 }, defaults: { steps: 4, cfg: 1, sampler: 'euler', scheduler: '', negative: '' }, ...(o.refs ? { refs: o.refs } : {}), files: [{ role: 'model', repo: 'x/y', rev: 'main', path: 'm.gguf', bytes: 1, sha256: '0'.repeat(64) }] }));
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (req.url!.includes('img_gen')) bodies.push(JSON.parse(body));
      const out = handler(req.url!, body, req);
      if (out === null) return; // never answers
      res.writeHead(out.status ?? 200, { 'content-type': out.type ?? 'application/json' }).end(out.text);
    });
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const im: any = new Images({ root: dir, models: join(dir, 'models'), data: join(dir, 'data'), store: new Store(join(dir, 'data')), runtimes: {}, hardware: { gpus: [], ram: 24 * GB }, sampler: {}, fit: () => ({ level: 'ok', need: 0, free: 0, otherOn: false }) } as any);
  Object.assign(im.pane.view, { state: 'connected', model: 'm', device: 'cpu', asked: 'cpu' });
  Object.defineProperty(im.pane.worker, 'base', { get: () => base, configurable: true });
  Object.defineProperty(im.pane.worker, 'pid', { get: () => 1234, configurable: true });
  im.pane.worker.tail = () => '';
  im.decoder = 'full';
  im.restart = async () => true;
  try {
    await fn(im, bodies);
  } finally {
    server.closeAllConnections();
    await new Promise(ok => server.close(ok));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
const okJob = (png: Buffer = PNG512): Handler => url => (url.includes('img_gen') ? { text: JSON.stringify({ id: 'j1' }) } : { text: JSON.stringify({ status: 'completed', result: { images: [{ b64_json: png.toString('base64') }] } }) });
async function draw(im: any, extra: object = {}, ms = 15_000) {
  const job = await im.generate({ prompt: 'a lighthouse on a cliff', source: 'api', quality: 'mid', drafts: 1, ...extra });
  assert.ok('id' in job, JSON.stringify(job));
  await Promise.race([job.done, sleep(ms)]);
  return job;
}

// ==== Rule 2: reference pictures ====

test('B-01: a reference picture a linked PC is sent is checked as a picture, not by its first 8 bytes (a claimed 60000 x 60000 PNG never reaches the runner)', () => {
  const bomb = claimedPng(60000, 60000).toString('base64');
  const headerOnly = Buffer.concat([SIG, Buffer.alloc(200, 7)]).toString('base64');
  assert.deepEqual(cleanRefImages([GOOD_PNG.toString('base64')]).length, 1, 'a real PNG still goes');
  assert.deepEqual(cleanRefImages([bomb]), [], 'a PNG that claims 60000 x 60000 with no picture data is let through to the runner');
  assert.deepEqual(cleanRefImages([headerOnly]), [], 'eight PNG bytes and then rubbish is let through to the runner');
});

test('B-01b: on the linked PC, the reference data it was sent goes to the runner as sent (no decode, no resize), unlike its own references', { timeout: 30_000 }, async () => {
  const bomb = claimedPng(60000, 60000).toString('base64');
  await withPane(okJob(), async (im, bodies) => {
    await draw(im, { forPc: 'Main PC', refData: [bomb] });
    assert.equal(bodies.length, 1);
    const sent: string[] = bodies[0].ref_images ?? [];
    assert.ok(!sent.includes(bomb), 'the claimed 60000 x 60000 PNG reached the runner\'s ref_images unchanged');
  }, { refs: 4 });
});

test('G-01: references read from this PC\'s own card folder: a claimed 60000 x 60000 PNG and rubbish are passed over, a 1 x 100000 strip is made small', async () => {
  const dir = mkdtempSync(join(SCRATCH, 'refs-'));
  try {
    writeFileSync(join(dir, 'bomb.png'), claimedPng(60000, 60000));
    writeFileSync(join(dir, 'junk.png'), Buffer.concat([SIG, Buffer.alloc(100, 1)]));
    await sharp({ create: { width: 1, height: 100000, channels: 3, background: '#000' } }).png().toFile(join(dir, 'strip.png'));
    const got = await refPictures([join(dir, 'bomb.png'), join(dir, 'junk.png'), join(dir, 'strip.png')], 4);
    assert.equal(got.length, 1);
    const m = await sharp(Buffer.from(got[0], 'base64')).metadata();
    assert.ok(m.height! <= 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G-02: a model that takes no references gets none, even when a linked PC sends four', { timeout: 30_000 }, async () => {
  await withPane(okJob(), async (im, bodies) => {
    await draw(im, { forPc: 'Main PC', refData: [GOOD_PNG.toString('base64')] });
    assert.equal(bodies[0].ref_images, undefined);
  });
});

// ==== Rule 5: the seed asked is the seed drawn, here and on a linked PC ====

test('B-02: a seed of 2^31 or more is drawn here but silently replaced by a random one on a linked PC (and in the queue)', { timeout: 30_000 }, async () => {
  const seed = 3_000_000_000;
  await withPane(okJob(), async (im, bodies) => {
    const job = await im.generate({ prompt: 'a lighthouse on a cliff', source: 'page', seed, drafts: 1 });
    if (!('id' in job)) return; // refused here with a reason: fine, as long as it is refused on a linked PC too
    await Promise.race([job.done, sleep(15_000)]);
    assert.equal(bodies[0].seed, seed, 'drawn here with the seed asked');
    // The same request to a linked PC (startAway and queuedPicture send drawChoices(b)) loses the seed with no word.
    assert.equal(drawChoices({ seed }).seed, seed, 'the seed asked is dropped on its way to a linked PC, so another seed is drawn there');
  });
});

test('B-03: a seed past what the runner reads (1e20) is sent to the runner as asked', async () => {
  await withPane(okJob(), async (im, bodies) => {
    const job = await im.generate({ prompt: 'a lighthouse on a cliff', source: 'page', seed: 1e20, drafts: 1 });
    if (!('id' in job)) return;
    await Promise.race([job.done, sleep(15_000)]);
    assert.ok(Number.isSafeInteger(bodies[0].seed) && bodies[0].seed < 2 ** 32, `sent seed ${bodies[0].seed}`);
  });
});

// ==== Rule 6: cut, slow, HTML or bad-JSON runner replies ====

test('G-03: an HTML page from the runner where a job id is wanted fails the picture plainly, and the next picture works', { timeout: 40_000 }, async () => {
  let n = 0;
  await withPane((url, _b) => {
    if (url.includes('img_gen')) return n++ === 0 ? { type: 'text/html', text: '<html><body>Bad gateway</body></html>' } : { text: JSON.stringify({ id: 'j2' }) };
    return { text: JSON.stringify({ status: 'completed', result: { images: [{ b64_json: PNG512.toString('base64') }] } }) };
  }, async im => {
    const a = await draw(im);
    assert.equal(a.state, 'failed');
    assert.match(a.error, /image runner did not answer|refused/);
    const b = await draw(im);
    assert.equal(b.state, 'done', String(b.error));
  });
});

test('R-01: an HTML page (or bad JSON) where the job\'s state is wanted is said as "stopped while loading the model"', { timeout: 40_000 }, async () => {
  await withPane(url => (url.includes('img_gen') ? { text: JSON.stringify({ id: 'j1' }) } : { type: 'text/html', text: '<html>proxy error</html>' }), async im => {
    const a = await draw(im);
    assert.equal(a.state, 'failed');
    assert.doesNotMatch(a.error, /while loading the model/, a.error);
  });
});

test('G-04: a runner answer that is not a picture is a failed picture, never a broken file, and the next one works', { timeout: 40_000 }, async () => {
  let n = 0;
  await withPane(url => {
    if (url.includes('img_gen')) return { text: JSON.stringify({ id: 'j' }) };
    return { text: JSON.stringify({ status: 'completed', result: { images: [{ b64_json: n++ === 0 ? Buffer.from('<html>no</html>').toString('base64') : PNG512.toString('base64') }] } }) };
  }, async im => {
    const a = await draw(im);
    assert.equal(a.state, 'failed');
    assert.match(a.error, /not a picture/);
    assert.equal(a.results.length, 0);
    const b = await draw(im);
    assert.equal(b.state, 'done', String(b.error));
  });
});

test('R-02: a picture the runner sends that cannot be finished leaves no stray file in the gallery folder', { timeout: 40_000 }, async () => {
  await withPane(okJob(), async im => {
    // An icon needs the background remover, which is not downloaded here: the picture fails after it was drawn.
    const a = await draw(im, { mode: 'icon' });
    assert.equal(a.state, 'failed', String(a.error));
    assert.match(String(a.error), /could not be finished/);
    const month = new Date().toISOString().slice(0, 7);
    const dir = join(im.gallery.dir, month);
    const files = existsSync(dir) ? readdirSync(dir) : [];
    assert.deepEqual(files, [], 'the -original.png of a failed picture stays on disk, in no gallery line');
  });
});

test('R-03: a runner whose job never finishes (always "working") has no end but Cancel', { timeout: 20_000 }, async () => {
  await withPane(url => (url.includes('img_gen') ? { text: JSON.stringify({ id: 'j' }) } : { text: JSON.stringify({ status: 'working' }) }), async im => {
    // The real limit is far past the slowest CPU step (30 minutes); made short here so the test does not wait that long.
    im.stallMs = 3000;
    const a = await draw(im, {}, 6000);
    const st = a.state;
    await im.cancel();
    assert.ok(['failed', 'done'].includes(st), `after 6 s with no step it is still "${st}"; nothing but Cancel ends it`);
  });
});

// ==== Rule 7: two windows drawing ====

test('G-05: two pictures asked from two chats at once each land in their own chat', { timeout: 60_000 }, async () => {
  await withPane(okJob(), async im => {
    const a = await im.generate({ prompt: 'a red boat', source: 'page', chat: 'aaaaaaaaaaaa', drafts: 1 });
    const b = await im.generate({ prompt: 'a blue kite', source: 'page', chat: 'bbbbbbbbbbbb', drafts: 1 });
    await Promise.race([Promise.all([a.done, b.done]), sleep(40_000)]);
    assert.equal(a.results[0]?.chat, 'aaaaaaaaaaaa');
    assert.equal(b.results[0]?.chat, 'bbbbbbbbbbbb');
    const final = await im.generate({ prompt: '', source: 'page', finalOf: a.results[0].id, chat: 'bbbbbbbbbbbb' });
    await Promise.race([final.done, sleep(15_000)]);
    assert.equal(final.results[0]?.chat, 'aaaaaaaaaaaa', 'a final stays in its draft\'s chat');
  });
});

test('R-18: Cancel on one picture stops only that one: the pictures waiting behind it (other chats, the queue) keep their place', { timeout: 40_000 }, async () => {
  // The runner takes each picture and never finishes it, so the first one draws and the others wait behind it.
  await withPane(url => (url.includes('img_gen') ? { text: JSON.stringify({ id: 'j' }) } : { text: JSON.stringify({ status: 'working' }) }), async im => {
    const a = await im.generate({ prompt: 'a red boat', source: 'page', chat: 'aaaaaaaaaaaa', drafts: 1 });
    const b = await im.generate({ prompt: 'a blue kite', source: 'page', chat: 'bbbbbbbbbbbb', drafts: 1 });
    const c = await im.generate({ prompt: 'a green hill', source: 'api', drafts: 1, full: true });
    for (let i = 0; i < 50 && im.jobView()?.id !== a.id; i++) await sleep(100);
    // Cancel as the Images window sends it on (src/server/pictures.ts names the picture it means).
    const res = { writeHead: () => res, end: () => res } as any;
    const cancel = (id: string) => im.post({} as any, res, new URL('http://x/api/images/cancel'), { id });
    try {
      await cancel(b.id);
      assert.equal(b.state, 'cancelled');
      assert.equal(a.state === 'cancelled', false, 'Cancel on a waiting picture also stopped the one drawing');
      assert.equal(c.state, 'queued', 'Cancel on one waiting picture also cancelled another waiting picture');
      await cancel(a.id);
      assert.equal(a.state, 'cancelled');
      assert.notEqual(c.state, 'cancelled', 'Cancel on the picture drawing also cancelled the picture waiting behind it');
    } finally {
      await im.cancel();
      await Promise.race([Promise.all([a.done, b.done, c.done]), sleep(10_000)]);
    }
  });
});

// ==== Rule 8: odd prompts ====

test('R-04: a prompt typed under 2,000 characters is refused as "too long" once its @names add their words', () => {
  const cards: Card[] = [{ kind: 'character', name: 'Ember', words: 'w'.repeat(600), avoid: '', refs: [], at: '' }, { kind: 'location', name: 'Pine forest', words: 'p'.repeat(600), avoid: '', refs: [], at: '' }];
  const typed = `${'a fox in a forest '.repeat(60)} @Ember in @Pine forest`;
  assert.ok(typed.length < 2000);
  const e = expandPrompt(typed, cards);
  // The Images window refuses it, naming the person's typing; the queue cuts it at 2,000 (losing the card words) silently.
  assert.equal(promptWhy(e.prompt), null, 'refused as too long though the person typed under the limit');
});

// ==== Load previously made images: newest first ====

test('R-05: with more than 500 image sources, the newest are not among those listed', async () => {
  const dir = mkdtempSync(join(SCRATCH, 'src-'));
  try {
    const base = { id: 'x', prompt: 'p', modelPrompt: 'p', negative: '', mode: 'custom', model: 'm', modelName: 'M', seed: 1, steps: 4, cfg: 1, sampler: 'euler', generated: { width: 512, height: 512 }, target: { width: 512, height: 512 }, fit: 'crop', device: 'cpu', seconds: 1, draft: false, original: '', format: 'png', bytes: 1 } as any;
    for (const [i, month] of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'].entries()) {
      mkdirSync(join(dir, month));
      await writeSource(join(dir, month), sourceOf({ ...base, output: `${month}/pic.png`, at: `${month}-0${i + 1}T00:00:00.000Z` }));
    }
    const r = await readSources(dir, 3);
    assert.equal(r.more, true);
    assert.ok(r.sources.some(s => s.at.startsWith('2026-05')), `listed: ${r.sources.map(s => s.at.slice(0, 7)).join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ==== A real TOMLIN copy: cards, the gallery and the queue ====

const PROJECT = '20261127-1200-abcd';
const LONG = '20261127-1201-beef';
const DEEP = '20261127-1202-cafe';
let pc: Pc | null = null;
let home = '';
const PIC_A = 'aaaaaaaaaaa1';
const PIC_B = 'aaaaaaaaaaa2';

before(async () => {
  home = mkdtempSync(join(SCRATCH, 'home-'));
  const ws = join(home, 'data', 'workspace');
  const longFolder = ['A'.repeat(60), 'B'.repeat(59)].join('/');
  for (const [id, folder] of [[PROJECT, 'Story'], [LONG, longFolder], [DEEP, 'Clients/Acme/Story']]) {
    mkdirSync(join(ws, 'jobs', id), { recursive: true });
    writeFileSync(join(ws, 'jobs', id, 'project.json'), JSON.stringify({ id, created: '2026-11-27T12:00:00.000Z', name: `Project ${id}`, folder, team: null, answers: { statement: 'A story' } }));
    writeFileSync(join(ws, 'jobs', id, 'scope.md'), '# Scope\n');
    writeFileSync(join(ws, 'jobs', id, 'design.md'), '# Design\n');
    mkdirSync(join(ws, ...folder.split('/')), { recursive: true });
  }
  // Two gallery pictures, each with its image source.
  const gal = join(home, 'data', 'images');
  mkdirSync(join(gal, '2026-11'), { recursive: true });
  const line = (id: string, name: string) => ({ id, at: '2026-11-27T10:00:00.000Z', prompt: name, modelPrompt: name, negative: '', mode: 'custom', model: 'm', modelName: 'M', seed: 1, steps: 4, cfg: 1, sampler: 'euler', generated: { width: 512, height: 512 }, target: { width: 512, height: 512 }, fit: 'crop', device: 'cpu', seconds: 1, draft: false, original: `2026-11/${name}-1-original.png`, output: `2026-11/${name}-512x512.png`, format: 'png', bytes: PNG512.length, kept: true });
  const lines = [line(PIC_A, 'fox'), line(PIC_B, 'boat')];
  for (const p of lines) {
    writeFileSync(join(gal, p.original), PNG512);
    writeFileSync(join(gal, p.output), PNG512);
    writeFileSync(join(gal, `${p.output}.source.json`), JSON.stringify(sourceOf(p as any)));
  }
  writeFileSync(join(gal, 'gallery.jsonl'), `${lines.map(l => JSON.stringify(l)).join('\n')}\n`);
  pc = await startPc({ root: join(import.meta.dirname, '..'), home });
  // The queue stays paused: nothing here is drawn.
  await pc.post('/api/queue/pause', { paused: true });
});

after(async () => {
  await pc?.stop();
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const card = (name: string, words = '', kind = 'character') => ({ kind, name, words, avoid: '', refs: [] as string[] });
const cardsNow = async (project = PROJECT) => ((await pc!.get(`/api/cards?project=${project}`)).body?.cards ?? []) as Array<{ kind: string; name: string; words: string; refs: string[]; pictures: string[]; folder: string }>;

test('B-04: a new card given the name of a card already there (same kind) is refused, never written over it', { timeout: 600_000 }, async () => {
  const a = await pc!.post('/api/cards/save', { project: PROJECT, card: card('Ember', 'a young red fox, white chest') });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  // "+ Character" again, the same name typed (or a second window): no `was`, as the page sends for a new card.
  const b = await pc!.post('/api/cards/save', { project: PROJECT, card: card('Ember', 'a grey whale') });
  const ember = (await cardsNow()).find(c => c.name === 'Ember');
  assert.equal(ember?.words, 'a young red fox, white chest', 'the first Ember\'s words were written over');
  assert.equal(b.status, 409, `the second save answered ${b.status}`);
});

test('G-06: a card cannot name or tick a file outside its folder (path, dots, slashes, a stream name, a device name)', { timeout: 600_000 }, async () => {
  for (const name of ['../x', '..', 'a/b', 'a\\b', '.hidden', 'x'.repeat(41), '', '   ', 'Ember\u0000', 'C:x']) {
    const r = await pc!.post('/api/cards/save', { project: PROJECT, card: card(name) });
    assert.equal(r.status, 400, `${JSON.stringify(name)} answered ${r.status}`);
  }
  const r = await pc!.post('/api/cards/save', { project: PROJECT, card: { ...card('Tick test'), refs: ['../../secret.png', 'C:\\Windows\\x.png', 'card.json', '.x.png', 'a.png:x', 'card.json:evil.png'] } });
  assert.equal(r.status, 200);
  const t = (await cardsNow()).find(c => c.name === 'Tick test');
  assert.deepEqual(t?.refs, [], 'no file that is not one of its own pictures is ticked');
  const pageFiles = await pc!.post('/api/cards/picture', { project: PROJECT, kind: 'character', name: 'Tick test', picture: '../../x' });
  assert.equal(pageFiles.status, 404);
});

test('G-07: a picture added to a card is a copy in its folder and ticked; deleting the gallery picture keeps the copy', { timeout: 600_000 }, async () => {
  await pc!.post('/api/cards/save', { project: PROJECT, card: card('Copper', 'a copper robot') });
  const r = await pc!.post('/api/cards/picture', { project: PROJECT, kind: 'character', name: 'Copper', picture: PIC_A });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = (await cardsNow()).find(x => x.name === 'Copper')!;
  assert.equal(c.refs.length, 1);
  assert.ok(existsSync(join(home, 'data', 'workspace', ...c.pictures[0].split('/'))));
});

test('B-05: a card renamed only in letter case (Pine forest to pine forest) is renamed', { timeout: 600_000 }, async () => {
  const a = await pc!.post('/api/cards/save', { project: PROJECT, card: card('Pine forest', 'tall pines in snow', 'location') });
  assert.equal(a.status, 200);
  const b = await pc!.post('/api/cards/save', { project: PROJECT, card: card('pine forest', 'tall pines in snow', 'location'), was: 'Pine forest' });
  assert.equal(b.status, 200, `refused: ${JSON.stringify(b.body)}`);
});

test('B-06: a card named as a Windows device (CON, COM1, NUL) is refused with a reason about its name', { timeout: 600_000 }, async () => {
  for (const name of ['CON', 'COM1', 'nul', 'Lpt¹']) {
    const r = await pc!.post('/api/cards/save', { project: PROJECT, card: card(name) });
    assert.equal(r.status, 400, `${name}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(String(r.body?.error), /name/i, `${name}: ${JSON.stringify(r.body)}`);
  }
});

test('B-07: a project kept three folders deep (Clients/Acme/Story, as Home allows) can have a character card', { timeout: 600_000 }, async () => {
  const s = await pc!.post('/api/cards/save', { project: DEEP, card: card('Ember', 'a young red fox') });
  assert.equal(s.status, 200, `Save: ${s.status} ${JSON.stringify(s.body)}`);
  const r = await pc!.post('/api/cards/picture', { project: DEEP, kind: 'character', name: 'Ember', picture: PIC_A });
  assert.equal(r.status, 200, `Add picture: ${r.status} ${JSON.stringify(r.body)}`);
});

test('B-07b: in a project with a long two-level folder, a card with a 40-letter name can take pictures', { timeout: 600_000 }, async () => {
  const name = 'N'.repeat(40);
  const s = await pc!.post('/api/cards/save', { project: LONG, card: card(name, 'a long named one') });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const r = await pc!.post('/api/cards/picture', { project: LONG, kind: 'character', name, picture: PIC_A });
  assert.equal(r.status, 200, `Add picture: ${r.status} ${JSON.stringify(r.body)}`);
});

test('G-08: deleting a picture deletes its files and its image source, and nothing of another picture', { timeout: 600_000 }, async () => {
  const gal = join(home, 'data', 'images', '2026-11');
  const r = await pc!.post('/api/images/delete', { ids: [PIC_B] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(existsSync(join(gal, 'boat-512x512.png')), false);
  assert.equal(existsSync(join(gal, 'boat-1-original.png')), false);
  assert.equal(existsSync(join(gal, 'boat-512x512.png.source.json')), false);
  assert.equal(existsSync(join(gal, 'fox-512x512.png')), true);
  assert.equal(existsSync(join(gal, 'fox-512x512.png.source.json')), true);
  const listed = (await pc!.get('/api/images/gallery?shelf=all')).body.pictures.map((p: { id: string }) => p.id);
  assert.deepEqual(listed, [PIC_A]);
});

test('B-08: a queued picture with a seed the Images window takes (3000000000) keeps it, or is refused with a reason', { timeout: 600_000 }, async () => {
  const r = await pc!.post('/api/queue/add', { kind: 'picture', prompt: 'a lighthouse at dusk', seed: 3_000_000_000, quality: 'high' });
  if (r.status === 400) return;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const q = JSON.parse(readFileSync(join(home, 'data', 'queue.json'), 'utf8'));
  const it = q.items.find((x: { prompt?: string }) => x.prompt === 'a lighthouse at dusk');
  assert.equal(it?.seed, 3_000_000_000, 'the seed was dropped with no word: a random one will be drawn');
});

test('R-06: a queued picture over 2,000 characters is refused as the Images window refuses it, not cut', { timeout: 600_000 }, async () => {
  const r = await pc!.post('/api/queue/add', { kind: 'picture', prompt: `a castle ${'with towers '.repeat(250)}` });
  assert.equal(r.status, 400, `added (${r.status}): the prompt was cut at 2,000 characters with no word`);
});

test('R-08: a queued picture already drawn and saved when the app was killed is collected on the next start, never drawn (or handed in) again', { timeout: 600_000 }, async () => {
  // The home as a kill leaves it: the picture is in the gallery and handed in to its project, but its queue line was
  // still "running" (the line is written last). The copy has no artist and no picture model: it cannot draw anything.
  const h = mkdtempSync(join(SCRATCH, 'kill-'));
  const id = 'q0000000kill';
  const prompt = 'a lighthouse in a storm';
  const rid = ridOf({ queue: id, prompt, as: '', mode: '', width: 0, height: 0 });
  const month = new Date().toISOString().slice(0, 7);
  const output = `${month}/lighthouse-512x512.png`;
  const copy = 'Story/specialists/images/lighthouse.png';
  try {
    const ws = join(h, 'data', 'workspace');
    mkdirSync(join(ws, 'jobs', PROJECT), { recursive: true });
    writeFileSync(join(ws, 'jobs', PROJECT, 'project.json'), JSON.stringify({ id: PROJECT, created: '2026-11-27T12:00:00.000Z', name: 'The story', folder: 'Story', team: null, answers: { statement: 'A story' } }));
    mkdirSync(join(ws, 'Story', 'specialists', 'images'), { recursive: true });
    writeFileSync(join(ws, ...copy.split('/')), PNG512);
    const gal = join(h, 'data', 'images');
    mkdirSync(join(gal, month), { recursive: true });
    writeFileSync(join(gal, output), PNG512);
    writeFileSync(join(gal, `${month}/lighthouse-1-original.png`), PNG512);
    const pic = { id: 'killpicture1', at: new Date().toISOString(), prompt, modelPrompt: prompt, negative: '', mode: 'custom', model: 'm', modelName: 'M', seed: 1, steps: 4, cfg: 1, sampler: 'euler', generated: { width: 512, height: 512 }, target: { width: 512, height: 512 }, fit: 'crop', device: 'cpu', seconds: 12, draft: false, original: `${month}/lighthouse-1-original.png`, output, format: 'png', bytes: PNG512.length, kept: true, queued: rid, savedTo: [{ project: PROJECT, name: 'The story', path: copy }] };
    writeFileSync(join(gal, 'gallery.jsonl'), `${JSON.stringify(pic)}\n`);
    writeFileSync(join(h, 'data', 'queue.json'), JSON.stringify({ paused: false, items: [{ id, kind: 'picture', state: 'running', title: prompt, prompt, added: '2026-11-27T12:00:00.000Z', started: '2026-11-27T12:00:01.000Z', project: PROJECT, projectName: 'The story', lanes: ['here'], laneName: 'this PC' }] }));
    const p2 = await startPc({ root: join(import.meta.dirname, '..'), home: h });
    try {
      let it: any;
      for (let i = 0; i < 100; i++) {
        it = (await p2.get('/api/queue')).body?.items?.find((x: { id: string }) => x.id === id);
        if (it && it.state !== 'waiting' && it.state !== 'running') break;
        await sleep(200);
      }
      assert.equal(it?.state, 'done', `after the restart the line is "${it?.state}" (${it?.error || it?.note}): it was drawn again rather than collected`);
      assert.equal(it.output, output);
      assert.equal(it.handed, copy, 'the picture was handed in to its project a second time');
      const known = ['lighthouse-1-original.png', 'lighthouse-512x512.png', 'lighthouse-512x512.png.source.json'];
      assert.deepEqual(readdirSync(join(gal, month)).filter(f => !known.includes(f)), [], 'a second picture was saved in the gallery');
      assert.deepEqual(readdirSync(join(ws, 'Story', 'specialists', 'images')), ['lighthouse.png']);
    } finally {
      await p2.stop();
    }
  } finally {
    rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

// ==== The gallery on its own: a delete that fails part-way, and scale ====

test('R-07: a delete that fails part-way (one file cannot be removed) leaves no picture listed with its files gone', async () => {
  const { Gallery } = await import('../src/gallery.ts');
  const dir = mkdtempSync(join(SCRATCH, 'gal-'));
  try {
    const g = new Gallery(dir);
    const output = await g.save('cat-512x512.png', PNG512);
    const original = await g.save('cat-1-original.png', PNG512);
    // Its image source cannot be removed (here: a folder in its place; on Windows also a file held open elsewhere).
    mkdirSync(join(dir, `${output}.source.json`));
    await g.add({ id: 'c1', at: new Date().toISOString(), prompt: 'cat', modelPrompt: 'cat', negative: '', mode: 'custom', model: 'm', modelName: 'M', seed: 1, steps: 4, cfg: 1, sampler: 'euler', generated: { width: 512, height: 512 }, target: { width: 512, height: 512 }, fit: 'crop', device: 'cpu', seconds: 1, draft: false, original, output, format: 'png', bytes: 1, kept: true } as any);
    await g.remove('c1').catch(() => undefined);
    const listed = (await g.list()).pictures.map(p => p.id);
    const fileThere = existsSync(join(dir, output));
    assert.ok(listed.includes('c1') ? fileThere : true, 'still listed in the gallery, but its picture file is gone (a broken picture)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G-09: a gallery of 20,000 pictures loads, lists and finds a file quickly', { timeout: 60_000 }, async () => {
  const { Gallery } = await import('../src/gallery.ts');
  const dir = mkdtempSync(join(SCRATCH, 'gal-'));
  try {
    const one = (i: number) => JSON.stringify({ id: `p${i}`, at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), prompt: `picture ${i} of a fox`, modelPrompt: 'x', negative: '', mode: 'custom', model: 'm', modelName: 'M', seed: i, steps: 4, cfg: 1, sampler: 'euler', generated: { width: 512, height: 512 }, target: { width: 512, height: 512 }, fit: 'crop', device: 'cpu', seconds: 1, draft: false, original: `2026-01/p${i}-o.png`, output: `2026-01/p${i}.png`, format: 'png', bytes: 1, kept: i % 2 === 0 });
    writeFileSync(join(dir, 'gallery.jsonl'), `${Array.from({ length: 20_000 }, (_, i) => one(i)).join('\n')}\n`);
    const g = new Gallery(dir);
    const t0 = Date.now();
    const l = await g.list(0, 60, 'all', 'fox 19999');
    for (let i = 0; i < 60; i++) await g.file(`2026-01/p${19_999 - i}.png`);
    const ms = Date.now() - t0;
    assert.equal(l.total, 1);
    assert.ok(ms < 5000, `${ms} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
