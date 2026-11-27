// A clip asked of a Videographer in their chat: one at a time on each PC (the rest wait in turn), its progress with the
// time left, Stop, and the finished file kept on the Videos shelf (src/gallery.ts ClipShelf) with a line in the chat.
// The engine is any VideoRunner (src/videotypes.ts), given by the server: this file never runs one itself, and nothing
// here goes over the network. Tested in test/clips.test.ts with the fake runner in test/fakeclip.ts.
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { firstWords, stamp, stampOf } from './folders.ts';
import type { ChatLine } from './store.ts';
import type { ClipRecord, ClipShelf, ClipStart } from './gallery.ts';
import { isHdModel, videoModel } from './videomodels.ts';
import { isPng, LOW_DISK_BYTES, MAX_CLIP_SECONDS, VideoFault, type VideoFaultKind, type VideoProgress, type VideoQuality, type VideoRunner } from './videotypes.ts';

/** The hire's role id for a Videographer (the role itself is set up with the hire screens). */
export const VIDEOGRAPHER = 'videographer';
export const isVideographer = (m: { role?: unknown } | null | undefined): boolean => !!m && m.role === VIDEOGRAPHER;

/**
 * The shapes a clip can have, as the picture sizes are offered: wide first. `hd`: a 720p size, offered only for a model
 * made for 720p (Wan 2.2 5B: clipSizesFor).
 */
export const CLIP_SIZES = [
  { id: 'wide', name: 'Wide', width: 832, height: 480, hd: false },
  { id: 'tall', name: 'Tall', width: 480, height: 832, hd: false },
  { id: 'square', name: 'Square', width: 624, height: 624, hd: false },
  { id: 'wide720', name: 'Wide 720p', width: 1280, height: 704, hd: true },
  { id: 'tall720', name: 'Tall 720p', width: 704, height: 1280, hd: true },
] as const;
export type ClipSize = (typeof CLIP_SIZES)[number];
/** The sizes offered for clips made with `model`: the 720p ones only for a model made for 720p. */
export const clipSizesFor = (model: unknown): ClipSize[] => CLIP_SIZES.filter(s => !s.hd || isHdModel(model));
/** The line when a size is not offered for `model` ('' when it is). */
export function sizeRefused(width: number, height: number, model: unknown): string {
  const s = CLIP_SIZES.find(x => x.width === width && x.height === height);
  return s?.hd && !isHdModel(model) ? `${s.name} is for a video model made for 720p (Wan 2.2 5B): pick Wide, Tall or Square.` : '';
}
/** A clip's pixels against a Wide clip's, for the time guesses (a 720p clip has about 2.3 times as many). */
export const areaOf = (width: number, height: number): number => (width > 0 && height > 0 ? (width * height) / (832 * 480) : 1);
export const CLIP_QUALITIES: ReadonlyArray<{ id: VideoQuality; name: string; hint: string }> = [
  { id: 'draft', name: 'Draft', hint: 'Quick look: fewer steps, rougher motion' },
  { id: 'normal', name: 'Normal', hint: 'What the model is made for' },
  { id: 'best', name: 'Best', hint: 'More steps: slower' },
];
export const PROMPT_MAX = 1000;
/**
 * The longest prompt Make again takes: a shelf clip keeps its prompt with the @names filled in (the cards' words added),
 * which can be well over PROMPT_MAX, and that is the prompt it is made again from.
 */
export const FILLED_MAX = 8000;
/** Clips waiting on one PC, the one being made not counted. */
export const WAIT_MAX = 5;

/** Plain words for each fault, when the runner gave none. */
export const FAULT_WORDS: Record<VideoFaultKind, string> = {
  'not-installed': 'The video runner is not installed on this PC yet: install it under Settings, Models, then ask again.',
  'missing-model': 'The video model for this hire is not on this PC: download it under Settings, Models, or pick another in Edit staff.',
  'out-of-memory': 'The graphics card ran out of memory making this clip. Try a shorter clip, a smaller size or Draft.',
  'low-disk': 'There is under 2 GB free where clips are kept, so no clip was made. Free up some space, then ask again.',
  crashed: 'The video runner stopped by itself part way, so no clip was made. Ask again; if it keeps stopping, restart TOMLIN.',
  stopped: 'Stopped: no clip was made.',
  busy: 'This PC is busy making other clips. Ask again once one of them is done.',
  'pc-off': 'The PC this hire works on did not answer, so no clip was made.',
};

