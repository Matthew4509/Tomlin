// The video runner (src/video.ts): the sd-cli flags, progress read from its step bar, and a plain sentence for each way
// a clip can end (not installed, a missing model, low disk, busy, Stop, a crash, out of memory, a start that fails). A
// stand-in process plays the runner, so no graphics card or model is needed. Also the test door and test/fakevideo.ts.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { cleanJob, findVideoExe, folderResolver, framesFor, SdVideoRunner, stepsOf, videoArgs, videoBusy, videoRunnerFacts, VideoTestDoor, VIDEO_WORDS, type VideoDeps, type VideoChild, type VideoModelFiles } from '../src/video.ts';
import { VideoFault, LOW_DISK_BYTES, type VideoJob, type VideoProgress } from '../src/videotypes.ts';
import { FakeVideoRunner } from './fakevideo.ts';

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');
const tmp = () => mkdtempSync(join(tmpdir(), 'tomlin-video-'));

function modelFiles(dir: string): VideoModelFiles {
  const files = { name: 'Wan test', diffusion: join(dir, 'wan.gguf'), vae: join(dir, 'wan_vae.safetensors'), textEncoder: join(dir, 'umt5.gguf') };
  for (const f of [files.diffusion, files.vae, files.textEncoder]) writeFileSync(f, 'x');
  return files;
}

