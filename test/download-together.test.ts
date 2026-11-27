// Downloads at the same time (F19, F20): picture models downloaded together never spoil each other's files, a file two
// models share is downloaded once, a server that ends a file early or answers the wrong part is never written in, and a
// model sent from a linked PC never writes a file a download here is writing. Every server here is a stand-in on
// 127.0.0.1; nothing reaches the internet.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyWrote, copyDone, fetchChecked, writerOf } from '../src/download.ts';
import { Registry, type RegistryModel } from '../src/registry.ts';
import * as carry from '../src/carry.ts';

const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-dl-together-'));
  made.push(dir);
  return dir;
};
const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const KB = 1024;

interface Stand { base: string; gets: Map<string, number>; most: () => number }

/**
 * A stand-in file server: each file sent in small pieces with a pause between (so downloads overlap in time), with
 * Range answered as 206. `cut` names files whose answer ends half way with no fault; `wrongRange` files answer a range
 * from byte 0 while saying so.
 */
async function stand(files: Record<string, Buffer>, o: { cut?: string[]; wrongRange?: string[]; pauseMs?: number } = {}): Promise<Stand> {
  const gets = new Map<string, number>();
  let now = 0;
  let most = 0;
  const server = createServer(async (req, res) => {
    const name = decodeURIComponent((req.url ?? '/').slice(1));
    const data = files[name];
    if (!data) return res.writeHead(404).end();
    gets.set(name, (gets.get(name) ?? 0) + 1);
    now++;
    most = Math.max(most, now);
    res.on('close', () => now--);
    const range = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''));
    let from = range ? Number(range[1]) : 0;
    if (o.wrongRange?.includes(name) && range) from = 0;
    const body = data.subarray(from);
    const cut = o.cut?.includes(name);
    // A cut answer has no length, so its early end looks like a whole answer.
    res.writeHead(range ? 206 : 200, { ...(range ? { 'content-range': `bytes ${from}-${data.length - 1}/${data.length}` } : {}), ...(cut ? {} : { 'content-length': String(body.length) }) });
    const end = cut ? body.length >> 1 : body.length;
    for (let i = 0; i < end; i += 16 * KB) {
      if (res.destroyed) return;
      res.write(body.subarray(i, Math.min(end, i + 16 * KB)));
      await new Promise(r => setTimeout(r, o.pauseMs ?? 5));
    }
    res.end();
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, gets, most: () => most };
}

test('F20: three picture models downloaded together download one at a time, each file whole and checked, and a file two of them share is downloaded once', { timeout: 60_000 }, async () => {
  const big = { a: randomBytes(400 * KB), b: randomBytes(300 * KB), c: randomBytes(350 * KB), vae: randomBytes(64 * KB) };
  const s = await stand({ 'a.gguf': big.a, 'b.gguf': big.b, 'c.gguf': big.c, 'vae.safetensors': big.vae });
  const file = (name: string, role: 'diffusion' | 'vae', data: Buffer) => ({ role, url: `${s.base}${name}`, bytes: data.length, sha256: sha(data) });
  const model = (id: string, files: RegistryModel['files']): RegistryModel => ({ id, kind: 'image', name: id, about: '', licence: 'test', quant: 'Q8_0', minRamGB: 0, minVramGB: 0, files });
  const models = [
    model('one', [file('a.gguf', 'diffusion', big.a), file('vae.safetensors', 'vae', big.vae)]),
    model('two', [file('b.gguf', 'diffusion', big.b), file('vae.safetensors', 'vae', big.vae)]),
    model('three', [file('c.gguf', 'diffusion', big.c)]),
  ];
  const dir = tmp();
  const reg = new Registry(models, dir);
  const states = await Promise.all(['one', 'two', 'three'].map(id => reg.start(id)));
  // The ones asked for after the first wait their turn, and say so.
  assert.equal(states[0].waiting, undefined);
  assert.equal(states[1].waiting, true);
  assert.equal(states[2].waiting, true);
  for (let i = 0; i < 400 && !states.every(x => x.done || x.error); i++) await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(states.map(x => x.error), [null, null, null]);
  assert.ok(states.every(x => x.done));
  for (const [name, data] of [['a.gguf', big.a], ['b.gguf', big.b], ['c.gguf', big.c], ['vae.safetensors', big.vae]] as const) {
    assert.equal(sha(readFileSync(join(dir, 'image', name))), sha(data), `${name} is whole`);
  }
  assert.equal(s.most(), 1, 'one file was downloaded at a time');
  assert.equal(s.gets.get('vae.safetensors'), 1, 'the shared file was downloaded once');
});

test('F20: a stopped picture-model download that was waiting its turn says Stopped at once and never starts', { timeout: 60_000 }, async () => {
  const data = randomBytes(200 * KB);
  const s = await stand({ 'x.gguf': data, 'y.gguf': data });
  const model = (id: string, name: string): RegistryModel => ({ id, kind: 'image', name: id, about: '', licence: 'test', quant: 'Q8_0', minRamGB: 0, minVramGB: 0, files: [{ role: 'diffusion', url: `${s.base}${name}`, bytes: data.length, sha256: sha(data) }] });
  const reg = new Registry([model('x', 'x.gguf'), model('y', 'y.gguf')], tmp());
  const first = await reg.start('x');
  const second = await reg.start('y');
  reg.stop('y');
  assert.match(String(second.error), /^Stopped\./);
  for (let i = 0; i < 200 && !first.done && !first.error; i++) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(first.done, true);
  assert.equal(s.gets.get('y.gguf') ?? 0, 0);
});