export type ClipState = 'queued' | 'loading' | 'making' | 'joining' | 'done' | 'failed' | 'stopped';
const RUNNING: ClipState[] = ['queued', 'loading', 'making', 'joining'];
export const isRunning = (s: ClipState): boolean => RUNNING.includes(s);

export interface ClipAsk {
  prompt: string;
  seconds: number;
  width: number;
  height: number;
  quality: VideoQuality;
  /** The video model, as the hire has it ('' = none chosen). */
  model: string;
  /** Who makes it ("staff:<id>") and their name, for the lines. */
  who: string;
  name: string;
  chat: string;
  /** The PC it is made on: 'here' for this one. One clip at a time on each. */
  pc: string;
  /** The PNG the clip starts from (already fitted to width by height), on this PC; removed once the clip ends. */
  startPicture?: string;
  /** The picture as it was chosen, kept with the clip once it is made (keepStart). */
  start?: StartPlan;
  /** That PC's name for the lines and the shelf ('this PC' when not given). */
  pcName?: string;
  /** The seed: always one, so the clip can be made again the same. */
  seed: number;
  /** Words to leave out of the clip ('' = none). */
  negative?: string;
  /** Steps asked by hand (none = the quality's own). */
  steps?: number;
  /** The id a linked PC makes it under (a shot keeps it, so a restart here follows the clip there: VideoJob.linkId). */
  linkId?: string;
}

/**
 * A clip's start picture as chosen: `file` is a picture already on this PC (a gallery picture, a project's) or, when
 * `fresh`, a new PNG (from a file, a clip's frame) waiting in data/videos/starts. `name`: words for its file name.
 * `into`: the project's Start frames folder when the chat belongs to a project (absolute, and relative to the workspace).
 */
export interface StartPlan {
  file: string;
  fresh: boolean;
  name: string;
  into?: { dir: string; rel: string };
}

/**
 * Keeps a made clip's start picture, never as an extra copy: a picture already on this PC stays where it is and, in a
 * project, is hard-linked into its Start frames folder (the same file, no extra space); only when that folder is on
 * another drive is it copied (`copied`). A fresh PNG is moved there (or stays in data/videos/starts outside a project).
 */
export async function keepStart(plan: StartPlan, now = new Date(), fsx: { link: typeof link; rename: typeof rename } = { link, rename }): Promise<ClipStart> {
  if (!plan.into) return { path: plan.file };
  const ext = extname(plan.file).toLowerCase() || '.png';
  // A project picture's name has its own date and time: the new one is put in front instead.
  const words = firstWords(plan.name.replace(/^\d{4}-\d{2}-\d{2}-\d{4}(?:-\d+)?\s*/, '') || 'start');
  await mkdir(plan.into.dir, { recursive: true });
  let name = `${stamp(now)} ${words}${ext}`;
  for (let n = 2; existsSync(join(plan.into.dir, name)); n++) name = `${stamp(now)} ${words} ${n}${ext}`;
  const to = join(plan.into.dir, name);
  const rel = `${plan.into.rel}/${name}`;
  if (plan.fresh) {
    // A new PNG: moved into the project as a plain file (across drives: copied, then removed here).
    await fsx.rename(plan.file, to).catch(async (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EXDEV') throw e;
      await copyFile(plan.file, to);
      await rm(plan.file, { force: true });
    });
    return { path: to, project: rel };
  }
  try {
    await fsx.link(plan.file, to);
    return { path: plan.file, project: rel };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await copyFile(plan.file, to);
    return { path: plan.file, project: rel, copied: true };
  }
}

/** The pictures in a project's specialists\images folder `dir` (`rel` in the workspace), newest first by the stamp in each name. */
export async function picturesIn(dir: string, rel: string): Promise<{ path: string; name: string; at: string }[]> {
  const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: { path: string; name: string; at: string; key: string }[] = [];
  for (const d of names) {
    if (!d.isFile() || !/\.(png|webp)$/i.test(d.name)) continue;
    const at = await stat(join(dir, d.name)).then(s => s.mtime.toISOString(), () => new Date(0).toISOString());
    out.push({ path: `${rel}/${d.name}`, name: d.name, at, key: stampOf(d.name) ?? stamp(new Date(at)) });
  }
  return out.sort((a, b) => b.key.localeCompare(a.key) || b.at.localeCompare(a.at)).map(({ key: _key, ...p }) => p);
}

