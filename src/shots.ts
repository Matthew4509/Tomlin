// The shot list: a Videographer's queue of shots, so a long video is made unattended. Each shot is one clip asked of
// src/clips.ts (one at a time on each PC, as any clip), in order, with its start (none, the last frame of the shot
// before, or a picture), Make 3 for takes with new seeds and Keep this one, a Draft pass and the kept ones at Normal.
// The list is kept in data/shots.json (written whole or not at all) and carries on after TOMLIN restarts from the shot
// it was on. A failed shot is tried once more, then the list moves on; the PC's owner pressing "I need to use the pc"
// (the clip's busy fault) holds the list until the PC is free again. The time left is worked out from each PC's own
// measured seconds per step (a small rolling figure per PC and model). Tested in test/shots.test.ts with test/fakeclip.ts.
import { randomBytes, randomInt } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { readData, writeAtomic } from './atomic.ts';
import { CLIP_QUALITIES, CLIP_SIZES, PROMPT_MAX, areaOf, isRunning, sizeRefused, type ClipAsk, type ClipView } from './clips.ts';
import type { ColourRef } from './colourmatch.ts';
import { stepsFor, videoModel } from './videomodels.ts';
import { MAX_CLIP_SECONDS, type VideoFaultKind, type VideoQuality } from './videotypes.ts';

/** Shots in one list at most. */
export const SHOTS_MAX = 200;
/** Takes "Make 3" asks for. */
export const TAKES = 3;
/** A failed shot is made this many times in all before the list moves on. */
export const TRIES = 2;
/** While the PC's owner is using it, the list looks again this often. */
export const HELD_MS = 2 * 60_000;
/** The rolling figure: the last few finished clips on each PC and model. */
export const ROLL = 5;
/** Steps a clip takes at each quality until one has been made (the runner's own count replaces it). */
export const STEPS_GUESS: Record<VideoQuality, number> = { draft: 12, normal: 20, best: 30 };

/** A picture already on this PC: a gallery picture (its id) or a project's (its workspace path). */
export type StartFrom = { gallery: string } | { project: string };
/**
 * Where a shot starts: nothing, the last frame of the shot before (read on the page), or a picture: one kept for the
 * shot list (`file`, in data/shots/pictures) or one already on this PC (`from`). `name`: words for its file name;
 * `src`: its preview on the page.
 */
export type ShotStart = { kind: 'none' } | { kind: 'last' } | { kind: 'picture'; file?: string; from?: StartFrom; name: string; src?: string };
export type ShotState = 'waiting' | 'making' | 'done' | 'failed' | 'skipped';
/** idle: not started (or ended); scheduled: waits for its start time; held: the PC's owner is using it. */
export type RunState = 'idle' | 'running' | 'pausing' | 'paused' | 'scheduled' | 'held';

/** One finished clip of a shot (it is on the Videos shelf as well). */
export interface Take {
  clip: string;
  file: string;
  mime: 'video/mp4' | 'video/webm';
  seed: number;
  quality: VideoQuality;
  seconds: number;
  width: number;
  height: number;
  at: string;
  tookMs: number;
}

export interface Shot {
  id: string;
  prompt: string;
  seconds: number;
  size: string;
  /** The quality asked for this shot (a Draft pass makes it at Draft first). */
  quality: VideoQuality;
  start: ShotStart;
  state: ShotState;
  /** Takes still to make before it is done: 1, or up to TAKES after Make 3. */
  want: number;
  /** The next take's quality and seed (null: a new seed). */
  next: { quality: VideoQuality; seed: number | null; keep: boolean };
  tries: number;
  takes: Take[];
  /** The take kept (its clip id), when there is a choice. */
  kept: string | null;
  /** The clip being made for it now. */
  job: string | null;
  /**
   * The last frame of the shot before, as the page read it: that take's clip and the PNG the shot starts from (its
   * colours matched to the list's reference when the list keeps them); `raw`: the frame as it was read, when matched.
   */
  frame?: { clip: string; file: string; raw?: string };
  error: string | null;
  fault: VideoFaultKind | null;
  /**
   * The id a linked PC knows the take being made by. A take cut by a restart here asks again with the same id (`resume`),
   * so the linked PC hands over the clip it is still making or made, never makes it again (an hour lost each time).
   */
  link?: string;
  resume?: string;
}

export interface ShotList {
  chat: string;
  /** The hire ("staff:<id>"), their first name, the PC they work on and its name, and their video model. */
  who: string;
  name: string;
  pc: string;
  pcName: string;
  model: string;
  shots: Shot[];
  run: RunState;
  /** Scheduled: when it starts. */
  startAt: string | null;
  /** Held: when it looks again. */
  heldUntil: number | null;
  /** Draft pass: every take made at Draft. */
  draft: boolean;
  /** The last thing the list said (how it ended, why it waits). */
  said: string;
  /** Keep the colours of the first shot: on unless turned off (a list from before it is on). */
  colour?: boolean;
  /** The colours each carried-on frame is matched to, the same for every shot (src/colourmatch.ts). */
  ref?: ColourRef | null;
}

/** Where a list's colour reference comes from now: shot 1's start picture, or the first last frame kept for the list. */
export type RefSource = { key: string; picture: { kept: string; name: string } | { from: StartFrom; name: string } | null; width: number; height: number };

/** Seconds per step for each clip second are kept for a Wide clip's pixels (areaOf), so other sizes are scaled from it. */
interface Speed { perStepSecond: number[]; steps: Partial<Record<VideoQuality, number>> }
interface ShotsFile { version: 1; lists: Record<string, ShotList>; speeds: Record<string, Speed> }