test('F20: two downloads of the same file at once (from two places that share it) write it once, never into one .part together', { timeout: 60_000 }, async () => {
  const data = randomBytes(300 * KB);
  const s = await stand({ 'shared.safetensors': data });
  const dest = join(tmp(), 'shared.safetensors');
  const both = await Promise.all([1, 2].map(() => fetchChecked(`${s.base}shared.safetensors`, dest, data.length, sha(data))));
  assert.deepEqual(both.sort(), ['already', 'kept']);
  assert.equal(sha(readFileSync(dest)), sha(data));
  assert.equal(s.gets.get('shared.safetensors'), 1);
  assert.equal(writerOf(dest), null);
});

test('F20: a server that ends a file early with no fault keeps what came (never hashed and thrown away) and says to carry on', { timeout: 60_000 }, async () => {
  const data = randomBytes(256 * KB);
  const s = await stand({ 'cut.gguf': data }, { cut: ['cut.gguf'] });
  const dest = join(tmp(), 'cut.gguf');
  await assert.rejects(fetchChecked(`${s.base}cut.gguf`, dest, data.length, sha(data)), /stopped sending cut\.gguf part way.*carry on/);
  assert.equal(statSync(`${dest}.part`).size, data.length >> 1);
  assert.ok(!existsSync(dest));
});

test('F20: a part answer that does not start where the .part ends is not written in: the file starts again and is whole', { timeout: 60_000 }, async () => {
  const data = randomBytes(200 * KB);
  const s = await stand({ 'w.gguf': data }, { wrongRange: ['w.gguf'] });
  const dir = tmp();
  const dest = join(dir, 'w.gguf');
  writeFileSync(`${dest}.part`, data.subarray(0, 50 * KB));
  assert.equal(await fetchChecked(`${s.base}w.gguf`, dest, data.length, sha(data)), 'kept');
  assert.equal(sha(readFileSync(dest)), sha(data));
});

test('F19: a download of a file a linked PC is sending here now is refused in words, and goes ahead once the copy is done', { timeout: 60_000 }, async () => {
  const data = randomBytes(64 * KB);
  const s = await stand({ 'taesd.safetensors': data });
  const dest = join(tmp(), 'taesd.safetensors');
  copyWrote(dest);
  await assert.rejects(fetchChecked(`${s.base}taesd.safetensors`, dest, data.length, sha(data)), /linked PC is sending taesd\.safetensors/);
  copyDone(dest);
  assert.equal(await fetchChecked(`${s.base}taesd.safetensors`, dest, data.length, sha(data)), 'kept');
});

test('F19: a picture model sent from a linked PC waits while this PC downloads a file of it (shared with another model), and its .part is left alone', { timeout: 60_000 }, async () => {
  const taesd = randomBytes(400 * KB);
  const s = await stand({ 'taesd.safetensors': taesd }, { pauseMs: 20 });
  const root = tmp();
  const imageDir = join(root, 'models', 'image');
  mkdirSync(imageDir, { recursive: true });
  const dest = join(imageDir, 'taesd.safetensors');
  const pictures = [{ name: 'taesd.safetensors', bytes: taesd.length, sha256: sha(taesd) }];
  const handle = carry.nodeSide({
    allow: () => ({ pull: true, backup: true, update: false, tune: false, lend: false, receive: true, give: false, off: true }),
    shared: () => [],
    pcName: () => 'Worker PC',
    chatFiles: () => null,
    pictureFiles: () => null,
    chatDir: join(root, 'models', 'chat'),
    chatHas: () => false,
    pictureDest: () => pictures.map(f => ({ ...f, path: join(imageDir, f.name), have: existsSync(join(imageDir, f.name)) })),
    keptRoot: join(root, 'kept'),
    freeBytes: async () => Infinity,
    onInstalled: () => undefined,
  });
  const laptop = { key: 'b1b2b3b4', name: 'Laptop' };
  const ask = { kind: 'image', model: 'sd15', name: 'SD 1.5', files: pictures.map(f => ({ name: f.name, bytes: f.bytes })) };
  const downloading = fetchChecked(`${s.base}taesd.safetensors`, dest, taesd.length, sha(taesd));
  for (let i = 0; i < 100 && !existsSync(`${dest}.part`); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(writerOf(dest), 'download');
  const offer = await handle('/worker/carry-offer', ask, laptop);
  assert.equal(offer.status, 409);
  assert.match(String('json' in offer ? offer.json.error : ''), /downloading taesd\.safetensors now.*Send it again/);
  const put = await handle('/worker/carry-put', { ...ask, file: 0, from: 0 }, laptop, taesd.subarray(0, 16 * KB));
  assert.equal(put.status, 409);
  // A stopped send's tidy-up leaves the download's .part.
  await handle('/worker/carry-drop', ask, laptop);
  assert.equal(await downloading, 'kept');
  assert.equal(sha(readFileSync(dest)), sha(taesd));
});