/** The clip line's words when the start picture had to be copied into the project. */
export const copiedLine = (rel: string): string => `The start picture was copied into ${rel.split('/').slice(0, -1).join('\\')} (not linked): that folder is on another drive.`;

export interface ClipView {
  id: string;
  state: ClipState;
  prompt: string;
  seconds: number;
  width: number;
  height: number;
  quality: VideoQuality;
  chat: string;
  who: string;
  /** True when it starts from a picture. */
  start: boolean;
  seed: number;
  /** Frames made of all (or steps, as the runner counts them); 0 of 0 while not known. */
  done: number;
  total: number;
  /** Seconds left: the runner's figure, else worked out from the time each frame took; null while not known. */
  secondsLeft: number | null;
  /** Seconds since it started (or was asked, while it waits). */
  elapsed: number;
  /** Clips before it on this PC, while it waits. */
  waiting: number;
  /** The plain line when it failed or was stopped. */
  error: string | null;
  fault: VideoFaultKind | null;
  clip: ClipRecord | null;
}

interface Job {
  id: string;
  ask: ClipAsk;
  state: ClipState;
  progress: VideoProgress | null;
  askedAt: number;
  startedAt: number;
  makingAt: number;
  makingFrom: number;
  /** When the clip file began to be written, and the runner's figure for it then (counted down from there). */
  joinAt: number;
  joinLeft: number | null;
  error: string | null;
  fault: VideoFaultKind | null;
  clip: ClipRecord | null;
  ac: AbortController;
}

export interface ClipsDeps {
  /** The engine for clips made on `pc` ('here', or a linked PC's id); null while none is set up (said as not installed). */
  runner: (pc: string, hire?: { id: string; first: string }) => VideoRunner | null;
  shelf: ClipShelf;
  /** Bytes free on the drive of `dir`, or null when it cannot be read. */
  free: (dir: string) => Promise<number | null>;
  /** Keeps a made clip's start picture (keepStart); tests may stand in for it. */
  keepStart?: (plan: StartPlan) => Promise<ClipStart>;
  /** Writes a finished, failed or stopped clip's line at the end of its chat. */
  saveLine: (chat: string, line: ChatLine) => Promise<void>;
  /** A finished clip, with the full path of its file on the shelf (a project chat's copy goes into that project). */
  made?: (clip: ClipRecord, file: string) => Promise<void>;
  now?: () => number;
}

/** Steps asked by hand: 1 to this (as src/video.ts takes them). */
export const STEPS_MAX = 60;
/** The highest seed asked by hand; a random one is under it too. */
export const SEED_MAX = 2 ** 32 - 1;
export const randomSeed = (): number => randomInt(0, 2 ** 31);

export type CleanAsk = { prompt: string; seconds: number; width: number; height: number; quality: VideoQuality; seed: number; negative?: string; steps?: number };

/**
 * The ask as the page sent it, made safe: a prompt, 1 to MAX_CLIP_SECONDS seconds, one of the sizes and qualities, the
 * words to leave out, the seed (a random one when none is asked) and the steps (none = the quality's own).
 */
export function cleanAsk(b: Record<string, unknown>, seed: () => number = randomSeed): CleanAsk | { error: string } {
  const prompt = String(b.prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!prompt) return { error: 'Type what the clip should show first.' };
  // Make again (againAsk) sends a prompt whose @names were already filled in: it may be longer than one typed.
  const most = b.filled === true ? FILLED_MAX : PROMPT_MAX;
  if (prompt.length > most) return { error: `That is too long for a clip (over ${most.toLocaleString('en-GB')} characters): say what it shows in a few lines.` };
  const n = Math.round(Number(b.seconds));
  const seconds = Number.isFinite(n) ? Math.min(MAX_CLIP_SECONDS, Math.max(1, n)) : 3;
  const size = CLIP_SIZES.find(s => s.id === b.size) ?? CLIP_SIZES[0];
  const quality = CLIP_QUALITIES.find(q => q.id === b.quality)?.id ?? 'normal';
  const negative = String(b.negative ?? '').replace(/\s+/g, ' ').trim();
  if (negative.length > PROMPT_MAX) return { error: `The words to leave out are too long (over ${PROMPT_MAX.toLocaleString('en-GB')} characters).` };
  const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
  let asked: number = seed();
  if (!blank(b.seed)) {
    const n = Number(String(b.seed).trim());
    if (!Number.isInteger(n) || n < 0 || n > SEED_MAX) return { error: `The seed is a whole number from 0 to ${SEED_MAX.toLocaleString('en-GB')}: leave it empty for a random one.` };
    asked = n;
  }
  let steps: number | undefined;
  if (!blank(b.steps)) {
    const n = Number(String(b.steps).trim());
    if (!Number.isInteger(n) || n < 1 || n > STEPS_MAX) return { error: `Steps is a whole number from 1 to ${STEPS_MAX}: leave it empty for the quality's own.` };
    steps = n;
  }
  return { prompt, seconds, width: size.width, height: size.height, quality, seed: asked, ...(negative ? { negative } : {}), ...(steps ? { steps } : {}) };
}

