// Past pictures and how each was made, in data/images/: the files by month, and gallery.jsonl with one line per
// picture (prompt, seed, sizes, mode, model, time). Only names this file wrote can be served back.
import { appendFile, copyFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Size } from './sizes.ts';
import type { Mode } from './modes.ts';
import { sourceName, sourceOf, writeSource } from './sources.ts';

export interface Picture {
  id: string;
  at: string;
  /** As typed. */
  prompt: string;
  /** What the model was given (size taken out, mode words added). */
  modelPrompt: string;
  negative: string;
  mode: Mode;
  model: string;
  modelName: string;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  /** The runner's scheduler ('' or absent: its own). */
  scheduler?: string;
  /** Drawn by an older TOMLIN on a linked PC that sent no settings back: the seed, steps and sampler are not known. */
  settingsUnknown?: boolean;
  /** The reference pictures it was drawn with (full paths, a character's or location's: src/cards.ts), so Full quality and Draw again use them too. */
  refs?: string[];
  generated: Size;
  target: Size;
  fit: string;
  device: string;
  seconds: number;
  /** A quick draft (fast decoder, few steps) or a final. */
  draft: boolean;
  /** The draft this final was made from. */
  finalOf?: string;
  /** Files, relative to data/images: the model's own picture, and the finished one. */
  original: string;
  output: string;
  format: 'png' | 'webp';
  bytes: number;
  icoFiles?: string[];
  altText?: string;
  altFrom?: string;
  /** Set when the background was cut away. */
  transparent?: boolean;
  /** In the gallery (true), or still a draft to choose from (false). Pictures from before this flag count as kept. */
  kept?: boolean;
  /** Cleared away (an old draft): its files are gone and it is no longer listed. */
  removed?: boolean;
  /** Drawn in the private chat, which was taken out of the app: never listed or served again. */
  private?: boolean;
  /** The chat that was open when it was drawn (src/chats.ts); '' or absent = no chat (older pictures, the API). */
  chat?: string;
  /** The projects it was saved to (Save to project, or kept in a project's chat): each copy's workspace path. */
  savedTo?: { project: string; name: string; path: string }[];
  /** Drawn for a queue line (its request id): the line run again after TOMLIN was closed collects it, never draws it twice. */
  queued?: string;
  /**
   * The style picked by hand that gave its words (src/styles.ts): set where it was drawn here, or by its style sample's
   * record. Absent: not known (Auto, an artist's own way of working, a linked PC's picture, older pictures).
   */
  style?: string;
}

/** A picture's files, relative to data/images: the pictures and the image source beside the finished one (src/sources.ts). */
const filesOf = (p: Picture): string[] => [...new Set([p.original, p.output, ...(p.icoFiles ?? []), sourceName(p.output)])].filter(rel => /^\d{4}-\d{2}\/[\w.-]+$/.test(rel));

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * A read or write of a list that another program (a virus scanner, OneDrive, a backup) holds for a moment: tried again,
 * 50 ms, 100 ms, ... about 10 s in all, as the other saves do (src/atomic.ts). Any other fault is thrown at once.
 */
async function heldWait<T>(job: () => Promise<T>, tries = 20): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await job();
    } catch (e) {
      if (i >= tries || !BUSY.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise(r => setTimeout(r, 50 * i));
    }
  }
}

/** A list saved by hand in Notepad or PowerShell can start with a byte-order mark: it is left out, or the first line would not read. */
const withoutMark = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** Has what search and the pages read from every picture. */
const wholePicture = (p: Picture): boolean => [p.at, p.prompt, p.output].every(x => typeof x === 'string');

export type Shelf = 'gallery' | 'drafts' | 'all';
/** Kept, unless the picture says otherwise (older pictures have no flag and stay in the gallery). */
export const isKept = (p: Picture): boolean => p.kept !== false;

export class Gallery {
  readonly dir: string;
  private cache: Picture[] | null = null;
  private loading: Promise<Picture[]> | null = null;
  private turn: Promise<unknown> = Promise.resolve();
  private endChecked = false;