/** What the list needs of src/clips.ts. */
export interface ClipMaker {
  start(ask: ClipAsk): ClipView | { refused: string; fault: VideoFaultKind };
  view(id: string): ClipView | null;
  stop(id: string): boolean;
}

/**
 * Gives a shot's clip its start picture (src/server/shots.ts, with src/server/clips.ts fitStart): `kept` a PNG kept for
 * the shot list (a picture from a file, or the last frame of the shot before as the page read it), or `from` a picture
 * already on this PC. Gives back the ask to make (with its start picture), or a plain line why it cannot.
 */
export interface StartPictures {
  give(ask: ClipAsk, from: { kept: string; name: string } | { from: StartFrom; name: string }): Promise<{ ask: ClipAsk } | { refused: string }>;
}

/** The line while a shot waits for its last frame. */
export const WAIT_PAGE = 'Reading the last frame of the shot before.';

export interface ShotsDeps {
  file: string;
  clips: ClipMaker;
  starts: StartPictures;
  now?: () => number;
  /** A new seed (tests give their own). */
  seed?: () => number;
  /**
   * A shot's words with its project's @names filled in (src/server/cards.ts), and the named cards' words to leave out
   * (`avoid`, added to the clip's negative prompt); none: as typed.
   */
  expand?: (prompt: string, chat: string) => Promise<string | { prompt: string; avoid?: string }>;
  /** Whether a clip is still on the Videos shelf (a shot that carries on from it waits for its last frame only then). */
  exists?: (clip: string) => Promise<boolean>;
  /** Pictures kept for the list (data/shots/pictures names) that no shot uses any more: removed, unless a clip uses one. */
  dropPictures?: (names: string[]) => Promise<void>;
}

export interface ShotView extends Shot {
  n: number;
  /** The progress line while it is made, and its share done (0 to 1). */
  line: string;
  frac: number;
  /** Seconds left on this shot (its clip's figure, else the PC's), null while not known. */
  left: number | null;
}

export interface ListView {
  chat: string;
  run: RunState;
  startAt: string | null;
  draft: boolean;
  said: string;
  pcName: string;
  /** Keep the colours of the first shot. */
  colour: boolean;
  shots: ShotView[];
  /** "18 shots · 54 s of video · about 3 h 20 min on Worker PC". */
  top: string;
  /** Seconds of work left, null while the PC's speed is not known yet. */
  left: number | null;
  /** Shots made at Draft that Make the kept ones at Normal would make again. */
  upgradable: number;
}

/** "3 h 20 min", "45 min", "under a minute", "9 days 2 h". */
export function durationWords(s: number): string {
  if (s < 60) return 'under a minute';
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  if (s < 86_400) {
    const m5 = Math.round(s / 300) * 5;
    const h = Math.floor(m5 / 60);
    const m = m5 % 60;
    return `${h} h${m ? ` ${m} min` : ''}`;
  }
  const h = Math.round(s / 3600);
  const d = Math.floor(h / 24);
  const r = h % 24;
  return `${d} day${d === 1 ? '' : 's'}${r ? ` ${r} h` : ''}`;
}

/** A shot's words as the page sent them, made safe. */
export function cleanShot(b: Record<string, unknown>): { prompt: string; seconds: number; size: string; quality: VideoQuality; start: ShotStart } | { refused: string } {
  const prompt = String(b.prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!prompt) return { refused: 'Type what the shot should show first.' };
  if (prompt.length > PROMPT_MAX) return { refused: `That is too long for a shot (over ${PROMPT_MAX.toLocaleString('en-GB')} characters): say what it shows in a few lines.` };
  const n = Math.round(Number(b.seconds));
  const seconds = Number.isFinite(n) ? Math.min(MAX_CLIP_SECONDS, Math.max(1, n)) : 3;
  const size = CLIP_SIZES.find(s => s.id === b.size)?.id ?? CLIP_SIZES[0].id;
  const quality = CLIP_QUALITIES.find(q => q.id === b.quality)?.id ?? 'normal';
  const start = cleanStart(b.start);
  if ('refused' in start) return start;
  return { prompt, seconds, size, quality, start };
}

