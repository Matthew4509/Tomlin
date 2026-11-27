// The video engine on this PC: stable-diffusion.cpp's command-line program (sd-cli, in the same folder as the picture
// runner's sd-server, from the same pinned build) run once per clip in its video mode (-M vid_gen, the Wan models). It
// writes the clip as a .webm file itself, so nothing else is needed to join the frames. One clip at a time per PC.
// Start, Stop (by PID), a crash, a missing model, a full disk and a graphics card out of memory each end in a VideoFault
// with a plain sentence. Everything outside (the runner builds, model files, free disk, starting a process) comes in as
// deps, so the tests stand in for them (test/video.test.ts, test/fakevideo.ts).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { randomBytes } from 'node:crypto';
import { alive } from './hardware.ts';
import * as leftovers from './leftovers.ts';
import { libDirEnv } from './libdir.ts';
import { watchRunner } from './runnerexit.ts';
import { onExit } from './exithook.ts';
import { dllLine, dllNotFound } from './vcrt.ts';
import { lineSplitter, runnerEnv } from './worker.ts';
import type { Device } from './runtimes.ts';
import { WAN21_STEPS, takesStartPicture, videoMakeOf, wordsOnlyLine } from './videomodels.ts';
import { LOW_DISK_BYTES, MAX_CLIP_SECONDS, VideoFault, type VideoClip, type VideoJob, type VideoProgress, type VideoRunner } from './videotypes.ts';

/** The files one video model needs (Wan 2.x: the diffusion model, its VAE and the UMT5 text encoder). */
export interface VideoModelFiles {
  /** The model's name for the sentences ("Wan 2.1 1.3B"). */
  name: string;
  diffusion: string;
  vae: string;
  textEncoder: string;
  /** Wan 2.2 A14B: the high-noise half of the model, beside the low-noise one in `diffusion`. */
  highNoise?: string;
  /** Frames a second the model was trained on (Wan: 16). */
  fps?: number;
  /** The model's own sampler settings, when they differ from the Wan defaults below. */
  cfg?: number;
  flowShift?: number;
  sampler?: string;
  /** The model's own sampling steps of each quality, when they differ from STEPS below (Wan 2.2 5B). */
  steps?: Record<VideoJob['quality'], number>;
}

/** The video program found on this PC: its path, the device its build runs on, and the build (runtimes.json id). */
export interface VideoExe {
  exe: string;
  device: Device;
  pin: string;
}

/** A process as the runner uses it (a real ChildProcess, or a test's stand-in). */
export type VideoChild = Pick<ChildProcess, 'pid' | 'stdout' | 'stderr' | 'once' | 'on' | 'kill' | 'exitCode' | 'signalCode'>;

export interface VideoDeps {
  /** The video program on this PC, best device first; null when no build that has it is installed. */
  findExe: () => VideoExe | null;
  /** The files of a video model by its id; null when it is not downloaded on this PC. */
  resolve: (model: string) => Promise<VideoModelFiles | null>;
  /** The folder finished clips are written to. */
  outDir: string;
  /** Bytes free where `path` is, null when it cannot be read (not held against the clip). */
  freeBytes: (path: string) => Promise<number | null>;
  start: (exe: string, args: string[], env: NodeJS.ProcessEnv | undefined) => VideoChild;
  /** Ends a process and anything it started, by PID; resolves once it is gone (or it gave up). */
  killTree: (child: VideoChild) => Promise<void>;
  now: () => number;
}

/** How a clip's quality is made: sampling steps. Few-step (distilled) models are a later phase's matter. */
export const STEPS: Record<VideoJob['quality'], number> = WAN21_STEPS;
/** Steps asked by hand: 1 to this. */
export const MAX_STEPS = 60;
const handSteps = (n: unknown): number | undefined => (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_STEPS ? (n as number) : undefined);
/** The steps a job is made with: its own when it asks, else its quality's (the model's own steps when it has them). */
export const stepsOf = (job: VideoJob, files?: Pick<VideoModelFiles, 'steps'>): number => {
  const table = files?.steps ?? STEPS;
  return handSteps(job.steps) ?? table[job.quality] ?? table.normal ?? STEPS.normal;
};
/** The Wan 2.1 models' own defaults (stable-diffusion.cpp docs/wan.md); Wan 2.2 5B gives its own (src/videomodels.ts make). */
const WAN = { fps: 16, cfg: 6, flowShift: 3, sampler: 'euler' };