  /** One line on the list. The first in a run starts on a new line if the last one was cut off (a crash mid-write), so a
   * half line never swallows the next picture. */
  private async line(text: string): Promise<void> {
    let lead = '';
    if (!this.endChecked) {
      const h = await heldWait(() => open(this.index, 'r')).catch(() => null);
      this.endChecked = true;
      if (h) {
        try {
          const { size } = await h.stat();
          if (size > 0) {
            const b = Buffer.alloc(1);
            await h.read(b, 0, 1, size - 1);
            if (b[0] !== 10) lead = '\n';
          }
        } finally {
          await h.close();
        }
      }
    }
    try {
      await heldWait(() => appendFile(this.index, lead + text));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new Error(`The picture list could not be written (${code ?? 'a disk fault'}): another program may have it open. Try again in a moment.`);
    }
  }

  constructor(dir: string) {
    this.dir = dir;
  }

  private get index(): string {
    return join(this.dir, 'gallery.jsonl');
  }

  async all(): Promise<Picture[]> {
    if (this.cache) return this.cache;
    // Everyone asking while it is being read shares one read, so all of them hold the same list.
    this.loading ??= this.load().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async load(): Promise<Picture[]> {
    let text = '';
    try {
      text = withoutMark(await heldWait(() => readFile(this.index, 'utf8')));
    } catch (e) {
      // Only no list yet is an empty gallery. Any other fault is said, and the next look reads again.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw new Error(`The picture list could not be read (${code ?? 'a disk fault'}). Your pictures are still on the disk: try again in a moment.`);
    }
    // Later lines for the same id (an alt text added) replace earlier ones.
    const byId = new Map<string, Picture>();
    let damaged = 0;
    const lines = text.split('\n');
    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as Picture;
        if (typeof p?.id !== 'string') damaged++;
        else byId.set(p.id, { ...byId.get(p.id), ...p });
      } catch {
        // a half-written last line after a crash: skipped, and not a fault
        if (i < lines.length - 1) damaged++;
      }
    }
    // Whole pictures only: a damaged or hand-edited one would break search and the pages. Its line stays in the file.
    const all = [...byId.values()];
    this.cache = all.filter(wholePicture);
    damaged += all.length - this.cache.length;
    if (damaged) console.warn(`${this.index}: ${damaged} damaged ${damaged === 1 ? 'line' : 'lines'} skipped; the other pictures are fine.`);
    return this.cache;
  }

  /** Changes to the list run one after another, each seeing the one before. */
  private inOrder<T>(job: () => Promise<T>): Promise<T> {
    const run = this.turn.then(job);
    this.turn = run.catch(() => undefined);
    return run;
  }

  /** The change on the disk first, then in the list: one that could not be written is never shown as made. */
  private async write(p: Picture, change: Partial<Picture>): Promise<void> {
    await this.line(`${JSON.stringify({ id: p.id, ...change })}\n`);
    Object.assign(p, change);
  }

  /**
   * Newest first: the gallery, the drafts or both, optionally only those whose prompt has every word of `q`, and only
   * one chat's pictures when `chat` is given.
   */
  async list(offset = 0, limit = 60, shelf: Shelf = 'all', q = '', chat?: string): Promise<{ pictures: Picture[]; total: number; drafts: number }> {
    const live = (await this.all()).filter(p => !p.removed && !p.private && (chat === undefined || (p.chat ?? '') === chat));
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const all = live
      .filter(p => shelf === 'all' || (shelf === 'gallery' ? isKept(p) : !isKept(p)))
      .filter(p => words.every(w => p.prompt.toLowerCase().includes(w)))
      .reverse();
    return { pictures: all.slice(offset, offset + limit), total: all.length, drafts: live.filter(p => !isKept(p)).length };
  }

  /**
   * Drafts (never kept) older than `days`: their files deleted and the picture marked removed. 0 days = keep forever.
   * Only pictures made as drafts are touched; anything in the gallery, or from before drafts existed, never is.
   */
  async clearDrafts(days: number, now = Date.now()): Promise<number> {
    if (!(days > 0)) return 0;
    const old = (await this.all()).filter(p => p.kept === false && !p.removed && now - Date.parse(p.at) > days * 86_400_000);
    let cleared = 0;
    for (const p of old) {
      // Looked at again in its turn: one added to the gallery since the sweep began is kept.
      if (await this.inOrder(async () => {
        if (p.kept !== false || p.removed) return false;
        // Marked first, then its files: one that cannot be deleted never leaves a listed picture with no file.
        await this.write(p, { removed: true });
        await this.drop(p);
        return true;
      })) cleared++;
    }
    return cleared;
  }

  /**
   * A chat was deleted: its pictures are deleted too (files gone, marked removed), or kept and no longer tied to any
   * chat (they stay under "All chats"). Returns how many pictures it touched.
   */
  async forgetChat(chat: string, deleteThem: boolean): Promise<number> {
    if (!chat) return 0;
    const mine = (await this.all()).filter(p => !p.removed && p.chat === chat);
    for (const p of mine) {
      if (deleteThem) {
        await this.update(p.id, { removed: true });
        await this.drop(p);
      } else await this.update(p.id, { chat: '' });
    }
    return mine.length;
  }

  /**
   * One picture marked removed, then its files deleted (a picture this PC drew for a paired PC keeps no copy here). The
   * mark comes first, so a file that cannot be deleted (held open elsewhere) never leaves a picture listed with its
   * files gone. Gives the files left on the disk, if any.
   */
  async remove(id: string): Promise<string[]> {
    const p = await this.get(id);
    if (!p || p.removed) return [];
    await this.update(p.id, { removed: true });
    return this.drop(p);
  }

  /**
   * Set by the server: whether a file in the gallery is still needed by something else (a clip that started from it, for
   * its Started from and Make again). Such a file stays on the disk when its picture leaves the gallery.
   */
  needed: ((file: string) => Promise<boolean>) | null = null;

  /** Whether one of a picture's files is still needed elsewhere (see `needed`), so deleting it keeps that file. */
  async isNeeded(p: Picture): Promise<boolean> {
    if (!this.needed) return false;
    for (const rel of filesOf(p)) if (await this.needed(join(this.dir, rel)).catch(() => false)) return true;
    return false;
  }

  /** A picture's files deleted, its image source with them: each one tried, less any still needed. Gives those that could not be deleted. */
  private async drop(p: Picture): Promise<string[]> {
    const left: string[] = [];
    for (const rel of filesOf(p)) {
      const file = join(this.dir, rel);
      if (this.needed && (await this.needed(file).catch(() => true))) continue;
      await rm(file, { force: true }).catch(() => left.push(rel));
    }
    return left;
  }

  /**
   * The image source beside a picture (src/sources.ts): how it was made, for drawing it again later or on another PC.
   * Never a fault: the picture is saved either way.
   */
  async saveSource(p: Picture, o: Parameters<typeof sourceOf>[1] = {}): Promise<void> {
    if (!/^\d{4}-\d{2}\/[\w.-]+$/.test(p.output)) return;
    await writeSource(join(this.dir, p.output.slice(0, 7)), sourceOf(p, o)).catch(() => undefined);
  }

  /** How many pictures each chat has (not removed). */
  async countByChat(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const p of await this.all()) if (!p.removed && p.chat) out[p.chat] = (out[p.chat] ?? 0) + 1;
    return out;
  }

  async get(id: string): Promise<Picture | undefined> {
    return (await this.all()).find(p => p.id === id);
  }

  /** The picture already drawn for a queue line's request id, while its file is still listed. */
  async ofQueue(rid: string): Promise<Picture | undefined> {
    return (await this.all()).findLast(p => p.queued === rid && !p.removed && !p.private);
  }

  /** Writes a new file in this month's folder and gives its relative name. A name already taken gets -2, -3 and so on: the write itself refuses a taken name, so two saves at once never share a file. */
  async save(name: string, data: Buffer): Promise<string> {
    const month = new Date().toISOString().slice(0, 7);
    await mkdir(join(this.dir, month), { recursive: true });
    for (let n = 1; ; n++) {
      const rel = `${month}/${n === 1 ? name : name.replace(/(\.[a-z]+)?$/i, `-${n}$1`)}`;
      try {
        await writeFile(join(this.dir, rel), data, { flag: 'wx' });
        return rel;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
  }

  add(p: Picture): Promise<void> {
    return this.inOrder(async () => {
      await mkdir(this.dir, { recursive: true });
      // Read the list before the new line is written, or a first read would find the picture and it would be added twice.
      // A list that cannot be read now does not lose a finished picture: its line is written, and the next read finds it.
      const all = await this.all().catch(() => null);
      await this.line(`${JSON.stringify(p)}\n`);
      all?.push(p);
    });
  }

  update(id: string, change: Partial<Picture>): Promise<Picture | undefined> {
    return this.inOrder(async () => {
      const p = (await this.all()).find(x => x.id === id);
      if (!p) return undefined;
      await this.write(p, change);
      return p;
    });
  }

  /** Into the gallery, or back to the drafts. `fromDraft`: this press took it out of the drafts, which happens once. */
  keep(id: string, kept: boolean): Promise<{ picture: Picture; fromDraft: boolean } | undefined> {
    return this.inOrder(async () => {
      const p = (await this.all()).find(x => x.id === id);
      if (!p || p.removed) return undefined;
      const fromDraft = kept && p.kept === false;
      await this.write(p, { kept });
      return { picture: p, fromDraft };
    });
  }

  /** The full path of a file named in the gallery (null for anything else). */
  async file(rel: string): Promise<string | null> {
    if (!/^\d{4}-\d{2}\/[\w.-]+$/.test(rel)) return null;
    const known = (await this.all()).some(p => !p.removed && !p.private && (p.original === rel || p.output === rel || p.icoFiles?.includes(rel)));
    return known ? join(this.dir, rel) : null;
  }
}

// ---- The Videos shelf: clips a Videographer made (src/clips.ts), in data/videos ----

/**
 * Where a clip's start picture is kept, never as an extra copy: `path` is the picture itself on this PC (a gallery
 * picture, a project's, or a new PNG kept for it). In a project's chat it is also in the project's Start frames folder
 * (`project`, relative to the workspace) as a hard link to the same file; `copied` when that folder is on another drive.
 */
export interface ClipStart {
  path: string;
  project?: string;
  copied?: boolean;
}

/** One clip on the Videos shelf, with how it was made. Kept in data/videos/clips.jsonl, the file by month beside it. */
export interface ClipRecord {
  id: string;
  at: string;
  /** As typed. */
  prompt: string;
  seconds: number;
  width: number;
  height: number;
  quality: string;
  model: string;
  /** Relative to data/videos ("2026-11/clip-ab12.webm"). */
  file: string;
  mime: 'video/mp4' | 'video/webm';
  bytes: number;
  tookMs: number;
  /** Who made it ("staff:<id>"). */
  who: string;
  /** The chat it was asked in ('' = none). */
  chat: string;
  /** The picture it started from, when it started from one. */
  start?: ClipStart;
  /** The seed it was made with (older clips have none). */
  seed?: number;
  /** The words left out of it. */
  negative?: string;
  /** Steps asked by hand (none = the quality's own). */
  steps?: number;
  /** The PC it was made on, by name ('this PC' for here). */
  pc?: string;
  /** A video joined from a shot list: the shots it joined, by number. */
  joined?: number[];
  /** Deleted: its file is gone and it is no longer listed. */
  removed?: boolean;
}

const CLIP_FILE = /^\d{4}-\d{2}\/[\w.-]+\.(?:mp4|webm)$/;
const wholeClip = (c: ClipRecord): boolean => typeof c?.id === 'string' && typeof c.at === 'string' && typeof c.prompt === 'string' && typeof c.file === 'string';

/** The Videos shelf: one line per clip in clips.jsonl, later lines for the same id changing it. Only files it wrote are served. */
export class ClipShelf {
  readonly dir: string;
  private cache: ClipRecord[] | null = null;
  private turn: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  private get index(): string {
    return join(this.dir, 'clips.jsonl');
  }

  async all(): Promise<ClipRecord[]> {
    if (this.cache) return this.cache;
    let text = '';
    try {
      text = withoutMark(await heldWait(() => readFile(this.index, 'utf8')));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw new Error(`The list of clips could not be read (${code ?? 'a disk fault'}). Your clips are still on the disk: try again in a moment.`);
    }
    const byId = new Map<string, ClipRecord>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const c = JSON.parse(line) as ClipRecord;
        if (typeof c?.id === 'string') byId.set(c.id, { ...byId.get(c.id), ...c });
      } catch {
        // a half-written line after a crash: skipped
      }
    }
    this.cache ??= [...byId.values()].filter(wholeClip);
    return this.cache;
  }

  private inOrder<T>(job: () => Promise<T>): Promise<T> {
    const run = this.turn.then(job);
    this.turn = run.catch(() => undefined);
    return run;
  }

  /** Newest first; only clips whose prompt has every word of `q`; only one chat's when `chat` is given. */
  async list(offset = 0, limit = 60, q = '', chat?: string): Promise<{ clips: ClipRecord[]; total: number }> {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const all = (await this.all())
      .filter(c => !c.removed && (chat === undefined || c.chat === chat))
      .filter(c => words.every(w => c.prompt.toLowerCase().includes(w)))
      .reverse();
    return { clips: all.slice(offset, offset + limit), total: all.length };
  }

  async get(id: string): Promise<ClipRecord | undefined> {
    return (await this.all()).find(c => c.id === id && !c.removed);
  }

  /** A finished clip's file moved onto the shelf (this month's folder), and its relative name. A taken name gets -2, -3. */
  async take(from: string, name: string): Promise<string> {
    const month = new Date().toISOString().slice(0, 7);
    await mkdir(join(this.dir, month), { recursive: true });
    for (let n = 1; ; n++) {
      const rel = `${month}/${n === 1 ? name : name.replace(/(\.[a-z0-9]+)?$/i, `-${n}$1`)}`;
      const h = await open(join(this.dir, rel), 'wx').catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'EEXIST') return null;
        throw e;
      });
      if (!h) continue;
      await h.close();
      try {
        await rename(from, join(this.dir, rel));
      } catch {
        // Another drive: copied, then the runner's file removed.
        await copyFile(from, join(this.dir, rel));
        await rm(from, { force: true });
      }
      return rel;
    }
  }

  add(c: ClipRecord): Promise<void> {
    return this.inOrder(async () => {
      await mkdir(this.dir, { recursive: true });
      const all = await this.all().catch(() => null);
      await appendFile(this.index, `${JSON.stringify(c)}\n`);
      all?.push(c);
    });
  }

  /** A clip's file deleted and the clip marked removed. False when there was no such clip. */
  remove(id: string): Promise<boolean> {
    return this.inOrder(async () => {
      const c = (await this.all()).find(x => x.id === id);
      if (!c || c.removed) return false;
      if (CLIP_FILE.test(c.file)) await rm(join(this.dir, c.file), { force: true });
      await appendFile(this.index, `${JSON.stringify({ id, removed: true })}\n`);
      c.removed = true;
      return true;
    });
  }

  /** The full path of a clip file named on the shelf, and its type (null for anything else). */
  async file(rel: string): Promise<{ path: string; mime: string } | null> {
    if (!CLIP_FILE.test(rel)) return null;
    const c = (await this.all()).find(x => !x.removed && x.file === rel);
    return c ? { path: join(this.dir, rel), mime: c.mime } : null;
  }
}

