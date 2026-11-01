// Past pictures and how each was made, in data/images/: the files by month, and gallery.jsonl with one line per
// picture (prompt, seed, sizes, mode, model, time). Only names this file wrote can be served back.
import { appendFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Size } from './sizes.ts';
import type { Mode } from './modes.ts';

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
}

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
      this.endChecked = true;
      const h = await open(this.index, 'r').catch(() => null);
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
    await appendFile(this.index, lead + text);
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
      text = await readFile(this.index, 'utf8');
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
    for (const p of old) {
      for (const rel of new Set([p.original, p.output, ...(p.icoFiles ?? [])])) {
        if (/^\d{4}-\d{2}\/[\w.-]+$/.test(rel)) await rm(join(this.dir, rel), { force: true });
      }
      await this.update(p.id, { removed: true });
    }
    return old.length;
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
        for (const rel of new Set([p.original, p.output, ...(p.icoFiles ?? [])])) {
          if (/^\d{4}-\d{2}\/[\w.-]+$/.test(rel)) await rm(join(this.dir, rel), { force: true });
        }
        await this.update(p.id, { removed: true });
      } else await this.update(p.id, { chat: '' });
    }
    return mine.length;
  }

  /** One picture's files deleted and the picture marked removed (a picture this PC drew for a paired PC keeps no copy here). */
  async remove(id: string): Promise<void> {
    const p = await this.get(id);
    if (!p || p.removed) return;
    for (const rel of new Set([p.original, p.output, ...(p.icoFiles ?? [])])) {
      if (/^\d{4}-\d{2}\/[\w.-]+$/.test(rel)) await rm(join(this.dir, rel), { force: true });
    }
    await this.update(p.id, { removed: true });
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