/** Frames for a clip of `seconds` at `fps`: Wan wants 4n+1 frames (81 for 5 seconds at 16 a second). */
export function framesFor(seconds: number, fps: number): number {
  return 4 * Math.max(1, Math.round((seconds * fps) / 4)) + 1;
}

/** A side made a multiple of 16 (the Wan VAE's step), 128 to 1280. */
const side = (n: number) => Math.min(1280, Math.max(128, Math.round((Number.isFinite(n) ? n : 480) / 16) * 16));

/** The job as it is run: seconds 1 to MAX_CLIP_SECONDS, sides a multiple of 16, a known quality. */
export function cleanJob(job: VideoJob): VideoJob {
  const seconds = Math.min(MAX_CLIP_SECONDS, Math.max(1, Math.round(Number(job.seconds) || 1)));
  const quality = job.quality in STEPS ? job.quality : 'normal';
  const negative = String(job.negative ?? '').replace(/\s+/g, ' ').trim();
  const steps = handSteps(job.steps);
  const { negative: _n, steps: _s, ...rest } = job;
  return { ...rest, prompt: String(job.prompt ?? '').trim(), seconds, width: side(job.width), height: side(job.height), quality, ...(negative ? { negative } : {}), ...(steps ? { steps } : {}) };
}

/**
 * The sd-cli arguments for one clip: the only place the engine's flags are written, so a different build (or what the
 * engine test finds, docs/tests-2026-11-25-video-engine.md) changes them here. On a card the weights wait in RAM until
 * needed (--offload-to-cpu), the frames are decoded in tiles (--vae-tiling: the VAE decode is the memory peak) and the
 * diffusion model uses flash attention, as the upstream Wan notes advise for cards of 12 GB and less.
 */
export function videoArgs(job: VideoJob, files: VideoModelFiles, out: string, device: Device): string[] {
  const fps = files.fps ?? WAN.fps;
  const args = [
    '-M', 'vid_gen',
    '--diffusion-model', files.diffusion,
    ...(files.highNoise ? ['--high-noise-diffusion-model', files.highNoise] : []),
    '--vae', files.vae,
    '--t5xxl', files.textEncoder,
    '-p', job.prompt,
    // Image to video: the clip starts from this picture (fitted to the clip's size before it gets here).
    ...(job.startPicture ? ['-i', job.startPicture] : []),
    ...(job.negative ? ['-n', job.negative] : []),
    '-W', String(job.width),
    '-H', String(job.height),
    '--video-frames', String(framesFor(job.seconds, fps)),
    '--fps', String(fps),
    '--steps', String(stepsOf(job, files)),
    '--cfg-scale', String(files.cfg ?? WAN.cfg),
    '--sampling-method', files.sampler ?? WAN.sampler,
    '--flow-shift', String(files.flowShift ?? WAN.flowShift),
    '--seed', String(job.seed ?? -1),
    '-o', out,
  ];
  if (device !== 'cpu') args.push('--offload-to-cpu', '--diffusion-fa', '--vae-tiling');
  return args;
}

/** What the runner says when a card (or the PC) runs out of memory. */
const OUT_OF_MEMORY = /out of memory|outofdevicememory|cudaMalloc failed|failed to allocate|alloc.*fail|bad_alloc|not enough memory|ErrorOutOfDeviceMemory/i;

/** The step bar sd-cli prints while it samples: "|=====>   | 3/20 - 1.20s/it". */
const STEP_BAR = /\|\s*(\d+)\/(\d+) - ([\d.]+)(s\/it|it\/s)/g;