// ---- The Voice shelf: voice-overs read aloud (src/voice.ts), in data/voice ----

/** One voice-over on the Voice shelf. Kept in data/voice/voice.jsonl, the WAV file by month beside it. */
export interface VoiceRecord {
  id: string;
  at: string;
  /** As typed. */
  text: string;
  /** Kokoro's voice id (src/voice.ts VOICES). */
  voice: string;
  speed: number;
  seconds: number;
  /** Relative to data/voice ("2026-11/voice-ab12.wav"). */
  file: string;
  bytes: number;
  tookMs: number;
  /** The chat it was made from ('' = none). */
  chat: string;
  /** Deleted: its file is gone and it is no longer listed. */
  removed?: boolean;
}

const VOICE_FILE = /^\d{4}-\d{2}\/[\w.-]+\.wav$/;
const wholeVoice = (v: VoiceRecord): boolean => typeof v?.id === 'string' && typeof v.at === 'string' && typeof v.text === 'string' && typeof v.file === 'string';

/** The Voice shelf, kept as the Videos shelf is: one line per voice-over, later lines for the same id changing it. */
export class VoiceShelf {
  readonly dir: string;
  private cache: VoiceRecord[] | null = null;
  private turn: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  private get index(): string {
    return join(this.dir, 'voice.jsonl');
  }

