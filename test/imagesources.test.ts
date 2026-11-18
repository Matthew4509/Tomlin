// Image sources: <name>.source.json beside each picture says how it was made, a picture a linked PC drew comes back
// with its real seed, steps and sampler (they used to be saved as 0, 0 and nothing), and a folder's sources can be
// read and drawn again, with the picture file there or not. Against a made-up runner. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { Images } from '../src/images.ts';
import { Gallery, type Picture } from '../src/gallery.ts';
import { Store } from '../src/store.ts';
import { cleanMade, cleanSource, cropBox, ignoreSources, readSources, sourceName, sourceOf, writeSource, IGNORE_LINE } from '../src/sources.ts';

const PNG = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#336699' } }).png().toBuffer();
const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

/** An Images pane on a made-up runner that answers every picture at once and keeps what it was asked. */
async function withImages(fn: (r: { im: any; dir: string; asked: Record<string, any>[] }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-imagesources-'));
  mkdirSync(join(dir, 'registry'));
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'registry', 'fake.json'), JSON.stringify({ id: 'fake', kind: 'image', name: 'Fake (4 steps)', about: '', licence: 'made-up licence', quant: '', minRamGB: 0, minVramGB: 0, native: 512, files: [{ role: 'model', path: 'fake.gguf', bytes: 1, sha256: 'x' }], defaults: { steps: 4, cfg: 1, sampler: 'euler_a', scheduler: 'karras', negative: 'blurry' } }));
  const asked: Record<string, any>[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const parts: Buffer[] = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      if (req.url!.includes('img_gen')) {
        asked.push(JSON.parse(Buffer.concat(parts).toString('utf8')));
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'one' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'completed', result: { images: [{ b64_json: PNG.toString('base64') }] } }));
    });
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const im: any = new Images({ root: dir, models: join(dir, 'models'), data: join(dir, 'data'), store: new Store(join(dir, 'data')), runtimes: {}, hardware: { gpus: [], ram: 8 * 2 ** 30 }, sampler: {}, chatPane: { view: { state: 'disconnected' } }, devicesFor: () => ['cpu'], fit: () => ({ level: 'ok', need: 1, free: 1e10, otherOn: false }), version: '9.9.9' } as any);
  Object.assign(im.pane.view, { state: 'connected', model: 'fake', device: 'cpu', asked: 'cpu' });
  Object.defineProperty(im.pane.worker, 'base', { get: () => base, configurable: true });
  im.decoder = 'full';
  try {
    await fn({ im, dir, asked });
  } finally {
    server.closeAllConnections();
    await new Promise(ok => server.close(ok));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const MADE = { seed: 123456, steps: 6, cfg: 1.5, sampler: 'euler_a', scheduler: 'karras', negative: 'blurry', generated: { width: 512, height: 512 }, target: { width: 512, height: 512 }, fit: 'crop', draft: false, model: 'dreamshaper-8', modelFile: 'dreamshaper-8.gguf', licence: 'CreativeML OpenRAIL-M', tomlin: '2.0.82' };
const sourceBeside = (im: any, p: Picture) => JSON.parse(readFileSync(join(im.gallery.dir, sourceName(p.output)), 'utf8'));

test('a picture a linked PC drew is saved with the seed, steps and sampler it was drawn with', async () => {
  await withImages(async ({ im }) => {
    const p: Picture = await im.receive({ png: PNG, prompt: 'a red boat', modelPrompt: 'a red boat, photo', mode: 'blog', modelName: 'DreamShaper 8', pc: 'Worker PC', seconds: 3, made: MADE });
    assert.equal(p.seed, 123456);
    assert.equal(p.steps, 6);
    assert.equal(p.cfg, 1.5);
    assert.equal(p.sampler, 'euler_a');
    assert.equal(p.scheduler, 'karras');
    assert.equal(p.negative, 'blurry');
    assert.ok(!p.settingsUnknown);
    const s = sourceBeside(im, p);
    assert.equal(s.seed, 123456);
    assert.equal(s.settings, 'known');
    assert.equal(s.modelFile, 'dreamshaper-8.gguf');
    assert.equal(s.licence, 'CreativeML OpenRAIL-M');
    assert.equal(s.tomlin, '2.0.82');
    assert.equal(s.drawnOn, 'on Worker PC');
    assert.equal(s.file, p.output.split('/').pop());
  });
});

test('an older linked PC that sends no settings gives "settings unknown", and Draw again, same seed is refused', async () => {
  await withImages(async ({ im, asked }) => {
    const p: Picture = await im.receive({ png: PNG, prompt: 'a red boat', modelPrompt: 'a red boat', mode: 'blog', modelName: 'DreamShaper 8', pc: 'Worker PC', seconds: 3 });
    assert.equal(p.settingsUnknown, true);
    assert.equal(sourceBeside(im, p).settings, 'unknown');
    for (const o of [{ again: p.id }, { finalOf: p.id }]) {
      const r = await im.generate({ prompt: '', source: 'page', ...o });
      assert.ok(!('id' in r), 'nothing is drawn');
      assert.equal(r.status, 409);
      assert.match(r.error, /settings .* are not known/);
    }
    assert.equal(asked.length, 0);
    // Junk in place of the settings is the same as none.
    const q: Picture = await im.receive({ png: PNG, prompt: 'a red boat', modelPrompt: '', mode: 'blog', modelName: '', pc: 'Worker PC', seconds: 1, made: cleanMade({ seed: 'seven', steps: 4 }) });
    assert.equal(q.settingsUnknown, true);
  });
});

test('a picture drawn here for a linked PC goes back with how it was made', async () => {
  await withImages(async ({ im, asked }) => {
    const job = await im.generate({ prompt: 'a red boat on a lake', source: 'api', drafts: 1, seed: 77, forPc: 'Front desk' });
    await job.done;
    assert.equal(job.state, 'done', job.error);
    const pic = im.takeAway(job.id);
    assert.equal(pic.made.seed, 77);
    assert.equal(pic.made.steps, asked[0].sample_params.sample_steps);
    assert.equal(pic.made.sampler, 'euler_a');
    assert.equal(pic.made.scheduler, 'karras');
    assert.equal(pic.made.model, 'fake');
    assert.equal(pic.made.modelFile, 'fake.gguf');
    assert.equal(pic.made.licence, 'made-up licence');
    assert.equal(pic.made.tomlin, '9.9.9');
    assert.deepEqual(cleanMade(JSON.parse(JSON.stringify(pic.made))), pic.made, 'it passes the asking PC\'s check as it is');
  });
});

test('the settings go all the way from the PC that drew to the gallery of the PC that asked', () => {
  const node = read('jobrun/node.ts');
  assert.equal(node.match(/send\('picture', \{[^}]*made: r\.made/g)?.length, 2, 'both ways a node draws');
  // A picture a linked PC hands back (now or after the host was away) is checked where it is taken (src/jobrun/pictureback.ts).
  assert.match(read('jobrun/pictureback.ts'), /made: cleanMade\(data\.made\)/);
  const pictures = read('server/pictures.ts');
  assert.equal(pictures.match(/images\.receive\(\{[^}]*made: got\.made/g)?.length, 2, 'the Images window and the queue');
  assert.match(/export async function drawForPc\([\s\S]*?\n\}/.exec(pictures)![0], /made: pic\.made/);
});

test('a picture drawn here has its source beside it, and it goes when the picture is deleted', async () => {
  await withImages(async ({ im }) => {
    const job = await im.generate({ prompt: 'a red boat on a lake 256x128', source: 'api', full: true, seed: 5 });
    await job.done;
    assert.equal(job.state, 'done', job.error);
    const p: Picture = job.results[0];
    const s = sourceBeside(im, p);
    assert.equal(s.seed, 5);
    assert.equal(s.steps, 4);
    assert.equal(s.sampler, 'euler_a');
    assert.equal(s.scheduler, 'karras');
    assert.equal(s.model, 'fake');
    assert.equal(s.modelFile, 'fake.gguf');
    assert.equal(s.licence, 'made-up licence');
    assert.equal(s.tomlin, '9.9.9');
    assert.equal(s.prompt, 'a red boat on a lake 256x128');
    assert.deepEqual(s.target, { width: 256, height: 128 });
    assert.deepEqual(s.crop, cropBox(p.generated, p.target, 'crop'));
    assert.doesNotMatch(JSON.stringify(s), /[a-z]:\\\\|\/Users\/|tomlin-imagesources/i, 'no folder paths');
    await im.gallery.remove(p.id);
    assert.ok(!existsSync(join(im.gallery.dir, sourceName(p.output))));
  });
});

test('a source is drawn again with the same seed and settings, or with a new seed', async () => {
  await withImages(async ({ im, asked }) => {
    const src = cleanSource({ ...MADE, file: 'boat.png', prompt: 'a red boat', modelPrompt: 'a red boat, exactly these words', mode: 'blog', modelName: 'DreamShaper 8', at: '2026-11-01T10:00:00.000Z', settings: 'known' })!;
    const same = await im.generate({ prompt: '', source: 'page', chat: 'c1', fromSource: src });
    await same.done;
    assert.equal(same.state, 'done', same.error);
    assert.equal(asked[0].seed, 123456);
    assert.equal(asked[0].prompt, 'a red boat, exactly these words');
    assert.equal(asked[0].negative_prompt, 'blurry');
    assert.equal(asked[0].sample_params.sample_steps, 6);
    assert.equal(asked[0].sample_params.guidance.txt_cfg, 1.5);
    assert.equal(same.results[0].chat, 'c1', 'in the chat that asked');
    assert.match(same.note, /Fake.*DreamShaper 8/, 'another model than the one it was made with: said');
    const fresh = await im.generate({ prompt: '', source: 'page', fromSource: src, newSeed: true });
    await fresh.done;
    assert.equal(asked[1].sample_params.sample_steps, 6);
    assert.notEqual(asked[1].seed, 123456);
    // Settings unknown: the words and the size are all there is, so it is drawn as a new picture; same seed is refused.
    const unknown = cleanSource({ file: 'old.png', prompt: 'a green boat', mode: 'blog', target: { width: 512, height: 512 } })!;
    assert.equal(unknown.settings, 'unknown');
    const no = await im.generate({ prompt: '', source: 'page', fromSource: unknown });
    assert.equal(no.status, 409);
    const yes = await im.generate({ prompt: '', source: 'page', fromSource: unknown, newSeed: true, drafts: 1 });
    await yes.done;
    assert.equal(yes.state, 'done', yes.error);
    assert.match(asked[2].prompt, /a green boat/);
  });
});

test('sources are checked when read: what is not one is left out, and nothing in one is trusted', () => {
  assert.equal(cleanSource(null), null);
  assert.equal(cleanSource({ prompt: 'a boat' }), null, 'no file named');
  assert.equal(cleanSource({ file: '..\\..\\secrets.png', prompt: 'a boat' }), null, 'a folder path is not a file name');
  assert.equal(cleanSource({ file: 'a.png', prompt: '   ' }), null);
  const s = cleanSource({ ...MADE, file: 'a.png', prompt: 'a boat', mode: 'made-up', sampler: 'euler_a; rm', at: 'not a date' })!;
  assert.equal(s.settings, 'unknown', 'a sampler that is not one: the settings are not believed');
  assert.equal(s.mode, 'custom');
  assert.equal(s.at, '');
  assert.equal(cleanMade({ ...MADE, steps: 0 }), null);
  assert.equal(cleanMade({ ...MADE, generated: { width: 1e9, height: 512 } }), null);
  assert.equal(cleanMade({ ...MADE, modelFile: 'C:\\models\\x.gguf' })!.modelFile, '', 'a path is not a file name');
  assert.equal(sourceName('boat-512x512.png'), 'boat-512x512.png.source.json');
  assert.equal(sourceName('2026-11 boat.webp'), '2026-11 boat.webp.source.json');
  assert.deepEqual(cropBox({ width: 512, height: 512 }, { width: 512, height: 256 }, 'crop'), { left: 0, top: 128, width: 512, height: 256 });
  assert.equal(cropBox({ width: 512, height: 512 }, { width: 256, height: 256 }, 'crop'), null);
  assert.equal(cropBox({ width: 512, height: 512 }, { width: 512, height: 256 }, 'pad'), null);
});

test('a folder\'s sources are read newest first, with the picture file there or gone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-readsources-'));
  try {
    const images = join(dir, 'site', 'specialists', 'images');
    mkdirSync(images, { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    const pic = (file: string, at: string): Picture => ({ id: file, at, prompt: `a boat ${file}`, modelPrompt: '', negative: '', mode: 'blog', model: 'm', modelName: 'M', seed: 9, steps: 4, cfg: 1, sampler: 'euler_a', generated: { width: 512, height: 512 }, target: { width: 512, height: 512 }, fit: 'crop', device: 'cpu', seconds: 1, draft: false, original: `2026-11/${file}`, output: `2026-11/${file}`, format: 'png', bytes: 1 });
    await writeSource(images, sourceOf(pic('old.png', '2026-11-01T10:00:00.000Z')));
    await writeSource(images, sourceOf(pic('new.png', '2026-11-02T10:00:00.000Z')));
    writeFileSync(join(images, 'new.png'), PNG);
    writeFileSync(join(images, 'broken.source.json'), '{ not json');
    await writeSource(join(dir, 'node_modules', 'x'), sourceOf(pic('lib.png', '2026-11-03T10:00:00.000Z')));
    const r = await readSources(dir);
    assert.deepEqual(r.sources.map(s => s.path), ['site/specialists/images/new.png.source.json', 'site/specialists/images/old.png.source.json']);
    assert.deepEqual(r.sources.map(s => s.pictureThere), [true, false]);
    assert.equal(r.sources[1].seed, 9);
    assert.equal(r.damaged, 1);
    assert.equal(r.more, false);
    assert.equal((await readSources(dir, 1)).more, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git is told to leave image sources out of a project, once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-ignoresources-'));
  try {
    assert.equal(await ignoreSources(dir), true, 'no .gitignore yet: one is made');
    assert.ok(readFileSync(join(dir, '.gitignore'), 'utf8').split('\n').includes(IGNORE_LINE));
    assert.equal(await ignoreSources(dir), false, 'already there');
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\r\ndist/');
    assert.equal(await ignoreSources(dir), true);
    const now = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.ok(now.startsWith('node_modules/\r\ndist/\r\n'), 'what was there stays, with its own line ends');
    assert.equal(now.split('\r\n').filter(l => l === IGNORE_LINE).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TOMLIN\'s own .gitignore leaves image sources out too', () => {
  assert.ok(readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split(/\r?\n/).includes(IGNORE_LINE));
});

test('a draft added to the gallery while old drafts are being cleared is not deleted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-cleardrafts-'));
  try {
    const g = new Gallery(dir);
    const old = '2026-01-01T10:00:00.000Z';
    const ids = ['a', 'b', 'c'];
    for (const id of ids) {
      const rel = await g.save(`${id}.png`, PNG);
      await g.add({ id, at: old, prompt: `a boat ${id}`, modelPrompt: '', negative: '', mode: 'blog', model: 'm', modelName: 'M', seed: 1, steps: 4, cfg: 1, sampler: 'euler_a', generated: { width: 512, height: 512 }, target: { width: 512, height: 512 }, fit: 'crop', device: 'cpu', seconds: 1, draft: true, original: rel, output: rel, format: 'png', bytes: 1, kept: false });
    }
    // The sweep starts, and the last draft is added to the gallery before the sweep reaches it.
    const sweep = g.clearDrafts(7);
    const kept = g.keep('c', true);
    assert.equal(await sweep, 2);
    await kept;
    const c = (await g.get('c'))!;
    assert.equal(c.kept, true);
    assert.ok(!c.removed, 'it is still listed');
    assert.ok(existsSync(join(dir, c.output)), 'and its file is still there');
    assert.ok(!existsSync(join(dir, dirname(c.output), 'a.png')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
