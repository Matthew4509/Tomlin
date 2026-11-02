// What the node tests of 2 November found in pictures (docs: a 4 GB Quadro K1200): a model that only fits with its
// weights in RAM, a card failure with no useful words and no way out, a runner left broken, a silent move to the CPU,
// a "Fits this PC" that was not so, and "no people" read as people. Against a made-up runner. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { pictureCardNeed, pictureOffload, tooLongPath } from '../src/devices.ts';
import { detectMode, groupAsk } from '../src/modes.ts';
import { Images } from '../src/images.ts';
import { Store } from '../src/store.ts';

const GB = 2 ** 30;
const CARD = 4 * GB;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const PNG = (await sharp({ create: { width: 512, height: 512, channels: 3, background: '#336699' } }).png().toBuffer()).toString('base64');

test('a big model on a small card keeps its weights in RAM: its working memory counts, not its files alone', () => {
  assert.equal(pictureOffload(3_142_189_462, CARD, 1024), true, 'an SDXL model of 3.1 GB at 1024 on a 4 GB card');
  assert.equal(pictureOffload(2_277_040_742, CARD, 512), false, 'an SD 1.5 model of 2.3 GB at 512 drew on that card');
  assert.equal(pictureOffload(6 * GB, 24 * GB, 1024), false);
  assert.equal(pictureOffload(6 * GB, null, 1024), false, 'not known: the runner fits it itself');
});

test('what a picture model needs on the card: less when its weights wait in RAM', () => {
  const sd15 = pictureCardNeed(2_277_040_742, 512, CARD);
  const sdxl = pictureCardNeed(3_142_189_462, 1024, CARD);
  assert.ok(sd15 > 2.2 * GB && sd15 < 3.2 * GB, `SD 1.5: ${sd15 / GB}`);
  assert.ok(sdxl < CARD, `SDXL with its weights in RAM fits a clean 4 GB card: ${sdxl / GB}`);
  assert.ok(sdxl > 2.5 * GB, 'but not beside 2.5 GB of chat models');
});

test('a folder path too long for the picture runner is found before it starts', () => {
  const long = `D:/models/${'x'.repeat(250)}/model.gguf`;
  assert.equal(tooLongPath(['C:/models/a.gguf', long], 'win32'), long);
  assert.equal(tooLongPath(['C:/models/a.gguf'], 'win32'), null);
  assert.equal(tooLongPath([long], 'linux'), null, 'only Windows has the limit');
});

test('"no people" is not a picture of people: drawn square, and it can be an icon', () => {
  assert.equal(groupAsk('a black computer case, studio photograph, plain background, no people, no text'), false);
  assert.equal(groupAsk('a computer case without any people'), false);
  assert.equal(groupAsk('two people at a desk'), true, 'people asked for still are');
  assert.equal(detectMode('a computer icon, no people', null).mode, 'icon');
});

/** SD 1.5 sized (drew on the 4 GB card) and SDXL sized (did not). */
const SMALL = { bytes: 2_277_040_742, native: 512 };
const BIG = { bytes: 3_142_189_462, native: 1024 };