/** The size id of a clip's width and height ('wide' when it is none of them). */
export const sizeIdOf = (w: number, h: number): string => CLIP_SIZES.find(s => s.width === w && s.height === h)?.id ?? CLIP_SIZES[0].id;

/** The ask that makes a shelf clip again, in its own chat with the same hire: the same seed, or a new random one. */
export function againAsk(c: ClipRecord, seed: 'same' | 'new'): Record<string, unknown> {
  return {
    // The shelf keeps the prompt as it was made, its @names filled in (filled: it may be over PROMPT_MAX).
    chatId: c.chat, who: c.who, prompt: c.prompt, filled: true, seconds: c.seconds, size: sizeIdOf(c.width, c.height), quality: c.quality,
    negative: c.negative ?? '', steps: c.steps ?? '', seed: seed === 'same' && typeof c.seed === 'number' ? c.seed : '',
    // A clip that started from a picture starts from it again.
    ...(c.start ? { startFrom: { clip: c.id } } : {}),
  };
}

/** A video joined from a shot list's shots (src/server/shots.ts joinShots): not made from one prompt, so never made again. */
export const isJoined = (c: Pick<ClipRecord, 'quality'>): boolean => c.quality === 'joined';

/**
 * What the clip viewer says of a clip beside its record: its model by name (an id it does not know, as it is), and for a
 * joined video the shots it joined, by number (as kept with it; one joined before they were kept, read from its words).
 */