/** The sentences, so the tests and the other phases' screens say the same. */
export const VIDEO_WORDS = {
  notInstalled: 'The video runner is not installed on this PC. Install the picture runner for its graphics card (Models, Model runners: stable-diffusion.cpp CUDA or Vulkan); it makes video clips too.',
  missingModel: (name: string) => `The video model "${name}" is not on this PC. Download it from Models first, then try again.`,
  missingFile: (name: string, file: string) => `The video model "${name}" is missing a file (${file}). Download it again from Models, then try again.`,
  busy: 'This PC is making another clip now. Wait for it to finish (or stop it), then try again.',
  lowDisk: (free: number) => `Only ${(free / 2 ** 30).toFixed(1)} GB is free where clips are kept, and a clip needs at least 2 GB of room while it is made. Free some room on that drive, then try again.`,
  stopped: 'Stopped. No clip was made.',
  outOfMemory: 'The graphics card ran out of memory making this clip. Choose a shorter clip, a smaller size or Draft quality, or a smaller video model.',
  noStart: (why: string) => `The video runner could not start: ${why}`,
  crashed: (how: string) => `The video runner stopped by itself (${how}) before the clip was finished. Try again; if it stops again, choose a smaller size or Draft quality.`,
  noFile: 'The video runner finished but wrote no clip. Try again; if it happens again, try another video model.',
  noPrompt: 'Write what the clip should show first.',
  wordsOnly: wordsOnlyLine,
  noStartPicture: 'The start picture for this clip is missing, so no clip was made. Add the picture again, then try again.',
};

/** One clip at a time on this PC, whichever runner object asks (the test door and a Videographer share the card). */
const making = { now: false };

/** True while a clip is being made on this PC (for the busy checks of other jobs). */
export const videoBusy = (): boolean => making.now;

export class SdVideoRunner implements VideoRunner {
  private readonly deps: () => Promise<VideoDeps>;

  constructor(deps: VideoDeps | (() => Promise<VideoDeps>)) {
    this.deps = typeof deps === 'function' ? deps : async () => deps;
  }

  async installed(): Promise<boolean> {
    return (await this.deps()).findExe() !== null;
  }

  async make(input: VideoJob, onProgress: (p: VideoProgress) => void, signal: AbortSignal): Promise<VideoClip> {
    const d = await this.deps();
    const job = cleanJob(input);
    if (!job.prompt) throw new Error(VIDEO_WORDS.noPrompt);
    if (signal.aborted) throw new VideoFault('stopped', VIDEO_WORDS.stopped);
    if (making.now) throw new VideoFault('busy', VIDEO_WORDS.busy);
    // The card is taken here, in the same turn as the check, before anything is awaited: two clips asked at the same
    // moment (a Videographer's here and a linked PC's) never both pass it.
    making.now = true;
    try {
      if (job.startPicture && !takesStartPicture(job.model)) throw new VideoFault('missing-model', VIDEO_WORDS.wordsOnly(job.model));
      if (job.startPicture && !existsSync(job.startPicture)) throw new VideoFault('crashed', VIDEO_WORDS.noStartPicture);
      const found = d.findExe();
      if (!found) throw new VideoFault('not-installed', VIDEO_WORDS.notInstalled);
      const files = await d.resolve(job.model);
      if (!files) throw new VideoFault('missing-model', VIDEO_WORDS.missingModel(job.model));
      for (const f of [files.diffusion, files.highNoise, files.vae, files.textEncoder]) {
        if (f && !existsSync(f)) throw new VideoFault('missing-model', VIDEO_WORDS.missingFile(files.name, parse(f).base));
      }
      await mkdir(d.outDir, { recursive: true });
      const free = await d.freeBytes(d.outDir);
      if (free !== null && free < LOW_DISK_BYTES) throw new VideoFault('low-disk', VIDEO_WORDS.lowDisk(free));
      if (signal.aborted) throw new VideoFault('stopped', VIDEO_WORDS.stopped);
      return await this.run(d, found, files, job, onProgress, signal);
    } finally {
      making.now = false;
    }
  }