/** An Images pane on a made-up runner whose jobs answer `job`, with a 4 GB card and (stubbed) restarts recorded. */
async function withPane(job: unknown, view: Record<string, unknown>, fn: (im: any, restarts: unknown[][]) => Promise<void>, size = SMALL) {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-picturefaults-'));
  mkdirSync(join(dir, 'registry'));
  mkdirSync(join(dir, 'data'));
  mkdirSync(join(dir, 'models', 'image'), { recursive: true });
  writeFileSync(join(dir, 'models', 'image', 'big.gguf'), 'x');
  writeFileSync(join(dir, 'registry', 'big.json'), JSON.stringify({ id: 'big', kind: 'image', name: 'Big', about: '', licence: '', quant: '', minRamGB: 8, minVramGB: 4, native: size.native, quality: { draft: size.native, mid: size.native, high: size.native }, defaults: { steps: 5, cfg: 1.5, sampler: 'euler', scheduler: '', negative: '' }, files: [{ role: 'model', repo: 'x/y', rev: 'main', path: 'big.gguf', bytes: size.bytes, sha256: '0'.repeat(64) }] }));
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.url!.includes('img_gen') ? { id: 'j1' } : job));
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const im: any = new Images({ root: dir, models: join(dir, 'models'), data: join(dir, 'data'), store: new Store(join(dir, 'data')), runtimes: {}, hardware: { gpus: [{ name: 'Quadro K1200', total: CARD, integrated: false }], ram: 24 * GB }, sampler: {} } as any);
  Object.assign(im.pane.view, { state: 'connected', model: 'big', device: 'vulkan', asked: 'auto', ...view });
  Object.defineProperty(im.pane.worker, 'base', { get: () => base, configurable: true });
  im.decoder = 'full';
  const restarts: unknown[][] = [];
  // A restart that "works" and keeps the device it was asked for: what matters is what was asked.
  im.restart = async (...a: unknown[]) => {
    restarts.push(a);
    const devices = a[2] as string[] | undefined;
    if (devices?.length) im.pane.view.device = devices[0];
    return true;
  };
  try {
    await fn(im, restarts);
  } finally {
    server.closeAllConnections();
    await new Promise(ok => server.close(ok));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
const draw = async (im: any, extra: object = {}) => {
  const job = await im.generate({ prompt: 'a waterfall', source: 'api', quality: 'mid', ...extra });
  assert.ok('id' in job, JSON.stringify(job));
  await Promise.race([job.done, sleep(8000)]);
  return job;
};
const noResults = { status: 'failed', error: { message: 'generate_image returned no results' } };

test('"generate_image returned no results" on a card: drawn again with the weights in RAM, on the same card', { timeout: 20_000 }, async () => {
  await withPane(noResults, {}, async (im, restarts) => {
    const job = await draw(im);
    assert.ok(restarts.length >= 1, `it was started again: ${job.state} ${job.error}`);
    assert.deepEqual(restarts[0][2], ['vulkan'], 'first on the same card, not the CPU');
    assert.equal(im.forceOffload, true, 'with its weights waiting in RAM');
    assert.match(String(restarts[0][1]), /RAM/);
  });
});

test('a card that still fails with the weights in RAM: then the CPU, said plainly', { timeout: 20_000 }, async () => {
  await withPane(noResults, {}, async (im, restarts) => {
    await draw(im);
    assert.deepEqual(restarts.map(r => r[2]), [['vulkan'], ['cpu']]);
  });
});

test('a failure with no way out says what most likely happened, and the next picture starts the runner again', { timeout: 20_000 }, async () => {
  await withPane(noResults, { asked: 'gpu' }, async (im, restarts) => {
    const job = await draw(im);
    assert.equal(job.state, 'failed');
    assert.match(job.error, /ran out of memory/);
    assert.equal(restarts.length, 0, 'asked for the card only: not moved');
    await draw(im);
    assert.equal(restarts.length, 1, 'the runner that failed is not trusted with the next picture');
  });
});

test('drawn on the CPU while the PC has a card: the picture says so, and High says it lost the sharpener', { timeout: 20_000 }, async () => {
  await withPane({ status: 'completed', result: { images: [{ b64_json: PNG }] } }, { device: 'cpu' }, async im => {
    const job = await draw(im, { quality: 'high' });
    assert.match(String(job.note), /CPU/);
    assert.match(String(job.note), /Quadro K1200/);
    assert.match(String(job.note), /sharpener/);
  });
});

test('a picture drawn for a linked PC carries its note there', { timeout: 20_000 }, async () => {
  await withPane({ status: 'completed', result: { images: [{ b64_json: PNG }] } }, { device: 'cpu' }, async im => {
    const job = await draw(im, { forPc: 'Main PC' });
    assert.match(String(im.takeAway(job.id)?.note), /CPU/);
  });
});

test('"Fits this PC" is not said of a model that only draws on that card with its weights in RAM', { timeout: 20_000 }, async () => {
  await withPane(noResults, {}, async im => {
    const fit = im.hardwareFit(im.registry.get('big'));
    assert.equal(fit.level, 'slow');
    assert.match(fit.text, /RAM/);
  }, BIG);
  await withPane(noResults, {}, async im => assert.equal(im.hardwareFit(im.registry.get('big')).level, 'ok'), SMALL);
});

test('a model already too big for the card goes straight to the CPU when the card fails', { timeout: 20_000 }, async () => {
  await withPane(noResults, {}, async (im, restarts) => {
    await draw(im);
    assert.deepEqual(restarts.map(r => r[2]), [['cpu']]);
  }, BIG);
});

test('the picture runner is never started on a model file whose path is too long for it', () => {
  const src = readFileSync(new URL('../src/images.ts', import.meta.url), 'utf8');
  assert.match(/async connect\([\s\S]*?const req: ConnectRequest/.exec(src)?.[0] ?? '', /tooLongPath\(/);
});
