// Past pictures and how each was made, in data/images/: the files by month, and gallery.jsonl with one line per
// picture (prompt, seed, sizes, mode, model, time). Only names this file wrote can be served back.
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

export type Shelf = 'gallery' | 'drafts' | 'all';
/** Kept, unless the picture says otherwise (older pictures have no flag and stay in the gallery). */
export const isKept = (p: Picture): boolean => p.kept !== false;

export class Gallery {
  readonly dir: string;
  private cache: Picture[] | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  private get index(): string {
    return join(this.dir, 'gallery.jsonl');
  }

  async all(): Promise<Picture[]> {
    if (!this.cache) {
      let text = '';
      try {
        text = await readFile(this.index, 'utf8');
      } catch {
        text = '';
      }
      // Later lines for the same id (an alt text added) replace earlier ones.
      const byId = new Map<string, Picture>();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line) as Picture;
          byId.set(p.id, { ...byId.get(p.id), ...p });
        } catch {
          // a half-written last line after a crash: skipped
        }
      }
      this.cache = [...byId.values()];
    }
    return this.cache;
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

  /** A folder for this month's files, and a relative name inside it. */
  async place(name: string): Promise<{ rel: string; full: string }> {
    const month = new Date().toISOString().slice(0, 7);
    await mkdir(join(this.dir, month), { recursive: true });
    let rel = `${month}/${name}`;
    for (let n = 2; existsSync(join(this.dir, rel)); n++) rel = `${month}/${name.replace(/(\.[a-z]+)$/i, `-${n}$1`)}`;
    return { rel, full: join(this.dir, rel) };
  }

  async save(name: string, data: Buffer): Promise<string> {
    const { rel, full } = await this.place(name);
    await writeFile(full, data);
    return rel;
  }

  async add(p: Picture): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // Read the list before the new line is written, or a first read would find the picture and it would be added twice.
    const all = await this.all();
    await appendFile(this.index, `${JSON.stringify(p)}\n`);
    all.push(p);
  }

  async update(id: string, change: Partial<Picture>): Promise<Picture | undefined> {
    const all = await this.all();
    const p = all.find(x => x.id === id);
    if (!p) return undefined;
    Object.assign(p, change);
    await appendFile(this.index, `${JSON.stringify({ id, ...change })}\n`);
    return p;
  }

  /** The full path of a file named in the gallery (null for anything else). */
  async file(rel: string): Promise<string | null> {
    if (!/^\d{4}-\d{2}\/[\w.-]+$/.test(rel)) return null;
    const known = (await this.all()).some(p => !p.removed && !p.private && (p.original === rel || p.output === rel || p.icoFiles?.includes(rel)));
    return known ? join(this.dir, rel) : null;
  }
}
