// Sending a video model, and the runner that makes video, to a linked PC (src/carry.ts, src/videomodels.ts,
// src/runnerpush.ts): the files come from this PC's video Registry, all of them, whole only; they land where that PC's own
// video Registry expects them (models/video), checked by size and SHA-256, and the model then shows as downloaded there.
// The node's "Accept models from linked PCs" tick and low-disk refusal apply as for chat and picture models. Driven
// through the node's doors in this process, as test/carry.test.ts and test/runnerpush.test.ts do.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as carry from '../src/carry.ts';
import { Registry } from '../src/registry.ts';
import { Runtimes } from '../src/runtimes.ts';
import * as rp from '../src/runnerpush.ts';
import { findVideoExe } from '../src/video.ts';
import { videoReceiveDest, videoRegistryModels, videoSendFiles, type VideoModel } from '../src/videomodels.ts';

const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-videosend-'));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const MB = 2 ** 20;
const laptop = { key: 'b1b2b3b4', name: 'Laptop' };
const ALLOW: carry.Allow = { pull: false, backup: false, update: false, tune: false, lend: false, receive: true, give: false, off: true };
const size = (p: string) => {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
};

/** A small stand-in video model (three files, one bigger than a 16 MB piece) and its bytes. */
function aVideoModel() {
  const data = { diffusion: randomBytes(17 * MB + 5), vae: randomBytes(300_000), textenc: randomBytes(1_000_001) };
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const rev = { repo: 'test/wan', rev: 'abc' };
  const model: VideoModel = {
    id: 'wan-test', name: 'Wan test (small)', about: '', licence: 'Apache-2.0', source: 'https://example.invalid', quant: 'fp16', vramGB: 8, vramMeasured: false, minRamGB: 16, startPicture: false,
    files: [
      { role: 'diffusion', ...rev, path: 'split_files/diffusion_models/wan-test.safetensors', bytes: data.diffusion.length, sha256: sha(data.diffusion) },
      { role: 'vae', ...rev, path: 'split_files/vae/wan-vae.safetensors', bytes: data.vae.length, sha256: sha(data.vae) },
      { role: 'textenc', ...rev, path: 'umt5-test.gguf', bytes: data.textenc.length, sha256: sha(data.textenc) },
    ],
  };
  return { model, data, reg: (dir: string) => new Registry(videoRegistryModels([model]), dir) };
}

/** This PC with the model downloaded (all its files in models/video), or only some of them. */
function thisPc(v: ReturnType<typeof aVideoModel>, o: { leaveOut?: 'vae' } = {}) {
  const dir = tmp();
  const reg = v.reg(dir);
  const m = reg.get(v.model.id)!;
  mkdirSync(join(dir, 'video'), { recursive: true });
  for (const f of m.files) if (f.role !== o.leaveOut) writeFileSync(reg.ownPath(m, f), v.data[f.role as keyof typeof v.data]);
  return { dir, reg };
}

/** A linked PC with its own video Registry (nothing downloaded), and a wire to it as this PC sees it. */
function aNode(v: ReturnType<typeof aVideoModel>, o: { allow?: carry.Allow; free?: number; noVideo?: boolean } = {}) {
  const dir = tmp();
  const reg = v.reg(dir);
  const installed: { name: string; kind: string; id: string }[] = [];
  const handle = carry.nodeSide({
    allow: () => o.allow ?? ALLOW,
    shared: () => [],
    pcName: () => 'Worker PC',
    chatFiles: () => null,
    pictureFiles: () => null,
    chatDir: join(dir, 'chat'),
    chatHas: () => false,
    pictureDest: () => null,
    ...(o.noVideo ? {} : { videoDest: (id: string) => videoReceiveDest(reg, id, size) }),
    keptRoot: join(dir, 'kept'),
    freeBytes: async () => o.free ?? Infinity,
    onInstalled: (name, model) => installed.push({ name, ...model }),
  });
  const wire: carry.Wire = {
    ask: async (p, b) => {
      const a = await handle(p, b, laptop);
      if (!('json' in a)) throw new Error('a piece came where words were expected');
      if (a.status !== 200) throw new Error(String(a.json.error));
      return a.json;
    },
    getPiece: async () => {
      throw new Error('nothing is read back from the node in a send');
    },
    putPiece: async (p, b, piece) => {
      const a = await handle(p, b, laptop, piece);
      if (!('json' in a)) throw new Error('a piece came where words were expected');
      if (a.status !== 200 && !(a.status === 409 && typeof a.json.at === 'number')) throw new Error(String(a.json.error));
      return a.json;
    },
  };
  return { dir, reg, wire, installed };
}

const push = (w: carry.Wire, files: carry.FileRef[], model = 'wan-test') => carry.push(w, { kind: 'video', model, name: 'Wan test', files, progress: () => undefined, signal: new AbortController().signal });