/** A stand-in sd-cli: its output streams, and an end that writes the clip (or not) and exits as told. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & VideoChild & { killed: boolean };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { pid: 4242, stdout, stderr, exitCode: null, signalCode: null, killed: false });
  child.kill = () => {
    (child as { killed: boolean }).killed = true;
    return true;
  };
  const end = (code: number | null, signal: string | null = null) => {
    Object.assign(child, { exitCode: code, signalCode: signal });
    child.emit('exit', code, signal);
    stdout.end();
    stderr.end();
    setImmediate(() => child.emit('close', code, signal));
  };
  return { child, stdout, stderr, end };
}

interface Rig {
  deps: VideoDeps;
  args: string[][];
  kids: ReturnType<typeof fakeChild>[];
  out: string;
}

function rig(o: { exe?: boolean; files?: VideoModelFiles | null; free?: number | null; script?: (k: ReturnType<typeof fakeChild>, args: string[]) => void; startThrows?: boolean } = {}): Rig {
  const dir = tmp();
  const files = o.files === undefined ? modelFiles(dir) : o.files;
  const out = join(dir, 'clips');
  const args: string[][] = [];
  const kids: ReturnType<typeof fakeChild>[] = [];
  const deps: VideoDeps = {
    findExe: () => (o.exe === false ? null : { exe: join(dir, 'sd-cli.exe'), device: 'cuda', pin: 'sd-cuda' }),
    resolve: async () => files,
    outDir: out,
    freeBytes: async () => (o.free === undefined ? 100 * 2 ** 30 : o.free),
    start: (_exe, a) => {
      if (o.startThrows) throw new Error('spawn EACCES');
      args.push(a);
      const k = fakeChild();
      kids.push(k);
      setImmediate(() => o.script?.(k, a));
      return k.child;
    },
    killTree: async c => {
      c.kill();
      const k = kids.find(x => x.child === c);
      k?.end(null, 'SIGTERM');
    },
    now: () => Date.now(),
  };
  return { deps, args, kids, out };
}

const job = (over: Partial<VideoJob> = {}): VideoJob => ({ prompt: 'A cat on a wall', seconds: 2, width: 480, height: 272, quality: 'draft', model: 'wan-1.3b', ...over });
const outOf = (a: string[]) => a[a.indexOf('-o') + 1];
const faultOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof VideoFault, `a VideoFault, not ${e}`);
    return e;
  }
  assert.fail('it should have failed');
};
const go = () => new AbortController();

test('frames: Wan wants 4n+1, 81 for 5 seconds at 16 a second', () => {
  assert.equal(framesFor(5, 16), 81);
  assert.equal(framesFor(2, 16), 33);
  assert.equal(framesFor(1, 16), 17);
  assert.equal((framesFor(3, 24) - 1) % 4, 0);
});

test('a job is cleaned: seconds 1 to 5, sides a multiple of 16, a known quality', () => {
  const j = cleanJob(job({ seconds: 99, width: 1000, height: 50, quality: 'super' as never, prompt: '  hi  ' }));
  assert.equal(j.seconds, 5);
  assert.equal(j.width % 16, 0);
  assert.equal(j.height, 128);
  assert.equal(j.quality, 'normal');
  assert.equal(j.prompt, 'hi');
  assert.equal(cleanJob(job({ seconds: 0 })).seconds, 1);
});

test('the sd-cli flags: video mode, the three model files, frames, size, steps, a .webm out; card extras only on a card', () => {
  const f = { name: 'w', diffusion: 'D.gguf', vae: 'V.safetensors', textEncoder: 'T.gguf' };
  const a = videoArgs(cleanJob(job({ seconds: 5, quality: 'normal', seed: 7 })), f, 'C:\\out\\clip.webm', 'cuda');
  const at = (flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(at('-M'), 'vid_gen');
  assert.equal(at('--diffusion-model'), 'D.gguf');
  assert.equal(at('--vae'), 'V.safetensors');
  assert.equal(at('--t5xxl'), 'T.gguf');
  assert.equal(at('--video-frames'), '81');
  assert.equal(at('--steps'), '20');
  assert.equal(at('-W'), '480');
  assert.equal(at('--seed'), '7');
  assert.equal(at('-o'), 'C:\\out\\clip.webm');
  assert.ok(a.includes('--offload-to-cpu') && a.includes('--diffusion-fa') && a.includes('--vae-tiling'));
  assert.equal(at('--fps'), '16', 'sd-cli plays at 24 unless told: Wan 2.1 is 16');
  assert.ok(!a.includes('--high-noise-diffusion-model'));
  const cpu = videoArgs(cleanJob(job()), { ...f, highNoise: 'H.gguf' }, 'o.webm', 'cpu');
  assert.ok(!cpu.includes('--offload-to-cpu'));
  assert.equal(cpu[cpu.indexOf('--high-noise-diffusion-model') + 1], 'H.gguf');
  assert.equal(cpu[cpu.indexOf('--seed') + 1], '-1', 'no seed: a random one');
});

test('a clip is made: progress goes loading, making (with a time left), joining; the .webm comes back', async () => {
  const r = rig({
    script: (k, a) => {
      k.stdout.write('loading model from D.gguf\n');
      k.stdout.write('  |=====>        | 3/12 - 2.00s/it\r');
      k.stdout.write('  |==========>   | 12/12 - 2.00s/it\n');
      k.stdout.write('decoding 33 frames\n');
      writeFileSync(outOf(a), Buffer.alloc(1234));
      k.end(0);
    },
  });
  const seen: VideoProgress[] = [];
  const clip = await new SdVideoRunner(r.deps).make(job(), p => seen.push(p), go().signal);
  assert.equal(clip.mime, 'video/webm');
  assert.equal(clip.bytes, 1234);
  assert.ok(clip.file.startsWith(r.out) && clip.file.endsWith('.webm'));
  assert.equal(clip.seconds, 2);
  assert.equal(seen[0].stage, 'loading');
  const making = seen.find(p => p.stage === 'making')!;
  assert.deepEqual([making.done, making.total, making.secondsLeft], [3, 12, 24]);
  assert.equal(seen.at(-1)!.stage, 'joining');
  assert.equal(videoBusy(), false);
});

test('a bar that is not the drawing (Wan 2.2 shows 10 of 10 while it loads) does not end it: the steps still show', async () => {
  const r = rig({
    script: (k, a) => {
      k.stdout.write('loading model from D.gguf\n');
      k.stdout.write('  |==============| 10/10 - 5.00it/s\n');
      k.stdout.write('loading vae from V.safetensors\n');
      k.stdout.write('  |=====>        | 3/12 - 2.00s/it\r');
      k.stdout.write('  |==========>   | 12/12 - 2.00s/it\n');
      k.stdout.write('decoding 33 frames\n');
      writeFileSync(outOf(a), Buffer.alloc(1234));
      k.end(0);
    },
  });
  const seen: VideoProgress[] = [];
  await new SdVideoRunner(r.deps).make(job(), p => seen.push(p), go().signal);
  const at = (i: number) => [seen[i].stage, seen[i].done, seen[i].total];
  const tenOfTen = seen.findIndex(p => p.total === 10);
  assert.deepEqual(at(tenOfTen), ['making', 10, 10], 'the other bar is not the end of the drawing');
  assert.ok(!seen.slice(0, seen.findIndex(p => p.total === 12)).some(p => p.stage === 'joining'), 'not "writing the clip file" before the drawing');
  const making = seen.find(p => p.stage === 'making' && p.total === 12)!;
  assert.deepEqual([making.done, making.total, making.secondsLeft], [3, 12, 24]);
  assert.equal(seen.at(-1)!.stage, 'joining');
});

test('not installed, missing model, a missing file, low disk: each a fault with a plain sentence, nothing started', async () => {
  const a = rig({ exe: false });
  const e1 = await faultOf(new SdVideoRunner(a.deps).make(job(), () => {}, go().signal));
  assert.equal(e1.kind, 'not-installed');
  assert.equal(e1.message, VIDEO_WORDS.notInstalled);
  assert.equal(await new SdVideoRunner(a.deps).installed(), false);

  const b = rig({ files: null });
  const e2 = await faultOf(new SdVideoRunner(b.deps).make(job(), () => {}, go().signal));
  assert.equal(e2.kind, 'missing-model');
  assert.match(e2.message, /"wan-1\.3b" is not on this PC/);

  const c = rig({ files: { name: 'Wan', diffusion: join(tmp(), 'gone.gguf'), vae: 'x', textEncoder: 'y' } });
  const e3 = await faultOf(new SdVideoRunner(c.deps).make(job(), () => {}, go().signal));
  assert.equal(e3.kind, 'missing-model');
  assert.match(e3.message, /missing a file \(gone\.gguf\)/);

  const d = rig({ free: LOW_DISK_BYTES - 1 });
  const e4 = await faultOf(new SdVideoRunner(d.deps).make(job(), () => {}, go().signal));
  assert.equal(e4.kind, 'low-disk');
  assert.match(e4.message, /GB is free where clips are kept/);
  for (const x of [a, b, c, d]) assert.equal(x.args.length, 0);
});

test('an empty prompt is refused before anything starts', async () => {
  const r = rig();
  await assert.rejects(new SdVideoRunner(r.deps).make(job({ prompt: '  ' }), () => {}, go().signal), { message: VIDEO_WORDS.noPrompt });
  assert.equal(r.args.length, 0);
});

test('Stop ends the process by PID and says Stopped; the half-made file goes', async () => {
  let file = '';
  const r = rig({
    script: (k, a) => {
      file = outOf(a);
      mkdirSync(r.out, { recursive: true });
      writeFileSync(file, 'half');
      k.stdout.write('| 1/12 - 3.00s/it\n');
    },
  });
  const stop = go();
  const p = new SdVideoRunner(r.deps).make(job(), pr => pr.stage === 'making' && stop.abort(), stop.signal);
  const e = await faultOf(p);
  assert.equal(e.kind, 'stopped');
  assert.equal(e.message, VIDEO_WORDS.stopped);
  assert.ok(r.kids[0].child.killed);
  assert.equal(existsSync(file), false);
  assert.equal(videoBusy(), false);
});

test('a Stop pressed before it starts starts nothing', async () => {
  const r = rig();
  const stop = go();
  stop.abort();
  assert.equal((await faultOf(new SdVideoRunner(r.deps).make(job(), () => {}, stop.signal))).kind, 'stopped');
  assert.equal(r.args.length, 0);
});

test('a crash (it ends by itself with an error code) says so in plain words', async () => {
  const r = rig({ script: k => (k.stderr.write('something broke\n'), k.end(3221225477 | 0)) });
  const e = await faultOf(new SdVideoRunner(r.deps).make(job(), () => {}, go().signal));
  assert.equal(e.kind, 'crashed');
  assert.match(e.message, /^The video runner stopped by itself \(exit code -1073741819\)/);
});

test('out of memory on the card: its own fault, whatever the exit code', async () => {
  const r = rig({ script: k => (k.stderr.write('ggml_cuda: cudaMalloc failed: out of memory\n'), k.end(1)) });
  const e = await faultOf(new SdVideoRunner(r.deps).make(job(), () => {}, go().signal));
  assert.equal(e.kind, 'out-of-memory');
  assert.equal(e.message, VIDEO_WORDS.outOfMemory);
});

test('a start that fails (the program cannot be run, or a DLL is missing) says it could not start', async () => {
  const a = rig({ startThrows: true });
  const e1 = await faultOf(new SdVideoRunner(a.deps).make(job(), () => {}, go().signal));
  assert.equal(e1.kind, 'crashed');
  assert.match(e1.message, /^The video runner could not start: spawn EACCES/);

  const b = rig({ script: k => k.end(-1073741515) });
  const e2 = await faultOf(new SdVideoRunner(b.deps).make(job(), () => {}, go().signal));
  assert.match(e2.message, /^The video runner could not start: Windows could not start the runner/);

  const c = rig({ script: k => setImmediate(() => k.child.emit('error', new Error('spawn ENOENT'))) });
  const e3 = await faultOf(new SdVideoRunner(c.deps).make(job(), () => {}, go().signal));
  assert.match(e3.message, /could not start: spawn ENOENT/);
});

test('it exits cleanly but writes no clip: a crash with its own sentence', async () => {
  const r = rig({ script: k => k.end(0) });
  const e = await faultOf(new SdVideoRunner(r.deps).make(job(), () => {}, go().signal));
  assert.equal(e.kind, 'crashed');
  assert.equal(e.message, VIDEO_WORDS.noFile);
});

test('one clip at a time on this PC: a second one while the first is made is busy', async () => {
  let finish: () => void = () => {};
  const r = rig({ script: (k, a) => (finish = () => (writeFileSync(outOf(a), 'x'), k.end(0))) });
  const runner = new SdVideoRunner(r.deps);
  const first = runner.make(job(), () => {}, go().signal);
  await new Promise(res => setTimeout(res, 20));
  assert.equal(videoBusy(), true);
  const e = await faultOf(new SdVideoRunner(rig().deps).make(job(), () => {}, go().signal));
  assert.equal(e.kind, 'busy');
  finish();
  await first;
  assert.equal(videoBusy(), false);
});

test('the video program is sd-cli beside an installed card build, CUDA before Vulkan; facts name what to install', () => {
  const dir = tmp();
  const vk = join(dir, 'sd-vulkan');
  mkdirSync(vk);
  writeFileSync(join(vk, 'sd-server.exe'), '');
  const rt = {
    pins: { 'sd-cuda': { engine: 'sd', device: 'cuda', name: 'sd CUDA' }, 'sd-vulkan': { engine: 'sd', device: 'vulkan', name: 'sd Vulkan' } },
    order: (_e: 'sd', d: string) => (d === 'cuda' ? ['sd-cuda'] : d === 'vulkan' ? ['sd-vulkan'] : []),
    exePin: (id: string) => (id === 'sd-vulkan' ? join(vk, 'sd-server.exe') : null),
    bytesPin: (id: string) => (id === 'sd-cuda' ? 900 : 30),
  };
  // sd-server alone is not enough: the clip needs its sd-cli.
  assert.equal(findVideoExe(rt), null);
  assert.deepEqual(videoRunnerFacts(rt, ['cuda', 'vulkan']), { installed: false, pin: 'sd-cuda', name: 'sd CUDA', bytes: 900 });
  assert.deepEqual(videoRunnerFacts(rt, ['vulkan']), { installed: false, pin: 'sd-vulkan', name: 'sd Vulkan', bytes: 30 });
  assert.deepEqual(videoRunnerFacts(rt, []), { installed: false, pin: null, name: null, bytes: 0 });
  writeFileSync(join(vk, process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli'), '');
  assert.equal(findVideoExe(rt)?.device, 'vulkan');
  assert.deepEqual(videoRunnerFacts(rt, ['cuda', 'vulkan']), { installed: true, pin: 'sd-vulkan', name: 'sd Vulkan', bytes: 30 });
  assert.equal(findVideoExe(rt, ['cuda']), null);
});

test('a video model folder: diffusion, VAE and text encoder found by name; a part missing is no model', async () => {
  const dir = tmp();
  const m = join(dir, 'wan-2.2');
  mkdirSync(m);
  for (const n of ['Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf', 'Wan2.2-T2V-A14B-HighNoise-Q4_K_M.gguf', 'wan_2.1_vae.safetensors', 'umt5-xxl-encoder-Q8_0.gguf', 'readme.txt']) writeFileSync(join(m, n), 'x');
  const f = (await folderResolver(dir)('wan-2.2'))!;
  assert.match(f.diffusion, /LowNoise/);
  assert.match(f.highNoise!, /HighNoise/);
  assert.match(f.vae, /vae/);
  assert.match(f.textEncoder, /umt5/);
  assert.equal(await folderResolver(dir)('nothing-here'), null);
  assert.equal(await folderResolver(dir)('..\\secret'), null);
  const half = join(dir, 'half');
  mkdirSync(half);
  writeFileSync(join(half, 'wan.gguf'), 'x');
  assert.equal(await folderResolver(dir)('half'), null);
});

test('Wan 2.2 5B is made with its own settings: 24 a second (121 frames for 5 s), guidance 5, flow shift 5, its own steps', async () => {
  const dir = tmp();
  for (const id of ['wan22-ti2v-5b-q8', 'wan22-ti2v-5b', 'wan21-t2v-1.3b']) {
    mkdirSync(join(dir, id));
    for (const n of ['wan.gguf', 'wan_vae.safetensors', 'umt5.gguf']) writeFileSync(join(dir, id, n), 'x');
  }
  const flags = (f: VideoModelFiles, j: Partial<VideoJob>) => {
    const a = videoArgs(cleanJob(job({ seconds: 5, ...j })), f, 'o.webm', 'cuda');
    return (flag: string) => a[a.indexOf(flag) + 1];
  };
  for (const id of ['wan22-ti2v-5b-q8', 'wan22-ti2v-5b']) {
    const f = (await folderResolver(dir)(id))!;
    assert.deepEqual([f.fps, f.cfg, f.flowShift, f.steps], [24, 5, 5, { draft: 20, normal: 30, best: 50 }], id);
    const at = flags(f, { quality: 'normal', width: 1280, height: 704 });
    assert.equal(at('--fps'), '24');
    assert.equal(at('--video-frames'), '121');
    assert.equal(at('--cfg-scale'), '5');
    assert.equal(at('--flow-shift'), '5');
    assert.equal(at('--sampling-method'), 'euler');
    assert.equal(at('--steps'), '30');
    assert.equal(at('-W'), '1280');
    assert.equal(at('-H'), '704');
    assert.equal(flags(f, { quality: 'draft' })('--steps'), '20');
    assert.equal(flags(f, { quality: 'best' })('--steps'), '50');
    assert.equal(flags(f, { quality: 'best', steps: 8 })('--steps'), '8', 'steps asked by hand still win');
    assert.equal(stepsOf(cleanJob(job({ quality: 'best' })), f), 50);
  }
  // Wan 2.1 1.3B is as it was: 16 a second (81 frames), guidance 6, shift 3, 12/20/30 steps.
  const old = (await folderResolver(dir)('wan21-t2v-1.3b'))!;
  assert.equal(old.steps, undefined);
  const at = flags(old, { quality: 'normal' });
  assert.deepEqual(['--fps', '--video-frames', '--cfg-scale', '--flow-shift', '--steps'].map(at), ['16', '81', '6', '3', '20']);
  assert.equal(flags(old, { quality: 'draft' })('--steps'), '12');
  assert.equal(flags(old, { quality: 'best' })('--steps'), '30');
});

test('the progress counts the model\'s own steps: a Wan 2.2 5B Normal clip is 30 steps', async () => {
  const files = { ...modelFiles(tmp()), steps: { draft: 20, normal: 30, best: 50 } };
  const r = rig({
    files,
    script: (k, a) => {
      k.stdout.write('  |=====>        | 10/10 - 1.00s/it\n');
      k.stdout.write('  |=====>        | 6/30 - 2.00s/it\n');
      writeFileSync(outOf(a), Buffer.alloc(10));
      k.end(0);
    },
  });
  const seen: VideoProgress[] = [];
  await new SdVideoRunner(r.deps).make(job({ quality: 'normal' }), p => seen.push(p), go().signal);
  assert.equal(seen[0].total, 30, 'the loading stage already says 30');
  assert.ok(seen.some(p => p.stage === 'making' && p.done === 6 && p.total === 30));
  assert.equal(r.args[0][r.args[0].indexOf('--steps') + 1], '30');
});

test('the test door: starts one clip, shows progress, ends done; refuses a second, no model, or a busy card', async () => {
  const fake = new FakeVideoRunner({ dir: tmp(), steps: 3, stepMs: 5 });
  let busy = '';
  const door = new VideoTestDoor(fake, () => busy);
  assert.equal(door.state().state, 'idle');
  assert.equal((await door.start({})).status, 400);
  busy = 'a picture model is loaded on the graphics card';
  assert.match(String((await door.start({ model: 'wan' })).json.error), /^Not now: a picture model/);
  busy = '';
  const r = await door.start({ model: 'wan', seconds: 3 });
  assert.equal(r.status, 202);
  assert.equal((await door.start({ model: 'wan' })).status, 409);
  await door.done;
  const s = door.state();
  assert.equal(s.state, 'done');
  assert.equal(s.clip?.seconds, 3);
  assert.equal(fake.jobs[0].quality, 'draft');
  assert.equal(s.progress?.stage, 'joining');
});

test('the test door: Stop, and a fault kept with its kind and sentence', async () => {
  const door = new VideoTestDoor(new FakeVideoRunner({ dir: tmp(), steps: 50, stepMs: 5 }));
  await door.start({ model: 'wan' });
  door.stop();
  await door.done;
  assert.equal(door.state().state, 'stopped');
  assert.equal(door.state().fault?.said, VIDEO_WORDS.stopped);

  const oom = new VideoTestDoor(new FakeVideoRunner({ dir: tmp(), fail: 'out-of-memory', failAt: 1 }));
  await oom.start({ model: 'wan' });
  await oom.done;
  assert.deepEqual(oom.state().fault, { kind: 'out-of-memory', said: VIDEO_WORDS.outOfMemory });

  const none = new VideoTestDoor(new FakeVideoRunner({ dir: tmp(), installed: false }));
  const r = await none.start({ model: 'wan' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, VIDEO_WORDS.notInstalled);
});

test('the fake runner: missing model and busy as the real one says them', async () => {
  const fake = new FakeVideoRunner({ dir: tmp(), models: ['wan'], steps: 2, stepMs: 10 });
  const e = await faultOf(fake.make(job({ model: 'other' }), () => {}, go().signal));
  assert.equal(e.kind, 'missing-model');
  const first = fake.make(job({ model: 'wan' }), () => {}, go().signal);
  assert.equal((await faultOf(fake.make(job({ model: 'wan' }), () => {}, go().signal))).kind, 'busy');
  assert.ok(existsSync((await first).file));
});

test('the server has the door, and the Models page says a picture card runner makes video too', () => {
  const server = read('src/server.ts');
  assert.match(server, /import \{ videoGet, videoPost \} from '\.\/server\/video\.ts'/);
  assert.match(server, /faultsGet, videoGet,/);
  assert.match(server, /faultsPost, videoPost,/);
  const door = read('src/server/video.ts');
  for (const p of ["'/api/video-test'", "'/api/video-test/stop'"]) assert.ok(door.includes(p), p);
  assert.match(read('src/server/runtimes.ts'), /video: p\.engine === 'sd' && VIDEO_DEVICES\.includes\(p\.device\)/);
  assert.match(read('public/models.js'), /r\.video \? ' It makes pictures and video clips\.'/);
});