/** A start picture kept for the shot list: a name it gave (data/shots/pictures). */
export const PICTURE_NAME = /^[0-9a-f]{16}\.png$/;
/** A linked PC's clip id (src/videolink.ts cleanCid takes 32 hex characters). */
export const LINK_ID = /^[0-9a-f]{32}$/;
/** A preview the page may show for a shot's start picture: one of TOMLIN's own picture addresses. */
const SRC = /^\/api\/(?:shots\/picture\?f=|images\/file\/|files\/picture\?path=)[^\s"'<>]{1,600}$/;

/** A shot's start as the page sent it. A picture names one kept for the list, or one in the gallery or a project. */
function cleanStart(v: unknown): ShotStart | { refused: string } {
  const s = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  if (s.kind === 'last') return { kind: 'last' };
  if (s.kind !== 'picture') return { kind: 'none' };
  const name = String(s.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const src = typeof s.src === 'string' && SRC.test(s.src) ? { src: s.src } : {};
  if (typeof s.file === 'string' && PICTURE_NAME.test(s.file)) return { kind: 'picture', file: s.file, name, ...src };
  const f = s.from && typeof s.from === 'object' ? (s.from as Record<string, unknown>) : {};
  if (typeof f.gallery === 'string' && f.gallery) return { kind: 'picture', from: { gallery: f.gallery.slice(0, 200) }, name, ...src };
  if (typeof f.project === 'string' && /\.(png|webp)$/i.test(f.project)) return { kind: 'picture', from: { project: f.project.slice(0, 600) }, name, ...src };
  return { refused: 'That start picture is not on this PC any more. Pick it again.' };
}

const sizeOf = (id: string) => CLIP_SIZES.find(s => s.id === id) ?? CLIP_SIZES[0];
const shotId = () => randomBytes(5).toString('hex');
const doneTake = (s: Shot): Take | null => s.takes.find(t => t.clip === s.kept) ?? s.takes.at(-1) ?? null;
/** A start picture made ready for a clip that was not put in line after all: its fitted copy (and a new PNG) removed. */
async function dropReady(ask: ClipAsk): Promise<void> {
  if (ask.startPicture) await rm(ask.startPicture, { force: true }).catch(() => undefined);
  if (ask.start?.fresh) await rm(ask.start.file, { force: true }).catch(() => undefined);
}

const RUN_STATES: RunState[] = ['idle', 'running', 'pausing', 'paused', 'scheduled', 'held'];
const SHOT_STATES: ShotState[] = ['waiting', 'making', 'done', 'failed', 'skipped'];
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * The lists as read from data/shots.json, made safe to run: a file hand-edited or from another version (a list with no
 * shots, a shot with no start) must never stop TOMLIN starting. A list that is not one is passed over; a shot that is
 * not one is left out; a missing part is given its plain value.
 */
export function mendLists(raw: unknown): Record<string, ShotList> {
  const out: Record<string, ShotList> = {};
  if (!isObject(raw)) return out;
  for (const [chat, l] of Object.entries(raw)) {
    if (!isObject(l)) continue;
    const shots: Shot[] = [];
    for (const s of Array.isArray(l.shots) ? l.shots : []) {
      if (!isObject(s) || typeof s.id !== 'string' || !isObject(s.start) || typeof s.start.kind !== 'string') continue;
      const quality = CLIP_QUALITIES.find(q => q.id === s.quality)?.id ?? 'normal';
      shots.push({
        ...(s as unknown as Shot),
        prompt: String(s.prompt ?? ''),
        quality,
        state: SHOT_STATES.includes(s.state as ShotState) ? (s.state as ShotState) : 'waiting',
        want: Number.isFinite(s.want) ? Number(s.want) : 1,
        next: isObject(s.next) ? (s.next as Shot['next']) : { quality, seed: null, keep: false },
        tries: Number.isFinite(s.tries) ? Number(s.tries) : 0,
        takes: Array.isArray(s.takes) ? (s.takes.filter(isObject) as unknown as Take[]) : [],
        kept: typeof s.kept === 'string' ? s.kept : null,
        job: typeof s.job === 'string' ? s.job : null,
        error: typeof s.error === 'string' ? s.error : null,
        fault: (s.fault as VideoFaultKind) ?? null,
      });
    }
    const str = (x: unknown) => (typeof x === 'string' ? x : '');
    out[chat] = {
      ...(l as unknown as ShotList),
      chat,
      who: str(l.who), name: str(l.name), pc: str(l.pc), pcName: str(l.pcName), model: str(l.model),
      shots,
      run: RUN_STATES.includes(l.run as RunState) ? (l.run as RunState) : 'idle',
      startAt: typeof l.startAt === 'string' ? l.startAt : null,
      heldUntil: Number.isFinite(l.heldUntil) ? Number(l.heldUntil) : null,
      draft: l.draft === true,
      said: str(l.said),
    };
    // A start time that cannot be read would keep it waiting (and the PC awake) for ever.
    const o = out[chat];
    if (o.run === 'scheduled' && !Number.isFinite(Date.parse(o.startAt ?? ''))) Object.assign(o, { run: 'idle', startAt: null });
  }
  return out;
}

export class Shots {
  private deps: ShotsDeps;
  private data: ShotsFile = { version: 1, lists: {}, speeds: {} };
  private turning = false;
  private again = false;

  private constructor(deps: ShotsDeps) {
    this.deps = deps;
  }

  /** Reads the lists back. A shot that was being made when TOMLIN closed is made again; the list carries on. */
  static async load(deps: ShotsDeps): Promise<Shots> {
    const s = new Shots(deps);
    const got = await readData<Partial<ShotsFile>>(deps.file, {});
    s.data = { version: 1, lists: mendLists(got.lists), speeds: got.speeds && typeof got.speeds === 'object' ? got.speeds : {} };
    for (const l of Object.values(s.data.lists)) {
      // Its link id is kept to ask again with: a linked PC still making (or holding) that take hands it over.
      for (const sh of l.shots) if (sh.state === 'making') Object.assign(sh, { state: 'waiting', job: null, ...(sh.link ? { resume: sh.link } : {}) });
      if (l.run === 'pausing') l.run = 'paused';
    }
    return s;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private save(): Promise<void> {
    return writeAtomic(this.deps.file, JSON.stringify(this.data, null, 1)).catch(error => console.warn(`The shot list could not be saved: ${(error as Error).message}`));
  }

  /** The list of a chat, or null when it has none. */
  get(chat: string): ShotList | null {
    return this.data.lists[chat] ?? null;
  }

  /** Every chat with a list. */
  chats(): string[] {
    return Object.keys(this.data.lists);
  }

  /** The hire, their PC and model, as the server finds them now (set on each change, so a changed model is used). */
  private listFor(chat: string, hire: Pick<ShotList, 'who' | 'name' | 'pc' | 'pcName' | 'model'>): ShotList {
    const l = (this.data.lists[chat] ??= { chat, ...hire, shots: [], run: 'idle', startAt: null, heldUntil: null, draft: false, said: '' });
    Object.assign(l, hire);
    return l;
  }

  private shot(chat: string, id: string): { l: ShotList; s: Shot } | { refused: string } {
    const l = this.data.lists[chat];
    const s = l?.shots.find(x => x.id === id);
    return l && s ? { l, s } : { refused: 'That shot is not on the list any more.' };
  }

  // ---- Changing the list ----

  async add(chat: string, hire: Pick<ShotList, 'who' | 'name' | 'pc' | 'pcName' | 'model'>, b: Record<string, unknown>): Promise<Shot | { refused: string }> {
    const c = cleanShot(b);
    if ('refused' in c) return c;
    const big = sizeRefused(sizeOf(c.size).width, sizeOf(c.size).height, hire.model);
    if (big) return { refused: big };
    const l = this.listFor(chat, hire);
    if (l.shots.length >= SHOTS_MAX) return { refused: `The list has ${SHOTS_MAX} shots, as many as it holds: make these first, or start a list in a new chat.` };
    const s: Shot = { id: shotId(), ...c, state: 'waiting', want: 1, next: { quality: c.quality, seed: null, keep: false }, tries: 0, takes: [], kept: null, job: null, error: null, fault: null };
    l.shots.push(s);
    if (l.run === 'idle' && l.said) l.said = '';
    await this.save();
    this.turn();
    return s;
  }

  async edit(chat: string, id: string, b: Record<string, unknown>): Promise<Shot | { refused: string }> {
    const f = this.shot(chat, id);
    if ('refused' in f) return f;
    if (!['waiting', 'failed', 'skipped'].includes(f.s.state)) return { refused: 'Only a shot not made yet can be changed: press Redo to make it again.' };
    const c = cleanShot(b);
    if ('refused' in c) return c;
    const big = sizeRefused(sizeOf(c.size).width, sizeOf(c.size).height, f.l.model);
    if (big) return { refused: big };
    Object.assign(f.s, c, { next: { quality: c.quality, seed: null, keep: false } });
    delete f.s.resume;
    await this.save();
    return f.s;
  }

  /** Moves a shot to place `to` (0 first). The one being made can move too: it carries on. */
  async move(chat: string, id: string, to: number): Promise<boolean | { refused: string }> {
    const f = this.shot(chat, id);
    if ('refused' in f) return f;
    const from = f.l.shots.indexOf(f.s);
    const at = Math.max(0, Math.min(f.l.shots.length - 1, Math.round(Number(to)) || 0));
    if (at === from) return false;
    f.l.shots.splice(from, 1);
    f.l.shots.splice(at, 0, f.s);
    await this.save();
    return true;
  }

  /** Skip: a shot not being made is left out (pressed again: put back). */
  async skip(chat: string, id: string): Promise<Shot | { refused: string }> {
    const f = this.shot(chat, id);
    if ('refused' in f) return f;
    if (f.s.state === 'making') return { refused: 'That shot is being made: press Stop first, or let it finish.' };
    f.s.state = f.s.state === 'skipped' ? (f.s.takes.length && f.s.want === 0 ? 'done' : 'waiting') : 'skipped';
    if (f.s.state === 'waiting') f.s.want = Math.max(1, f.s.want);
    await this.save();
    this.turn();
    return f.s;
  }

  /** Redo: made again with a new seed (its clips stay on the Videos shelf). `takes`: Make 3. */
  async redo(chat: string, id: string, takes = 1): Promise<Shot | { refused: string }> {
    const f = this.shot(chat, id);
    if ('refused' in f) return f;
    if (f.s.state === 'making') return { refused: 'That shot is being made: wait for it, or press Stop first.' };
    const n = Math.max(1, Math.min(TAKES, Math.round(takes) || 1));
    Object.assign(f.s, { state: 'waiting', want: n, next: { quality: f.s.quality, seed: null, keep: false }, tries: 0, error: null, fault: null, kept: null });
    delete f.s.resume;
    // One take again replaces what the card showed; Make 3 adds to the takes to choose from.
    if (n === 1) f.s.takes = [];
    await this.save();
    this.turn();
    return f.s;
  }

  async keep(chat: string, id: string, clip: string): Promise<Shot | { refused: string }> {
    const f = this.shot(chat, id);
    if ('refused' in f) return f;
    if (!f.s.takes.some(t => t.clip === clip)) return { refused: 'That take is not on this shot any more.' };
    f.s.kept = clip;
    await this.save();
    return f.s;
  }

  async remove(chat: string, id: string): Promise<boolean> {
    const f = this.shot(chat, id);
    if ('refused' in f) return false;
    if (f.s.job) this.deps.clips.stop(f.s.job);
    f.l.shots = f.l.shots.filter(x => x !== f.s);
    await this.save();
    await this.dropUnused([f.s]);
    this.turn();
    return true;
  }

  /**
   * A chat was deleted: its list goes, the shot being made is stopped, and the pictures kept only for it are removed.
   * A turn already under way finds the list gone and puts nothing more in line for it.
   */
  async dropChat(chat: string): Promise<void> {
    const l = this.data.lists[chat];
    if (!l) return;
    delete this.data.lists[chat];
    l.run = 'idle';
    for (const s of l.shots) if (s.job) this.deps.clips.stop(s.job);
    await this.save();
    await this.dropUnused(l.shots);
  }

  /** The pictures these shots kept for the list (a start picture, a carried-on frame) that no other shot still uses. */
  private async dropUnused(gone: Shot[]): Promise<void> {
    if (!this.deps.dropPictures) return;
    const of = (s: Shot) => [s.start.kind === 'picture' ? s.start.file : undefined, s.frame?.file, s.frame?.raw].filter((x): x is string => !!x);
    const used = new Set(Object.values(this.data.lists).flatMap(l => l.shots.flatMap(of)));
    const names = [...new Set(gone.flatMap(of))].filter(n => !used.has(n));
    if (names.length) await this.deps.dropPictures(names).catch(error => console.warn(`A shot list's pictures could not be removed: ${(error as Error).message}`));
  }

  // ---- Running it ----

  /** Start (or carry on): `at` an ISO time starts it then instead. `draft`: Make all as Draft first. */
  async start(chat: string, hire: Pick<ShotList, 'who' | 'name' | 'pc' | 'pcName' | 'model'>, o: { at?: string | null; draft?: boolean } = {}): Promise<ShotList | { refused: string }> {
    const l = this.listFor(chat, hire);
    if (!l.shots.some(s => s.state === 'waiting' || s.state === 'making')) return { refused: l.shots.length ? 'Every shot is made or skipped: press Redo on one, or add a shot.' : 'Add a shot first: type what it shows and press "Add to the shot list".' };
    const when = o.at ? Date.parse(o.at) : NaN;
    if (o.draft !== undefined) l.draft = o.draft;
    l.heldUntil = null;
    if (Number.isFinite(when) && when > this.now()) {
      l.run = 'scheduled';
      l.startAt = new Date(when).toISOString();
      l.said = '';
    } else {
      l.run = 'running';
      l.startAt = null;
      l.said = '';
    }
    await this.save();
    this.turn();
    return l;
  }

  /** Make the kept ones at Normal: each shot made at Draft is made again at its own quality (Normal when it asked Draft), from the same seed. */
  async upgrade(chat: string, hire: Pick<ShotList, 'who' | 'name' | 'pc' | 'pcName' | 'model'>): Promise<ShotList | { refused: string }> {
    const l = this.listFor(chat, hire);
    if (l.shots.some(s => s.state === 'making')) return { refused: 'A shot is being made: wait for the list to finish, or press Stop first.' };
    const picks: string[] = [];
    let n = 0;
    for (const s of l.shots) {
      if (s.state !== 'done') continue;
      const t = doneTake(s);
      if (!t || t.quality !== 'draft') continue;
      if (s.takes.length > 1 && !s.kept) {
        picks.push(String(l.shots.indexOf(s) + 1));
        continue;
      }
      const quality: VideoQuality = s.quality === 'draft' ? 'normal' : s.quality;
      Object.assign(s, { state: 'waiting', want: 1, next: { quality, seed: t.seed, keep: true }, tries: 0, error: null, fault: null });
      n++;
    }
    if (!n) return { refused: picks.length ? `Pick a take first with "Keep this one" on shot ${listWords(picks)}.` : 'No shot here has a Draft take to make at Normal.' };
    const r = await this.start(chat, hire, { draft: false });
    if (!('refused' in r) && picks.length) r.said = `Shot ${listWords(picks)} left at Draft: pick a take with "Keep this one", then press this again.`;
    await this.save();
    return r;
  }

  /** Pause: the shot being made finishes, then the list waits. */
  async pause(chat: string): Promise<ShotList | null> {
    const l = this.data.lists[chat];
    if (!l) return null;
    if (l.run === 'running' || l.run === 'held') l.run = l.shots.some(s => s.state === 'making') ? 'pausing' : 'paused';
    else if (l.run === 'scheduled') Object.assign(l, { run: 'idle', startAt: null });
    await this.save();
    return l;
  }

  /** Stop: the shot being made is stopped (nothing of it kept) and goes back to waiting; the list stops. */
  async stop(chat: string): Promise<ShotList | null> {
    const l = this.data.lists[chat];
    if (!l) return null;
    for (const s of l.shots) {
      if (s.state !== 'making') continue;
      if (s.job) this.deps.clips.stop(s.job);
      Object.assign(s, { state: 'waiting', job: null });
      delete s.resume;
    }
    Object.assign(l, { run: 'idle', startAt: null, heldUntil: null, said: 'Stopped.' });
    await this.save();
    return l;
  }

  /** Looks at every list: a clip ended, a start time came, the next shot. Run on a timer and after each change. */
  turn(): void {
    if (this.turning) {
      this.again = true;
      return;
    }
    this.turning = true;
    void (async () => {
      try {
        do {
          this.again = false;
          let changed = false;
          for (const l of Object.values(this.data.lists)) if (await this.step(l)) changed = true;
          if (changed) await this.save();
        } while (this.again);
      } catch (error) {
        console.warn(`The shot list could not carry on: ${(error as Error).message}`);
      } finally {
        this.turning = false;
      }
    })();
  }

  /** Waits for the turn under way (tests). */
  async settled(): Promise<void> {
    while (this.turning) await new Promise(r => setTimeout(r, 2));
  }

  private async step(l: ShotList): Promise<boolean> {
    // Its chat was deleted while this turn went round.
    if (this.data.lists[l.chat] !== l) return false;
    const t = this.now();
    let changed = false;
    if (l.run === 'scheduled' && l.startAt && Date.parse(l.startAt) <= t) {
      Object.assign(l, { run: 'running', startAt: null });
      changed = true;
    }
    if (l.run === 'held' && (l.heldUntil ?? 0) <= t) {
      Object.assign(l, { run: 'running', heldUntil: null, said: '' });
      changed = true;
    }
    const making = l.shots.find(s => s.state === 'making');
    if (making) {
      const v = making.job ? this.deps.clips.view(making.job) : null;
      if (v && isRunning(v.state)) return changed;
      this.ended(l, making, v);
      changed = true;
    }
    if (l.run === 'pausing') {
      l.run = 'paused';
      return true;
    }
    if (l.run !== 'running') return changed;
    const next = l.shots.find(s => s.state === 'waiting');
    if (!next) {
      l.run = 'idle';
      l.draft = false;
      l.said = endWords(l);
      return true;
    }
    return (await this.make(l, next)) || changed;
  }

  /** A shot's clip ended (or was lost when TOMLIN closed): its take, a second try, or the list held for the PC's owner. */
  private ended(l: ShotList, s: Shot, v: ClipView | null): void {
    s.job = null;
    if (!v || v.state === 'stopped') {
      // Lost, or stopped from the chat: made again when the list carries on; stopped by hand pauses the list.
      s.state = 'waiting';
      if (v && l.run !== 'idle') Object.assign(l, { run: 'paused', said: `Shot ${l.shots.indexOf(s) + 1} was stopped: press Start to carry on.` });
      return;
    }
    if (v.state === 'done' && v.clip) {
      const c = v.clip;
      const take: Take = { clip: c.id, file: c.file, mime: c.mime, seed: s.next.seed ?? 0, quality: c.quality as VideoQuality, seconds: c.seconds, width: c.width, height: c.height, at: c.at, tookMs: c.tookMs };
      s.takes.push(take);
      if (s.next.keep) s.kept = take.clip;
      s.want = Math.max(0, s.want - 1);
      s.next = { quality: s.quality, seed: null, keep: false };
      s.tries = 0;
      s.error = null;
      s.fault = null;
      s.state = s.want > 0 ? 'waiting' : 'done';
      this.measure(l, take, v.total);
      return;
    }
    if (v.fault === 'busy') {
      s.state = 'waiting';
      if (l.run === 'running' || l.run === 'pausing') {
        const pausing = l.run === 'pausing';
        Object.assign(l, { run: pausing ? 'paused' : 'held', heldUntil: pausing ? null : this.now() + HELD_MS, said: busyLine(l, v.error) });
      }
      return;
    }
    s.tries++;
    s.error = v.error;
    s.fault = v.fault;
    s.state = s.tries < TRIES ? 'waiting' : 'failed';
  }

  /** Puts the shot's next take in line on the hire's PC; false when nothing changed (it waits for its last frame). */
  private async make(l: ShotList, s: Shot): Promise<boolean> {
    const n = l.shots.indexOf(s) + 1;
    const size = sizeOf(s.size);
    // The hire's model may have changed since the shot was added.
    const big = sizeRefused(size.width, size.height, l.model);
    if (big) {
      this.fail(s, `Shot ${n}: ${big}`);
      return true;
    }
    const seed = s.next.seed ?? this.deps.seed?.() ?? randomInt(1, 2 ** 31 - 1);
    // Stop, Pause, a deleted shot or a deleted chat while the @names were filled in or the start picture was made
    // ready: nothing is put in line for it.
    const called = () => this.data.lists[l.chat] !== l || l.run !== 'running' || !l.shots.includes(s) || s.state !== 'waiting';
    const filled = (await this.deps.expand?.(s.prompt, l.chat).catch(() => s.prompt)) ?? s.prompt;
    if (called()) return true;
    const prompt = typeof filled === 'string' ? filled : filled.prompt;
    const avoid = typeof filled === 'string' ? '' : filled.avoid?.trim() ?? '';
    // A take cut by a restart is asked for by its old link id (the linked PC follows it); any other take gets a new one.
    const linkId = s.resume && LINK_ID.test(s.resume) ? s.resume : randomBytes(16).toString('hex');
    let ask: ClipAsk = { prompt, seconds: s.seconds, width: size.width, height: size.height, quality: l.draft ? 'draft' : s.next.quality, model: l.model, who: l.who, name: l.name, chat: l.chat, pc: l.pc, pcName: l.pcName, seed, linkId, ...(avoid ? { negative: avoid } : {}) };
    if (s.start.kind === 'last') {
      const before = l.shots[n - 2];
      const take = before ? doneTake(before) : null;
      if (!take) {
        this.fail(s, `Shot ${n} carries on from the shot before, which has no clip${before ? ' yet' : ': it is the first shot'}. Give it another start, or make the shot before first.`);
        return true;
      }
      // No decoder here: the page reads that clip's last frame (needFrames) and sends it; the list waits till then.
      if (s.frame?.clip !== take.clip) {
        // A clip deleted from the Videos shelf has no last frame to read: the shot says so instead of waiting for ever.
        if (this.deps.exists && !(await this.deps.exists(take.clip).catch(() => true))) {
          if (called()) return true;
          if (l.said === WAIT_PAGE) l.said = '';
          this.fail(s, `Shot ${n} carries on from the clip of shot ${n - 1}, which was deleted from the Videos shelf. Press Redo on shot ${n - 1}, or give shot ${n} another start.`);
          return true;
        }
        if (l.said === WAIT_PAGE) return false;
        l.said = WAIT_PAGE;
        return true;
      }
      const got = await this.deps.starts.give(ask, { kept: s.frame.file, name: `${before.prompt.slice(0, 60)} last frame` });
      if ('refused' in got) {
        this.fail(s, got.refused);
        return true;
      }
      ask = got.ask;
    } else if (s.start.kind === 'picture') {
      const got = await this.deps.starts.give(ask, s.start.file ? { kept: s.start.file, name: s.start.name } : { from: s.start.from!, name: s.start.name });
      if ('refused' in got) {
        this.fail(s, got.refused);
        return true;
      }
      ask = got.ask;
    }
    if (called()) {
      await dropReady(ask);
      return true;
    }
    if (l.said === WAIT_PAGE) l.said = '';
    const v = this.deps.clips.start(ask);
    if ('refused' in v) {
      // Too many clips waiting on that PC (other chats' clips): the list looks again shortly.
      await dropReady(ask);
      Object.assign(l, { run: 'held', heldUntil: this.now() + HELD_MS, said: v.refused });
      return true;
    }
    // The seed is kept with the shot: a take lost on a restart is made again from it.
    s.next.seed = seed;
    delete s.resume;
    Object.assign(s, { state: 'making', job: v.id, link: linkId });
    return true;
  }

  /**
   * True while any list is running, finishing a shot (pausing), held, or waiting for its start time: this PC is kept
   * awake for it (a PC asleep at a list's start time would never start it).
   */
  anyRunning(): boolean {
    return Object.values(this.data.lists).some(l => l.run === 'running' || l.run === 'pausing' || l.run === 'held' || l.run === 'scheduled');
  }

  /** The last frames to read now (here first, else by the page): each running list waiting at a shot that carries on. */
  needFrames(): Array<{ chat: string; shot: string; clip: string; file: string }> {
    const out: Array<{ chat: string; shot: string; clip: string; file: string }> = [];
    for (const l of Object.values(this.data.lists)) {
      if (l.run !== 'running' || l.shots.some(s => s.state === 'making')) continue;
      const i = l.shots.findIndex(s => s.state === 'waiting');
      const s = l.shots[i];
      const take = i > 0 ? doneTake(l.shots[i - 1]) : null;
      if (s?.start.kind === 'last' && take && s.frame?.clip !== take.clip) out.push({ chat: l.chat, shot: s.id, clip: take.clip, file: take.file });
    }
    return out;
  }

  /** True when shot `id` of `chat` carries on from `clip` (the take before it): a frame of it may be set. */
  carriesOn(chat: string, id: string, clip: string): boolean {
    const f = this.shot(chat, id);
    if ('refused' in f) return false;
    const i = f.l.shots.indexOf(f.s);
    const take = i > 0 ? doneTake(f.l.shots[i - 1]) : null;
    return f.s.start.kind === 'last' && !!take && take.clip === clip;
  }

  /**
   * The page read the last frame of `clip` (the take before shot `id`): the shot starts from `file` (`raw`: the frame as
   * read, when `file` is its colour-matched copy). Gives the old frame's files to remove.
   */
  async setFrame(chat: string, id: string, clip: string, file: string, raw?: string): Promise<{ old: string[] } | { refused: string }> {
    const f = this.shot(chat, id);
    if ('refused' in f) return f;
    if (!this.carriesOn(chat, id, clip)) return { refused: 'That shot no longer carries on from that clip.' };
    const old = [f.s.frame?.file, f.s.frame?.raw].filter((x): x is string => !!x && x !== file && x !== raw);
    f.s.frame = { clip, file, ...(raw ? { raw } : {}) };
    await this.save();
    this.turn();
    return { old };
  }

  /**
   * The clip before really ends on a blank frame (read from the clip itself: black or one flat colour, as a fade out):
   * the shot that carries on from it fails with what to do, so the list does not wait for ever (audit LF-07).
   */
  async blankEnd(chat: string, id: string, clip: string, n: number): Promise<void> {
    const f = this.shot(chat, id);
    if ('refused' in f || !this.carriesOn(chat, id, clip)) return;
    this.fail(f.s, `Shot ${n - 1} ends on a blank frame (black or one flat colour), so shot ${n} has nothing to carry on from. Press Redo on shot ${n - 1}, or give shot ${n} another start.`);
    await this.save();
    this.turn();
  }

  // ---- Keep the colours of the first shot ----

  /** Turns the colour match of a list on or off (a new list is made for it when the chat has none yet). */
  async setColour(chat: string, hire: Pick<ShotList, 'who' | 'name' | 'pc' | 'pcName' | 'model'>, on: boolean): Promise<ShotList> {
    const l = this.listFor(chat, hire);
    l.colour = on;
    await this.save();
    return l;
  }

  /**
   * What a carried-on frame of `chat`'s list is matched to: null when the list does not keep its colours; else the
   * reference written into the list (`ref`, when it still belongs to shot 1 as it is now) and where a new one comes from.
   */
  colourOf(chat: string): { ref: ColourRef | null; source: RefSource } | null {
    const l = this.data.lists[chat];
    if (!l || l.colour === false) return null;
    const first = l.shots[0];
    const size = sizeOf(first?.size ?? CLIP_SIZES[0].id);
    const st = first?.start;
    const picture = st?.kind === 'picture' ? (st.file ? { kept: st.file, name: st.name } : st.from ? { from: st.from, name: st.name } : null) : null;
    const key = picture ? `picture:${'kept' in picture ? picture.kept : JSON.stringify(picture.from)}:${size.id}` : 'frame';
    return { ref: l.ref && l.ref.key === key ? l.ref : null, source: { key, picture, width: size.width, height: size.height } };
  }

  /** Writes the reference into the list, so every shot after is matched to the same colours. */
  async setRef(chat: string, ref: ColourRef): Promise<void> {
    const l = this.data.lists[chat];
    if (!l) return;
    l.ref = ref;
    await this.save();
  }

  private fail(s: Shot, text: string): void {
    Object.assign(s, { state: 'failed', error: text, fault: null, tries: TRIES });
  }

  // ---- The time it takes ----

  private key(l: Pick<ShotList, 'pc' | 'model'>): string {
    return `${l.pc}|${l.model}`;
  }

  /** A finished clip's seconds per step, for each clip second: the rolling figure for its PC and model. */
  private measure(l: ShotList, t: Take, steps: number): void {
    const n = steps > 0 ? steps : STEPS_GUESS[t.quality] ?? 20;
    if (!(t.tookMs > 0) || !(t.seconds > 0)) return;
    const sp = (this.data.speeds[this.key(l)] ??= { perStepSecond: [], steps: {} });
    sp.perStepSecond = [...sp.perStepSecond, t.tookMs / 1000 / n / t.seconds / areaOf(t.width, t.height)].slice(-ROLL);
    sp.steps[t.quality] = n;
  }

  /** Seconds one take of `s` is likely to take on the list's PC, or null while that PC has made none. */
  takeSeconds(l: Pick<ShotList, 'pc' | 'model' | 'draft'>, s: Pick<Shot, 'seconds' | 'next'> & Partial<Pick<Shot, 'size'>>): number | null {
    const sp = this.data.speeds[this.key(l)];
    if (!sp?.perStepSecond.length) return null;
    const each = sp.perStepSecond.reduce((a, b) => a + b, 0) / sp.perStepSecond.length;
    const q: VideoQuality = l.draft ? 'draft' : s.next.quality;
    // A known model's own steps (they can change with TOMLIN, so a count learned before is not used for it).
    const steps = videoModel(l.model) ? stepsFor(l.model, q) : sp.steps[q] ?? STEPS_GUESS[q];
    const size = sizeOf(s.size ?? CLIP_SIZES[0].id);
    // Scaled by pixels: a guess (the attention part grows faster than that), corrected as clips of that size are made.
    return each * steps * s.seconds * areaOf(size.width, size.height);
  }

  /** The list as the page draws it. `clipLine` is src/clips.ts progressLine. */
  view(chat: string, clipLine: (v: ClipView) => string): ListView | null {
    const l = this.data.lists[chat];
    if (!l) return null;
    let left = 0;
    let known = true;
    const shots = l.shots.map((s, i): ShotView => {
      const v = s.state === 'making' && s.job ? this.deps.clips.view(s.job) : null;
      const each = this.takeSeconds(l, s);
      let mine: number | null = null;
      if (s.state === 'waiting' || s.state === 'making') {
        const now = v?.secondsLeft ?? (s.state === 'making' && each !== null && v ? Math.max(0, each - v.elapsed) : each);
        const rest = s.want - 1;
        mine = now === null || (rest > 0 && each === null) ? null : now + Math.max(0, rest) * (each ?? 0);
        if (mine === null) known = false;
        else left += mine;
      }
      const frac = !v ? 0 : v.state === 'loading' ? 0.03 : v.state === 'joining' ? 0.97 : v.total ? Math.min(0.95, 0.05 + (v.done / v.total) * 0.9) : 0.05;
      return { ...s, n: i + 1, line: v ? clipLine(v) : '', frac, left: mine };
    });
    const live = l.shots.filter(s => s.state !== 'skipped');
    const secs = live.reduce((a, s) => a + s.seconds, 0);
    const toMake = l.shots.some(s => s.state === 'waiting' || s.state === 'making');
    const on = l.pcName ? ` on ${l.pcName}` : '';
    const time = !toMake ? 'nothing left to make' : known ? `${left < 60 ? '' : 'about '}${durationWords(left)}${on}` : `time not known yet${on}`;
    const top = `${live.length} shot${live.length === 1 ? '' : 's'} · ${secs} s of video · ${time}`;
    const upgradable = l.shots.filter(s => s.state === 'done' && doneTake(s)?.quality === 'draft').length;
    return { chat, run: l.run, startAt: l.startAt, draft: l.draft, said: l.said, pcName: l.pcName, colour: l.colour !== false, shots, top, left: toMake && known ? Math.round(left) : null, upgradable };
  }
}

/**
 * Why a busy clip holds the list: the PC's owner using it is said as such; any other busy reason (Backups only, the
 * cluster, another clip or picture) is said in the clip's own words.
 */
function busyLine(l: Pick<ShotList, 'pcName'>, error: string | null): string {
  const pc = l.pcName === 'this PC' ? 'This PC' : l.pcName;
  if (!error || /owner|I need to use the pc/i.test(error)) return `${pc} is being used by its owner: the list carries on when they are done.`;
  return `${error.trim().replace(/\s*Try again[^.]*\.\s*$/i, '').replace(/\.?$/, '.')} The list looks again in ${HELD_MS / 60_000} minutes.`;
}

/** "4", "4 and 9", "2, 4 and 9". */
export function listWords(xs: string[]): string {
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

/** How a list ended: what was made and which shots failed. */
function endWords(l: ShotList): string {
  const live = l.shots.filter(s => s.state !== 'skipped');
  const done = live.filter(s => s.state === 'done').length;
  const failed = l.shots.map((s, i) => (s.state === 'failed' ? String(i + 1) : '')).filter(Boolean);
  const made = `Done: ${done} of ${live.length} shot${live.length === 1 ? '' : 's'} made.`;
  return failed.length ? `${made} Shot ${listWords(failed)} failed: see ${failed.length === 1 ? 'its line' : 'their lines'}, then press Redo.` : made;
}
