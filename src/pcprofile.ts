// A PC's own details, as its owner remembers it: a name ("Study laptop", "Gaming PC"), its make and model ("Dell
// OptiPlex 9020", "HP Z240") and a photo of the machine. Kept on this PC only (data/pc-profiles/), one entry per PC:
// 'here' for this one, a linked PC by its link id. Shown in the left panel ("Study laptop", "16 GB / 0 VRAM") and the PC
// window. A linked PC's own name (the one it calls itself) is never changed: these are this PC's words for it.
// Plain functions and a small store, tested in test/pcprofile.test.ts.
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { readData, writeAtomic } from './atomic.ts';

export interface PcProfile {
  /** What you call it ("Study laptop"); '' = the name it has. */
  name: string;
  /** Its make and model ("Dell OptiPlex 9020"); '' = not given. */
  model: string;
  /** When its photo was set (the photo's address changes with it); '' = no photo. */
  photo: string;
}
export type PcProfiles = Record<string, PcProfile>;

/** The longest name, and make and model, kept. */
export const NAME_MAX = 40;
export const MODEL_MAX = 60;
/** The photo's square side, in pixels, and the largest picture taken in (as sent, before it is made smaller). */
export const PHOTO_SIZE = 512;
export const PHOTO_MAX_BYTES = 15 * 2 ** 20;

/** 'here' or a link id: the only keys kept, so a key is also safe as a file name. */
export const isPcKey = (k: string): boolean => /^(here|[a-z0-9][a-z0-9-]{0,63})$/.test(k);

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function cleanProfile(raw: unknown): PcProfile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { name: text(r.name, NAME_MAX), model: text(r.model, MODEL_MAX), photo: typeof r.photo === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(r.photo) ? r.photo : '' };
}

/** The name shown for a PC: what you call it, else its make and model, else the name it has. */
export const shownName = (p: PcProfile | undefined, fallback: string): string => p?.name || p?.model || fallback;

/**
 * A photo as the page sends it (a data: address of a PNG, JPEG, WebP or GIF) made into the kept square PNG: turned
 * the right way up (a phone photo's EXIF), the middle kept. Anything else says what went wrong in plain words.
 */
export async function photoPng(dataUrl: unknown): Promise<Buffer> {
  const m = typeof dataUrl === 'string' ? /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl) : null;
  if (!m) throw new Error('That is not a picture this can take. Pick a PNG, JPEG, WebP or GIF photo.');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > PHOTO_MAX_BYTES) throw new Error(`That photo is ${Math.round(bytes.length / 2 ** 20)} MB; the most it takes is 15 MB. Pick a smaller one, or take it again at a lower size.`);
  try {
    return await sharp(bytes, { animated: false, limitInputPixels: 80_000_000 }).rotate().resize({ width: PHOTO_SIZE, height: PHOTO_SIZE, fit: 'cover', position: 'centre' }).png().toBuffer();
  } catch {
    throw new Error('That file could not be read as a picture (it may be damaged, or not really a picture). Try another photo.');
  }
}

/** The store: index.json plus <key>.png for each photo. */
export class PcProfileStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  async all(): Promise<PcProfiles> {
    const raw = await readData<Record<string, unknown> | null>(join(this.dir, 'index.json'), null);
    if (!raw || typeof raw !== 'object') return {};
    const out: PcProfiles = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!isPcKey(k)) continue;
      const p = cleanProfile(v);
      // A photo whose file went missing is no photo.
      if (p.photo && !existsSync(join(this.dir, `${k}.png`))) p.photo = '';
      if (p.name || p.model || p.photo) out[k] = p;
    }
    return out;
  }

  async get(key: string): Promise<PcProfile> {
    return (await this.all())[key] ?? cleanProfile({});
  }

  private async write(all: PcProfiles): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeAtomic(join(this.dir, 'index.json'), JSON.stringify(all, null, 1));
  }

  /** Sets the name and make and model ('' clears either); the photo stays. */
  async setWords(key: string, words: { name?: unknown; model?: unknown }): Promise<PcProfile> {
    if (!isPcKey(key)) throw new Error('No such PC.');
    const all = await this.all();
    const was = all[key] ?? cleanProfile({});
    const p = { ...was, ...(words.name !== undefined ? { name: text(words.name, NAME_MAX) } : {}), ...(words.model !== undefined ? { model: text(words.model, MODEL_MAX) } : {}) };
    all[key] = p;
    await this.write(all);
    return p;
  }

  /** Keeps `png` (from photoPng) as the PC's photo, or takes it away with null. */
  async setPhoto(key: string, png: Buffer | null, now = new Date()): Promise<PcProfile> {
    if (!isPcKey(key)) throw new Error('No such PC.');
    const all = await this.all();
    const p = { ...(all[key] ?? cleanProfile({})) };
    if (png) {
      await mkdir(this.dir, { recursive: true });
      await writeAtomic(join(this.dir, `${key}.png`), png);
      p.photo = now.toISOString();
    } else {
      await rm(join(this.dir, `${key}.png`), { force: true });
      p.photo = '';
    }
    all[key] = p;
    await this.write(all);
    return p;
  }

  /** A linked PC removed: its details and photo go with it. */
  async forget(key: string): Promise<void> {
    if (!isPcKey(key)) return;
    const all = await this.all();
    if (!all[key]) return;
    delete all[key];
    await this.write(all);
    await rm(join(this.dir, `${key}.png`), { force: true });
  }

  /** The photo file of a PC, or null. */
  async photoPath(key: string): Promise<string | null> {
    return isPcKey(key) && (await this.get(key)).photo ? join(this.dir, `${key}.png`) : null;
  }
}

/** For the page: the details plus the photo's address (its `v` changes when the photo does). */
export const profileView = (key: string, p: PcProfile) => ({ name: p.name, model: p.model, photo: p.photo ? `/api/pc/photo/${encodeURIComponent(key)}?v=${encodeURIComponent(p.photo)}` : null });