test('a video model is sent whole: every file of it, from the video Registry; none while one file is missing here', () => {
  const v = aVideoModel();
  const here = thisPc(v);
  const files = videoSendFiles(here.reg, 'wan-test');
  assert.deepEqual(files?.map(f => f.name), ['wan-test.safetensors', 'wan-vae.safetensors', 'umt5-test.gguf']);
  assert.deepEqual(files?.map(f => f.path), ['wan-test.safetensors', 'wan-vae.safetensors', 'umt5-test.gguf'].map(n => join(here.dir, 'video', n)));
  assert.equal(videoSendFiles(thisPc(v, { leaveOut: 'vae' }).reg, 'wan-test'), null);
  assert.equal(videoSendFiles(here.reg, 'not-a-model'), null);
});

test('sent to a linked PC: it lands in models/video there, checked, and shows as downloaded in that PC\'s own Registry; sent again, nothing crosses', async () => {
  const v = aVideoModel();
  const here = thisPc(v);
  const node = aNode(v);
  const m = node.reg.get('wan-test')!;
  assert.equal(node.reg.installed(m), false);
  assert.equal(await push(node.wire, videoSendFiles(here.reg, 'wan-test')!), true);
  for (const f of m.files) assert.ok(readFileSync(join(node.dir, 'video', node.reg.fileName(f))).equals(v.data[f.role as keyof typeof v.data]), f.role);
  assert.equal(node.reg.installed(m), true);
  assert.deepEqual(node.installed, [{ name: 'Wan test', kind: 'video', id: 'wan-test' }]);
  assert.equal(await push(node.wire, videoSendFiles(here.reg, 'wan-test')!), false);
});

test('a video file whose bytes are not the ones the registry names (same size) is thrown away there, not put in place', async () => {
  const v = aVideoModel();
  const here = thisPc(v);
  const node = aNode(v);
  const files = videoSendFiles(here.reg, 'wan-test')!;
  const bad = join(tmp(), 'bad-vae.safetensors');
  const changed = Buffer.from(v.data.vae);
  changed[10] ^= 1;
  writeFileSync(bad, changed);
  await assert.rejects(push(node.wire, files.map(f => (f.name === 'wan-vae.safetensors' ? { ...f, path: bad } : f))), /SHA-256 differs/);
  assert.ok(!existsSync(join(node.dir, 'video', 'wan-vae.safetensors')));
  assert.ok(!existsSync(join(node.dir, 'video', 'wan-vae.safetensors.part')));
  assert.equal(node.reg.installed(node.reg.get('wan-test')!), false);
  assert.deepEqual(node.installed, []);
});

test('refused: without "Accept models from linked PCs", with too little room, a model it does not know, another version, an older TOMLIN', async () => {
  const v = aVideoModel();
  const files = videoSendFiles(thisPc(v).reg, 'wan-test')!;
  await assert.rejects(push(aNode(v, { allow: { ...ALLOW, receive: false } }).wire, files), /Accept models from linked PCs/);
  await assert.rejects(push(aNode(v, { free: 5 * MB }).wire, files), /not enough room on "Worker PC"/);
  await assert.rejects(push(aNode(v).wire, files, 'wan-other'), /does not know that video model/);
  await assert.rejects(push(aNode(v).wire, files.map((f, k) => (k === 1 ? { ...f, bytes: f.bytes + 1 } : f))), /another version of that video model/);
  // A node without the video door (an older TOMLIN's wiring) says it does not know the model; nothing goes to its chat folder.
  const old = aNode(v, { noVideo: true });
  await assert.rejects(push(old.wire, files), /does not know that video model/);
  assert.ok(!existsSync(join(old.dir, 'chat')));
});

test('which linked PCs can take a video model: as any send, and only a TOMLIN that says it takes video models', () => {
  const pc = (o: Partial<carry.NetPc> = {}): carry.NetPc => ({ id: 'aaaa1111', name: 'Z820', ok: true, away: null, can: ['carry', 'receive', carry.VIDEO_CARRY], allow: ALLOW, models: [], ...o });
  assert.equal(carry.sendVideoWhy(pc()), '');
  assert.match(carry.sendVideoWhy(pc({ allow: { ...ALLOW, receive: false } })), /Accept models from linked PCs/);
  assert.match(carry.sendVideoWhy(pc({ ok: false })), /off or not answering/);
  assert.match(carry.sendVideoWhy(pc({ can: ['carry', 'receive'] })), /older TOMLIN that cannot take a video model/);
  assert.equal(carry.sendWhy(pc({ can: ['carry', 'receive'] })), '', 'chat and picture sends are not changed');
  assert.equal(carry.carryKind('video'), 'video');
  assert.equal(carry.carryKind('image'), 'image');
  assert.equal(carry.carryKind('x'), 'chat');
  assert.equal(carry.modelKey('video', 'wan-test'), 'video:wan-test');
});

// ---- The runner that makes video (stable-diffusion.cpp's CUDA build, sd-cuda) ----