  async all(): Promise<VoiceRecord[]> {
    if (this.cache) return this.cache;
    let text = '';
    try {
      text = withoutMark(await heldWait(() => readFile(this.index, 'utf8')));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw new Error(`The list of voice-overs could not be read (${code ?? 'a disk fault'}). They are still on the disk: try again in a moment.`);
    }
    const byId = new Map<string, VoiceRecord>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line) as VoiceRecord;
        if (typeof v?.id === 'string') byId.set(v.id, { ...byId.get(v.id), ...v });
      } catch {
        // a half-written line after a crash: skipped
      }
    }
    this.cache ??= [...byId.values()].filter(wholeVoice);
    return this.cache;
  }

  private inOrder<T>(job: () => Promise<T>): Promise<T> {
    const run = this.turn.then(job);
    this.turn = run.catch(() => undefined);
    return run;
  }

  /** Newest first; only those whose text has every word of `q`; only one chat's when `chat` is given. */
  async list(offset = 0, limit = 60, q = '', chat?: string): Promise<{ items: VoiceRecord[]; total: number }> {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const all = (await this.all())
      .filter(v => !v.removed && (chat === undefined || v.chat === chat))
      .filter(v => words.every(w => v.text.toLowerCase().includes(w)))
      .reverse();
    return { items: all.slice(offset, offset + limit), total: all.length };
  }

  async get(id: string): Promise<VoiceRecord | undefined> {
    return (await this.all()).find(v => v.id === id && !v.removed);
  }

  /** A WAV written onto the shelf (this month's folder), and its relative name. A taken name gets -2, -3. */
  async save(wav: Buffer, name: string): Promise<string> {
    const month = new Date().toISOString().slice(0, 7);
    await mkdir(join(this.dir, month), { recursive: true });
    for (let n = 1; ; n++) {
      const rel = `${month}/${n === 1 ? name : name.replace(/(\.[a-z0-9]+)?$/i, `-${n}$1`)}`;
      const h = await open(join(this.dir, rel), 'wx').catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'EEXIST') return null;
        throw e;
      });
      if (!h) continue;
      try {
        await h.writeFile(wav);
      } finally {
        await h.close();
      }
      return rel;
    }
  }

  add(v: VoiceRecord): Promise<void> {
    return this.inOrder(async () => {
      await mkdir(this.dir, { recursive: true });
      const all = await this.all().catch(() => null);
      await appendFile(this.index, `${JSON.stringify(v)}\n`);
      all?.push(v);
    });
  }

  /** A voice-over's file deleted and it marked removed. False when there was no such voice-over. */
  remove(id: string): Promise<boolean> {
    return this.inOrder(async () => {
      const v = (await this.all()).find(x => x.id === id);
      if (!v || v.removed) return false;
      if (VOICE_FILE.test(v.file)) await rm(join(this.dir, v.file), { force: true });
      await appendFile(this.index, `${JSON.stringify({ id, removed: true })}\n`);
      v.removed = true;
      return true;
    });
  }

  /** The full path of a WAV named on the shelf (null for anything else). */
  async file(rel: string): Promise<string | null> {
    if (!VOICE_FILE.test(rel)) return null;
    return (await this.all()).some(x => !x.removed && x.file === rel) ? join(this.dir, rel) : null;
  }
}