  private async run(d: VideoDeps, found: VideoExe, files: VideoModelFiles, job: VideoJob, onProgress: (p: VideoProgress) => void, signal: AbortSignal): Promise<VideoClip> {
    const out = join(d.outDir, `clip-${new Date(d.now()).toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}.webm`);
    const started = d.now();
    const tail: string[] = [];
    let stopped = false;
    let child: VideoChild;
    try {
      child = d.start(found.exe, videoArgs(job, files, out, found.device), libDirEnv(found.exe, runnerEnv(found.device)));
    } catch (e) {
      throw new VideoFault('crashed', VIDEO_WORDS.noStart((e as Error).message));
    }
    leftovers.started(child.pid, found.exe);
    const dropExit = onExit(() => {
      if (child.exitCode === null) child.kill();
    });
    const exitLog = watchRunner(child, found.exe, () => stopped, { feed: true });
    const progress: VideoProgress = { stage: 'loading', done: 0, total: stepsOf(job, files), secondsLeft: null };
    let perStep: number | null = null;
    // The drawing's own bar has the clip's step count as its total. The runner shows other bars too (a Wan 2.2 clip
    // starts with a 10 of 10 one while it loads), which must not end the drawing: before this, the whole clip read
    // "Writing the clip file" at 97% from its first seconds.
    const steps = stepsOf(job, files);
    let drawing = false;
    const say = () => onProgress({ ...progress });
    say();
    const line = (l: string, errors: boolean) => {
      tail.push(l);
      if (tail.length > 40) tail.shift();
      if (errors) exitLog.line(l);
      const bar = [...l.matchAll(STEP_BAR)].pop();
      if (bar && progress.stage !== 'joining' && (Number(bar[2]) === steps || !drawing)) {
        const own = Number(bar[2]) === steps;
        drawing ||= own;
        progress.stage = 'making';
        progress.done = Number(bar[1]);
        progress.total = Number(bar[2]);
        const v = Number(bar[3]);
        perStep = bar[4] === 's/it' ? v : v > 0 ? 1 / v : null;
        // Decoding the frames takes about as long as three steps (a guess until a clip has been timed).
        progress.secondsLeft = perStep === null ? null : Math.round((progress.total - progress.done + 3) * perStep);
        if (own && progress.done >= progress.total) progress.stage = 'joining';
        return say();
      }
      if (progress.stage !== 'joining' && drawing && progress.done > 0 && /decod|vae|saving|save result|writing/i.test(l)) {
        progress.stage = 'joining';
        progress.secondsLeft = perStep === null ? null : Math.round(3 * perStep);
        say();
      }
    };
    for (const [stream, errors] of [[child.stdout, false], [child.stderr, true]] as const) {
      const split = lineSplitter();
      stream?.setEncoding('utf8');
      stream?.on('data', (s: string) => split(s).forEach(l => line(l, errors)));
      stream?.on('end', () => split.rest().forEach(l => line(l, errors)));
    }
    const ended = new Promise<{ code: number | null; signal: string | null; error: Error | null }>(resolve => {
      child.once('error', (error: Error) => resolve({ code: null, signal: null, error }));
      child.once('close', (code: number | null, sig: string | null) => resolve({ code, signal: sig, error: null }));
    });
    const stop = () => {
      stopped = true;
      void d.killTree(child);
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const end = await ended;
    signal.removeEventListener('abort', stop);
    leftovers.ended(child.pid);
    dropExit();
    const took = d.now() - started;
    if (stopped) {
      await rm(out, { force: true });
      throw new VideoFault('stopped', VIDEO_WORDS.stopped);
    }
    const said = tail.join('\n');
    if (end.error) throw new VideoFault('crashed', VIDEO_WORDS.noStart(end.error.message));
    if (OUT_OF_MEMORY.test(said)) {
      await rm(out, { force: true });
      throw new VideoFault('out-of-memory', VIDEO_WORDS.outOfMemory);
    }
    if (end.code !== 0) {
      await rm(out, { force: true });
      if (dllNotFound(end.code)) throw new VideoFault('crashed', VIDEO_WORDS.noStart(dllLine()));
      const how = end.code !== null ? `exit code ${end.code}` : end.signal ? `ended by ${end.signal}` : 'no exit code';
      throw new VideoFault('crashed', VIDEO_WORDS.crashed(how));
    }
    let bytes = 0;
    try {
      bytes = statSync(out).size;
    } catch {
      // not written
    }
    if (!bytes) throw new VideoFault('crashed', VIDEO_WORDS.noFile);
    return { file: out, mime: 'video/webm', bytes, seconds: job.seconds, width: job.width, height: job.height, model: job.model, tookMs: took };
  }
}

// ---- The real deps (the running app's runner builds, model folder and disk) ----

/** sd-cli beside a picture runner's sd-server (the same zip carries both). */
export function cliBeside(serverExe: string | null): string | null {
  if (!serverExe) return null;
  const cli = join(dirname(serverExe), process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli');
  return existsSync(cli) ? cli : null;
}

/** The card builds that make video, best first: CUDA (in this PC's order), then Vulkan. The CPU build is far too slow. */
export const VIDEO_DEVICES: Device[] = ['cuda', 'vulkan'];

/** What the Models page and the test door say about the video runner here: the build that makes clips, or the one to install. */
export interface VideoRunnerFacts {
  installed: boolean;
  pin: string | null;
  name: string | null;
  bytes: number;
}

interface RuntimesLike {
  pins: Record<string, { engine: string; device: string; name: string }>;
  order: (engine: 'sd', device: Device) => string[];
  exePin: (id: string, engine: 'sd') => string | null;
  bytesPin: (id: string) => number;
}

/** The video program among these runner builds (installed ones, in this PC's order), or null. */
export function findVideoExe(rt: RuntimesLike, devices: Device[] = VIDEO_DEVICES): VideoExe | null {
  for (const device of devices) {
    for (const pin of rt.order('sd', device)) {
      const exe = cliBeside(rt.exePin(pin, 'sd'));
      if (exe) return { exe, device, pin };
    }
  }
  return null;
}

/** The facts for the Models page: the installed build that makes video, else the first one to download (its size). */
export function videoRunnerFacts(rt: RuntimesLike, cardDevices: Device[], devices: Device[] = VIDEO_DEVICES): VideoRunnerFacts {
  const found = findVideoExe(rt, devices);
  if (found) return { installed: true, pin: found.pin, name: rt.pins[found.pin]?.name ?? null, bytes: rt.bytesPin(found.pin) };
  const next = devices.filter(d => cardDevices.includes(d)).flatMap(d => rt.order('sd', d))[0] ?? null;
  return { installed: false, pin: next, name: next ? rt.pins[next]?.name ?? null : null, bytes: next ? rt.bytesPin(next) : 0 };
}

/**
 * The files of a video model kept in `<dir>/<id>/`: the diffusion model (a .gguf or .safetensors not named for the VAE
 * or the text encoder, the one named "high_noise" as its other half), the VAE ("vae") and the text encoder ("umt5" or
 * "t5"). The Models page's video downloads (a later phase) can hand the runner its own resolver instead.
 */
export function folderResolver(dir: string): (model: string) => Promise<VideoModelFiles | null> {
  return async model => {
    if (!model || /[\\/]|\.\./.test(model)) return null;
    const home = join(dir, model);
    let names: string[];
    try {
      names = readdirSync(home).filter(n => /\.(gguf|safetensors)$/i.test(n));
    } catch {
      return null;
    }
    const vae = names.find(n => /vae/i.test(n));
    const textEncoder = names.find(n => /umt5|t5xxl|t5/i.test(n) && n !== vae);
    const rest = names.filter(n => n !== vae && n !== textEncoder);
    const highNoise = rest.find(n => /high[_-]?noise/i.test(n));
    const diffusion = rest.find(n => n !== highNoise);
    if (!vae || !textEncoder || !diffusion) return null;
    return { name: model, diffusion: join(home, diffusion), vae: join(home, vae), textEncoder: join(home, textEncoder), ...(highNoise ? { highNoise: join(home, highNoise) } : {}), ...videoMakeOf(model) };
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Ends the clip's process: asked first, then (on Windows) taskkill by PID with anything it started. */
export async function killTree(child: VideoChild): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  const gone = new Promise<void>(r => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', () => r())));
  child.kill();
  await Promise.race([gone, sleep(5000)]);
  if (alive(pid) && process.platform === 'win32') await new Promise(r => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r(null)));
  else if (alive(pid)) child.kill('SIGKILL');
}

let real: Promise<VideoDeps> | null = null;

/** The running app's deps, read once on first use (the app's core is loaded only then, so tests never load it). */
function appDeps(): Promise<VideoDeps> {
  real ??= (async () => {
    const core = await import('./server/core.ts');
    const { freeOn } = await import('./lowdisk.ts');
    return {
      findExe: () => findVideoExe(core.runtimes),
      resolve: folderResolver(join(core.modelsHome.dir(), 'video')),
      outDir: join(core.store.dir, 'videos'),
      freeBytes: freeOn,
      start: (exe, args, env) => spawn(exe, args, { windowsHide: true, env }),
      killTree,
      now: Date.now,
    } satisfies VideoDeps;
  })();
  return real;
}

/** The video runner the server uses. `over`: deps to use instead of the app's own (a model resolver, another folder). */
export function videoRunner(over: Partial<VideoDeps> = {}): VideoRunner {
  return new SdVideoRunner(async () => ({ ...(await appDeps()), ...over }));
}

// ---- The test door: one clip on this PC, started, watched and stopped by hand (src/server/video.ts gives its routes) ----

export interface VideoTestView {
  state: 'idle' | 'running' | 'done' | 'failed' | 'stopped';
  model: string | null;
  started: string | null;
  progress: VideoProgress | null;
  clip: VideoClip | null;
  /** The fault's kind and its sentence, when it failed or was stopped. */
  fault: { kind: string; said: string } | null;
}

/** A short test clip: 2 seconds, 480 by 272 (Wan's small size kept to a 16 step), Draft. */
export const TEST_CLIP = { seconds: 2, width: 480, height: 272, quality: 'draft' as const, prompt: 'A red ball rolls slowly across a wooden table, soft daylight.' };

export class VideoTestDoor {
  private view: VideoTestView = { state: 'idle', model: null, started: null, progress: null, clip: null, fault: null };
  private stopper: AbortController | null = null;
  private starting = false;
  /** The clip being made (the tests wait on it). */
  done: Promise<void> = Promise.resolve();

  private readonly runner: VideoRunner;
  private readonly busyWhy: () => string;

  constructor(runner: VideoRunner, busyWhy: () => string = () => '') {
    this.runner = runner;
    this.busyWhy = busyWhy;
  }

  state(): VideoTestView {
    return { ...this.view, progress: this.view.progress ? { ...this.view.progress } : null };
  }

  /** Starts one clip of `b.model` (and the test clip's settings, or those given). 202 started, 409 not now. */
  async start(b: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    // A second press while the first is still being started (the runner is looked for) is refused as one already running.
    if (this.view.state === 'running' || this.starting) return { status: 409, json: { error: 'A test clip is being made already. Wait for it, or stop it.', test: this.state() } };
    const busy = this.busyWhy();
    if (busy) return { status: 409, json: { error: `Not now: ${busy}.` } };
    const model = typeof b.model === 'string' ? b.model.trim() : '';
    if (!model) return { status: 400, json: { error: 'Name the video model to test (its id).' } };
    this.starting = true;
    try {
      if (!(await this.runner.installed())) return { status: 409, json: { error: VIDEO_WORDS.notInstalled } };
    } finally {
      this.starting = false;
    }
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const quality = b.quality === 'normal' || b.quality === 'best' ? b.quality : TEST_CLIP.quality;
    const job: VideoJob = {
      model,
      prompt: typeof b.prompt === 'string' && b.prompt.trim() ? b.prompt.trim().slice(0, 2000) : TEST_CLIP.prompt,
      seconds: num(b.seconds, TEST_CLIP.seconds),
      width: num(b.width, TEST_CLIP.width),
      height: num(b.height, TEST_CLIP.height),
      quality,
      ...(typeof b.seed === 'number' ? { seed: b.seed } : {}),
    };
    const stopper = new AbortController();
    this.stopper = stopper;
    this.view = { state: 'running', model, started: new Date().toISOString(), progress: null, clip: null, fault: null };
    this.done = this.runner.make(job, p => (this.view.progress = p), stopper.signal).then(
      clip => {
        this.view = { ...this.view, state: 'done', clip };
      },
      (e: unknown) => {
        const kind = e instanceof VideoFault ? e.kind : 'crashed';
        this.view = { ...this.view, state: kind === 'stopped' ? 'stopped' : 'failed', fault: { kind, said: (e as Error)?.message ?? String(e) } };
      },
    ).finally(() => {
      if (this.stopper === stopper) this.stopper = null;
    });
    return { status: 202, json: { test: this.state() } };
  }

  stop(): { test: VideoTestView } {
    this.stopper?.abort();
    return { test: this.state() };
  }
}