const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

/** Two stand-in zips of the sd CUDA build (its server, its sd-cli that makes video, the CUDA DLLs), and a runtimes.json pinning them. */
function sdZips(dir: string) {
  const make = (name: string, files: Record<string, Buffer | string>) => {
    const src = join(dir, `${name}-files`);
    mkdirSync(src, { recursive: true });
    for (const [f, data] of Object.entries(files)) writeFileSync(join(src, f), data);
    const path = join(dir, name);
    execFileSync(tar, ['-a', '-c', '-f', path, '-C', src, ...Object.keys(files)], { windowsHide: true });
    const data = readFileSync(path);
    return { name, path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  };
  const exe = (n: string) => (process.platform === 'win32' ? `${n}.exe` : n);
  const parts = [make('sd-test-bin-win-cuda12-x64.zip', { [exe('sd-server')]: 'a stand-in server', [exe('sd-cli')]: 'a stand-in cli' }), make('cudart-sd-test.zip', { 'cudart64_12.dll': randomBytes(50_000) })];
  const pins = {
    runtimes: {
      'llama-cuda': { engine: 'llama', device: 'cuda', name: 'llama.cpp test, CUDA', licence: 'MIT', parts: [{ url: 'https://example.invalid/l.zip', bytes: 1, sha256: '0'.repeat(64) }] },
      'sd-cuda': { engine: 'sd', device: 'cuda', name: 'stable-diffusion.cpp test, CUDA', licence: 'MIT', parts: parts.map(p => ({ url: `https://example.invalid/${p.name}`, bytes: p.bytes, sha256: p.sha256 })) },
    },
  };
  return { parts, pins };
}

test('the video runner (sd-cuda) is sent to a linked PC as the chat runners are: checked, unpacked, and found there as the program that makes video', async () => {
  const z = sdZips(tmp());
  const root = tmp();
  writeFileSync(join(root, 'runtimes.json'), JSON.stringify(z.pins));
  const runtimes = new Runtimes(join(root, 'app-runtime'), join(root, 'runtimes.json'), join(root, 'home-runtime'));
  const side = rp.runnerSide({ runtimes, pcName: () => 'Z820', why: () => '', freeBytes: async () => Infinity });
  const json = (a: carry.NodeAnswer) => {
    if (!('json' in a)) throw new Error('a piece came where words were expected');
    if (a.status !== 200 && !(a.status === 409 && typeof a.json.at === 'number')) throw new Error(String(a.json.error));
    return a.json;
  };
  const wire: carry.Wire = { ask: async (p, b) => json(await side.handle(p, b, laptop)), getPiece: async () => Buffer.alloc(0), putPiece: async (p, b, piece) => json(await side.handle(p, b, laptop, piece)) };
  assert.equal(findVideoExe(runtimes), null);
  assert.equal(await rp.pushRunner(wire, { id: 'sd-cuda', files: z.parts.map(p => ({ path: p.path, bytes: p.bytes, sha256: p.sha256 })), progress: () => undefined, signal: new AbortController().signal, every: 20 }), 'sent');
  assert.equal(side.state('sd-cuda').state, 'installed');
  const found = findVideoExe(runtimes);
  assert.equal(found?.pin, 'sd-cuda');
  assert.equal(found?.device, 'cuda');
  assert.ok(found?.exe.endsWith(process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli'));
});

test('a node\'s hello says how its video runner is, and this PC can tell whether to send it', () => {
  const hello = rp.cleanRunner({ nvidia: true, driver: '580.10', why: '', cuda: 'installed', pins: { 'llama-cuda': { state: 'installed', why: '' }, 'llama-cuda13': { state: 'none', why: '' }, 'llama-cuda-b10750': { state: 'none', why: '' }, 'llama-cuda3': { state: 'none', why: '' }, 'sd-cuda': { state: 'none', why: '' }, 'sd-rocm': { state: 'none', why: '' } }, said: '', last: null });
  assert.deepEqual(hello?.pins?.['sd-cuda'], { state: 'none', why: '' }, 'kept beside four chat builds');
  assert.equal(hello?.pins?.['sd-rocm'], undefined);
  const pc = { name: 'Z820', ok: true, away: null, can: ['runner'], runner: hello };
  assert.equal(rp.sendRunnerWhy(pc, 'sd-cuda'), '');
  assert.match(rp.sendRunnerWhy({ ...pc, runner: { ...hello!, pins: { ...hello!.pins, 'sd-cuda': { state: 'installed', why: '' } } } }, 'sd-cuda'), /already has it/);
  // An older TOMLIN does not name the video runner in its hello: it is told to update first.
  assert.match(rp.sendRunnerWhy({ ...pc, runner: { ...hello!, pins: { 'llama-cuda': { state: 'installed', why: '' } } } }, 'sd-cuda'), /older TOMLIN that does not know this runner/);
});