export function clipAbout(c: ClipRecord): { modelName: string; joined: number[] | null } {
  const modelName = videoModel(c.model)?.name ?? c.model;
  if (!isJoined(c)) return { modelName, joined: null };
  if (Array.isArray(c.joined)) return { modelName, joined: c.joined.filter(n => Number.isInteger(n)) };
  // "Vic's shot list joined: shots 1, 2, 4, 6 s (not made yet: 3)": the numbers before its length.
  const m = /joined: shots ([^(]*)/.exec(c.prompt);
  return { modelName, joined: m ? m[1].split(',').map(x => x.trim()).filter(x => /^\d+$/.test(x)).map(Number) : [] };
}

/** The largest picture the page may send to start a clip from, before it is fitted to the clip's size. */
export const START_SENT_MAX = 16 * 2 ** 20;

/**
 * The start picture as the page sent it (a PNG data URL, which the page makes from a gallery picture, a file or a
 * frame of a clip): null when none was sent, else its bytes, or the plain line it is refused with.
 */
export function startFromPage(v: unknown): Buffer | null | { error: string } {
  if (v === undefined || v === null || v === '') return null;
  const m = typeof v === 'string' ? /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(v) : null;
  if (!m) return { error: 'The start picture was not a PNG picture. Add it again (from the gallery or a file).' };
  if (m[1].length > Math.ceil(START_SENT_MAX / 3) * 4) return { error: `The start picture is too large (over ${START_SENT_MAX / 2 ** 20} MB). Pick a smaller one.` };
  const png = Buffer.from(m[1], 'base64');
  if (!isPng(png)) return { error: 'The start picture was not a PNG picture. Add it again (from the gallery or a file).' };
  return png;
}

/** "2 min 5 s", "40 s". */
export function secondsWords(s: number): string {
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m} min${r ? ` ${r} s` : ''}`;
}

/** The low-disk line for where clips are kept ('' when there is room or the free space is not known). */
export function lowDiskLine(free: number | null): string {
  if (free === null || free >= LOW_DISK_BYTES) return '';
  return `Under 2 GB free where clips are kept (${(free / 2 ** 30).toFixed(1)} GB): no new clip can be made until some space is freed.`;
}

/** The plain line for anything that ended a clip. */
export function faultOf(e: unknown, stopped: boolean): { kind: VideoFaultKind; text: string } {
  if (e instanceof VideoFault) return { kind: e.kind, text: e.message.trim() || FAULT_WORDS[e.kind] };
  if (stopped) return { kind: 'stopped', text: FAULT_WORDS.stopped };
  const said = e instanceof Error ? e.message.trim() : '';
  return { kind: 'crashed', text: said ? `The clip could not be made: ${said.replace(/\.$/, '')}.` : FAULT_WORDS.crashed };
}

/** The progress line the chat shows while a clip is on its way. */
export function progressLine(v: Pick<ClipView, 'state' | 'done' | 'total' | 'secondsLeft' | 'elapsed' | 'waiting'>): string {
  const left = v.secondsLeft != null ? ` · about ${secondsWords(v.secondsLeft)} left` : '';
  const so = ` · ${secondsWords(v.elapsed)} so far`;
  switch (v.state) {
    case 'queued': return `Waiting for the clip before it${v.waiting > 1 ? ` (${v.waiting} before it)` : ''}`;
    case 'loading': return `Loading the video model${left}${so}`;
    case 'making': return `Making the clip${v.total ? ` · step ${v.done} of ${v.total}` : ''}${left}${so}`;
    case 'joining': return `Writing the clip file${left}${so}`;
    default: return '';
  }
}

const KEEP_ENDED = 30;

export class Clips {
  private deps: ClipsDeps;
  private jobs: Job[] = [];

  constructor(deps: ClipsDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Puts a clip in line on its PC; it starts at once when that PC is free. */
  start(ask: ClipAsk): ClipView | { refused: string; fault: VideoFaultKind } {
    const waiting = this.jobs.filter(j => j.ask.pc === ask.pc && j.state === 'queued').length;
    if (waiting >= WAIT_MAX) return { refused: `${WAIT_MAX} clips are already waiting on this PC. Ask again once one of them is done.`, fault: 'busy' };
    const t = this.now();
    const job: Job = { id: randomBytes(6).toString('hex'), ask, state: 'queued', progress: null, askedAt: t, startedAt: 0, makingAt: 0, makingFrom: 0, joinAt: 0, joinLeft: null, error: null, fault: null, clip: null, ac: new AbortController() };
    this.jobs.push(job);
    this.pump(ask.pc);
    return this.viewOf(job);
  }

  /** Stop: a clip being made is told to stop; one waiting is taken out of line. False when it was not running. */
  stop(id: string): boolean {
    const job = this.jobs.find(j => j.id === id);
    if (!job || !isRunning(job.state)) return false;
    if (job.state === 'queued') {
      job.ac.abort();
      void this.end(job, new VideoFault('stopped', FAULT_WORDS.stopped)).then(() => this.dropStart(job));
      return true;
    }
    job.ac.abort();
    return true;
  }

  view(id: string): ClipView | null {
    const job = this.jobs.find(j => j.id === id);
    return job ? this.viewOf(job) : null;
  }

  /** The newest clip asked in a chat (running or ended here since TOMLIN started), or null. */
  forChat(chat: string): ClipView | null {
    const job = [...this.jobs].reverse().find(j => j.ask.chat === chat);
    return job ? this.viewOf(job) : null;
  }

  /** Every clip still running, oldest first. */
  running(): ClipView[] {
    return this.jobs.filter(j => isRunning(j.state)).map(j => this.viewOf(j));
  }

  /**
   * A chat was deleted: its clips are stopped (or taken out of line) and nothing more is written to it, not even the
   * line saying they stopped, so its file is never made again. Its ended clips are no longer found by the chat.
   */
  dropChat(chat: string): void {
    if (!chat) return;
    for (const j of this.jobs) {
      if (j.ask.chat !== chat) continue;
      j.ask = { ...j.ask, chat: '' };
      if (isRunning(j.state)) this.stop(j.id);
    }
  }

  /** Stops everything (TOMLIN closing). */
  stopAll(): void {
    for (const j of this.jobs) if (isRunning(j.state)) this.stop(j.id);
  }

  private viewOf(j: Job): ClipView {
    const t = this.now();
    const p = j.progress;
    let left = p?.secondsLeft ?? null;
    // Not said by the runner: the time each frame took so far, times the frames to go.
    if (left === null && j.state === 'making' && p && p.total > 0 && p.done > j.makingFrom && j.makingAt) {
      const each = (t - j.makingAt) / 1000 / (p.done - j.makingFrom);
      left = Math.max(1, Math.round(each * (p.total - p.done)));
    }
    // Writing the file: the runner says its figure once, so it is counted down from then; once it is used up, only the
    // time so far is shown (never a figure that stands still).
    if (j.state === 'joining') {
      const rest = j.joinLeft === null ? 0 : Math.round(j.joinLeft - (t - j.joinAt) / 1000);
      left = rest >= 1 ? rest : null;
    }
    const before = j.state === 'queued' ? this.jobs.filter(x => x.ask.pc === j.ask.pc && isRunning(x.state) && x !== j && this.jobs.indexOf(x) < this.jobs.indexOf(j)).length : 0;
    return {
      id: j.id, state: j.state, prompt: j.ask.prompt, seconds: j.ask.seconds, width: j.ask.width, height: j.ask.height, quality: j.ask.quality, chat: j.ask.chat, who: j.ask.who, seed: j.ask.seed, start: !!j.ask.startPicture,
      done: p?.done ?? 0, total: p?.total ?? 0, secondsLeft: isRunning(j.state) ? left : null,
      elapsed: Math.max(0, Math.round((t - (j.startedAt || j.askedAt)) / 1000)), waiting: before, error: j.error, fault: j.fault, clip: j.clip,
    };
  }

  /** The next clip waiting on `pc` starts when nothing else is being made there. */
  private pump(pc: string): void {
    if (this.jobs.some(j => j.ask.pc === pc && ['loading', 'making', 'joining'].includes(j.state))) return;
    const next = this.jobs.find(j => j.ask.pc === pc && j.state === 'queued');
    if (!next) return;
    next.state = 'loading';
    next.startedAt = this.now();
    void this.run(next);
  }

  private async run(job: Job): Promise<void> {
    const { ask } = job;
    try {
      const runner = this.deps.runner(ask.pc, { id: ask.who.replace(/^staff:/, ''), first: ask.name });
      if (!runner || !(await runner.installed())) throw new VideoFault('not-installed', FAULT_WORDS['not-installed']);
      if (!ask.model) throw new VideoFault('missing-model', `${ask.name} has no video model yet: pick one in Edit staff, then ask again.`);
      await mkdir(this.deps.shelf.dir, { recursive: true });
      const free = await this.deps.free(this.deps.shelf.dir);
      if (free !== null && free < LOW_DISK_BYTES) throw new VideoFault('low-disk', lowDiskLine(free));
      if (job.ac.signal.aborted) throw new VideoFault('stopped', FAULT_WORDS.stopped);
      const job0 = { prompt: ask.prompt, seconds: ask.seconds, width: ask.width, height: ask.height, quality: ask.quality, model: ask.model, seed: ask.seed, ...(ask.negative ? { negative: ask.negative } : {}), ...(ask.steps ? { steps: ask.steps } : {}), ...(ask.startPicture ? { startPicture: ask.startPicture } : {}), ...(ask.linkId ? { linkId: ask.linkId } : {}) };
      const made = await runner.make(job0, p => {
        if (!isRunning(job.state)) return;
        if (p.stage === 'making' && job.state !== 'making') {
          job.makingAt = this.now();
          job.makingFrom = p.done;
        }
        if (p.stage === 'joining' && job.state !== 'joining') {
          job.joinAt = this.now();
          job.joinLeft = p.secondsLeft;
        }
        job.state = p.stage;
        job.progress = p;
      }, job.ac.signal);
      if (job.ac.signal.aborted) throw new VideoFault('stopped', FAULT_WORDS.stopped);
      if (job.state !== 'joining') {
        job.joinAt = this.now();
        job.joinLeft = null;
      }
      job.state = 'joining';
      const ext = made.mime === 'video/mp4' ? 'mp4' : 'webm';
      const file = await this.deps.shelf.take(made.file, `clip-${job.id}.${ext}`);
      // The start picture, kept: never a fault for the clip (it is made); the line says what could not be done.
      let start: ClipStart | undefined;
      let startNote = '';
      if (ask.start) {
        try {
          start = await (this.deps.keepStart ?? keepStart)(ask.start);
          if (start.copied && start.project) startNote = ` ${copiedLine(start.project)}`;
        } catch (e) {
          start = { path: ask.start.file };
          startNote = ` The start picture could not be put in the project's Start frames folder (${(e as Error).message}).`;
        }
      }
      const record: ClipRecord = {
        id: job.id, at: new Date(this.now()).toISOString(), prompt: ask.prompt, seconds: made.seconds, width: made.width, height: made.height, quality: ask.quality,
        model: made.model, file, mime: made.mime, bytes: made.bytes, tookMs: made.tookMs, who: ask.who, chat: ask.chat,
        seed: ask.seed, ...(ask.negative ? { negative: ask.negative } : {}), ...(ask.steps ? { steps: ask.steps } : {}), pc: ask.pcName ?? (ask.pc === 'here' ? 'this PC' : ask.pc), ...(start ? { start } : {}),
      };
      try {
        await this.deps.shelf.add(record);
      } catch (e) {
        // The clip was made, but the shelf's list could not take it: its file is not left behind on no list, and the
        // line says it is the shelf that failed (not the runner).
        await rm(join(this.deps.shelf.dir, file), { force: true }).catch(() => undefined);
        throw new VideoFault('crashed', `The clip was made, but it could not be put on the Videos shelf (${(e as Error).message.replace(/\.$/, '')}), so it was not kept. Check there is room where clips are kept, then ask again.`);
      }
      // Never a fault: the clip is on the shelf either way.
      await this.deps.made?.(record, join(this.deps.shelf.dir, file)).catch(error => console.warn(`A clip could not be copied to its project: ${(error as Error).message}`));
      job.clip = record;
      job.state = 'done';
      await this.say(job, {
        role: 'assistant', content: `A ${record.seconds} s clip: ${ask.prompt}${startNote}`, at: record.at, ran: `on ${record.pc} in ${secondsWords(record.tookMs / 1000)}`,
        clip: { id: record.id, file: record.file, mime: record.mime, prompt: ask.prompt, seconds: record.seconds, width: record.width, height: record.height, ...(start ? { start: { name: basename(start.project ?? start.path), ...(start.copied ? { copied: true } : {}) } } : {}) },
      });
    } catch (e) {
      await this.end(job, e);
    } finally {
      await this.dropStart(job);
      this.pump(ask.pc);
      this.trim();
    }
  }

  /** A clip that failed or was stopped: its plain line in the chat. */
  private async end(job: Job, e: unknown): Promise<void> {
    if (!isRunning(job.state)) return;
    const f = faultOf(e, job.ac.signal.aborted);
    job.state = f.kind === 'stopped' ? 'stopped' : 'failed';
    job.error = f.text;
    job.fault = f.kind;
    const at = new Date(this.now()).toISOString();
    await this.say(job, f.kind === 'stopped' ? { role: 'assistant', content: f.text, at, stopped: true, ran: 'written by the app, no model' } : { role: 'assistant', content: f.text, at, failed: true });
  }

  /** The fitted copy is needed only while its clip is made; a fresh start picture is kept only with a made clip. */
  private async dropStart(job: Job): Promise<void> {
    if (job.ask.startPicture) await rm(job.ask.startPicture, { force: true }).catch(() => undefined);
    if (job.state !== 'done' && job.ask.start?.fresh) await rm(job.ask.start.file, { force: true }).catch(() => undefined);
  }

  private async say(job: Job, line: ChatLine): Promise<void> {
    if (!job.ask.chat) return;
    await this.deps.saveLine(job.ask.chat, line).catch(error => console.warn(`A clip's line could not be written to its chat: ${(error as Error).message}`));
  }

  /** Only the last few ended clips are kept to look at. */
  private trim(): void {
    const ended = this.jobs.filter(j => !isRunning(j.state));
    if (ended.length <= KEEP_ENDED) return;
    const drop = new Set(ended.slice(0, ended.length - KEEP_ENDED));
    this.jobs = this.jobs.filter(j => !drop.has(j));
  }
}
