// Image sources: beside each picture, <name>.source.json says how it was made (the words, the seed, the steps, the model),
// so a project picked up later, or copied to another PC with TOMLIN, can draw it again or draw more like it, even when
// the picture file itself is gone. Git leaves these files out (the finished work holds only the pictures), so they go
// with the folder when it is copied. Relative names only: no folder paths, no people, no addresses.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Picture } from './gallery.ts';
import { MODES, type Mode } from './modes.ts';
import type { Size } from './sizes.ts';

/** How a picture was drawn, as the PC that drew it tells the PC that asked (a linked PC's picture). */
export interface Made {
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  negative: string;
  generated: Size;
  target: Size;
  fit: string;
  draft: boolean;
  /** The picture model's id in TOMLIN's list, its file and its licence, where known. */
  model: string;
  modelFile: string;
  licence: string;
  /** The TOMLIN that drew it. */
  tomlin: string;
}

export interface ImageSource {
  /** The picture's file name, in the same folder. */
  file: string;
  prompt: string;
  modelPrompt: string;
  negative: string;
  /** 'unknown': drawn by an older TOMLIN on a linked PC that sent no settings back; the seed and the rest are not known. */
  settings: 'known' | 'unknown';
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  model: string;
  modelName: string;
  modelFile: string;
  licence: string;
  mode: Mode;
  generated: Size;
  target: Size;
  fit: string;
  /** The part of the drawn picture that was kept when it was cut to size (null: none was cut away). */
  crop: { left: number; top: number; width: number; height: number } | null;
  draft: boolean;
  at: string;
  tomlin: string;
  /** Where it was drawn: this PC's device, or "on <the linked PC's name in TOMLIN>". */
  drawnOn: string;
}

export const SOURCE_END = '.source.json';
/** The git rule that leaves image sources out. */
export const IGNORE_LINE = `*${SOURCE_END}`;
/** "boat-512x512.png" -> "boat-512x512.png.source.json": the whole picture name, so a .png and a .webp of one name each have their own. */
export const sourceName = (file: string): string => `${file}${SOURCE_END}`;

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const whole = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
function sizeOf(v: unknown): Size | null {
  const o = (v ?? {}) as Record<string, unknown>;
  const width = whole(o.width, 16, 8192);
  const height = whole(o.height, 16, 8192);
  return width && height ? { width, height } : null;
}
/** A file's own name: no folder in it, nothing Windows refuses. */
const fileName = (v: unknown): string => (typeof v === 'string' && /^[^\\/:*?"<>|\0]{1,200}$/.test(v) && !/^\.+$/.test(v) ? v : '');

/** What a linked PC said about how it drew a picture, checked (it comes over the network), or null when it said none of it. */
export function cleanMade(v: unknown): Made | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const seed = whole(o.seed, 0, 2 ** 32);
  const steps = whole(o.steps, 1, 1000);
  const generated = sizeOf(o.generated);
  const target = sizeOf(o.target);
  if (seed === null || steps === null || typeof o.cfg !== 'number' || !(o.cfg >= 0 && o.cfg <= 100) || typeof o.sampler !== 'string' || !/^[\w+]{1,40}$/.test(o.sampler) || !generated || !target) return null;
  return {
    seed, steps, cfg: o.cfg, sampler: o.sampler, scheduler: /^[\w+]{0,40}$/.test(text(o.scheduler, 41)) ? text(o.scheduler, 40) : '', negative: text(o.negative, 4000),
    generated, target, fit: ['crop', 'pad', 'stretch'].includes(String(o.fit)) ? String(o.fit) : 'crop', draft: o.draft === true,
    model: /^[\w.-]{1,80}$/.test(text(o.model, 81)) ? text(o.model, 80) : '', modelFile: fileName(o.modelFile), licence: text(o.licence, 200), tomlin: /^[\w.+-]{1,30}$/.test(text(o.tomlin, 31)) ? text(o.tomlin, 30) : '',
  };
}

/** The part of a picture drawn at `generated` that a centred cut to `target`'s shape keeps. */
export function cropBox(generated: Size, target: Size, fit: string): ImageSource['crop'] {
  if (fit !== 'crop' || generated.width * target.height === generated.height * target.width) return null;
  const scale = Math.max(target.width / generated.width, target.height / generated.height);
  const width = Math.min(generated.width, Math.round(target.width / scale));
  const height = Math.min(generated.height, Math.round(target.height / scale));
  return { left: Math.floor((generated.width - width) / 2), top: Math.floor((generated.height - height) / 2), width, height };
}

/** A picture's source, from its gallery entry and what only the PC that drew it knows. */
export function sourceOf(p: Picture, o: { modelFile?: string; licence?: string; tomlin?: string; model?: string } = {}): ImageSource {
  return {
    file: p.output.split('/').pop()!, prompt: p.prompt, modelPrompt: p.modelPrompt, negative: p.negative,
    settings: p.settingsUnknown ? 'unknown' : 'known', seed: p.seed, steps: p.steps, cfg: p.cfg, sampler: p.sampler, scheduler: p.scheduler ?? '',
    model: o.model ?? p.model, modelName: p.modelName, modelFile: o.modelFile ?? '', licence: o.licence ?? '',
    mode: p.mode, generated: p.generated, target: p.target, fit: p.fit, crop: cropBox(p.generated, p.target, p.fit), draft: p.draft, at: p.at, tomlin: o.tomlin ?? '', drawnOn: p.device,
  };
}

/** A source read from a file (which anyone may have edited), checked; null when it is not one. */
export function cleanSource(v: unknown): ImageSource | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const prompt = text(o.prompt, 2000).trim();
  const file = fileName(o.file);
  if (!prompt || !file) return null;
  const made = cleanMade(o);
  const size = { width: 512, height: 512 };
  const generated = made?.generated ?? sizeOf(o.generated) ?? sizeOf(o.target) ?? size;
  const target = made?.target ?? sizeOf(o.target) ?? generated;
  const fit = made?.fit ?? 'crop';
  return {
    file, prompt, modelPrompt: text(o.modelPrompt, 4000), negative: made?.negative ?? '',
    settings: made && o.settings !== 'unknown' ? 'known' : 'unknown',
    seed: made?.seed ?? 0, steps: made?.steps ?? 0, cfg: made?.cfg ?? 0, sampler: made?.sampler ?? '', scheduler: made?.scheduler ?? '',
    model: made?.model ?? '', modelName: text(o.modelName, 200), modelFile: made?.modelFile ?? fileName(o.modelFile), licence: made?.licence ?? text(o.licence, 200),
    mode: (MODES as string[]).includes(String(o.mode)) ? (o.mode as Mode) : 'custom', generated, target, fit, crop: cropBox(generated, target, fit), draft: o.draft === true,
    at: Number.isFinite(Date.parse(text(o.at, 40))) ? text(o.at, 40) : '', tomlin: made?.tomlin ?? '', drawnOn: text(o.drawnOn, 100),
  };
}

/** Writes the source beside its picture (`dir` is the picture's folder). */
export async function writeSource(dir: string, s: ImageSource): Promise<string> {
  const name = sourceName(s.file);
  await writeFile(join(dir, name), `${JSON.stringify(s, null, 2)}\n`);
  return name;
}

export interface FoundSource extends ImageSource {
  /** The source file, from the folder that was read, with / between folders. */
  path: string;
  /** Whether the picture file is still beside it. */
  pictureThere: boolean;
}

/**
 * Every image source in a folder and the folders in it, newest first. Links are not followed; .git and node_modules
 * are not looked in. `more`: there were over `limit`, and only the newest `limit` were read (newest by when each file
 * was last written, so the newest pictures are always among them, wherever they are in the folders).
 */
export async function readSources(dir: string, limit = 500): Promise<{ sources: FoundSource[]; more: boolean; damaged: number }> {
  // Every source file is found first (up to FOUND_MOST), with when it was written; only the newest are then read.
  const FOUND_MOST = 50_000;
  const found: Array<{ full: string; path: string; names: import('node:fs').Dirent[]; at: number }> = [];
  let more = false;
  let damaged = 0;
  const walk = async (at: string, rel: string, depth: number): Promise<void> => {
    let names: import('node:fs').Dirent[];
    try {
      names = await readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (found.length >= FOUND_MOST) {
        more = true;
        return;
      }
      if (d.isSymbolicLink()) continue;
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (depth < 8 && d.name !== '.git' && d.name !== 'node_modules') await walk(join(at, d.name), path, depth + 1);
      } else if (d.isFile() && d.name.endsWith(SOURCE_END)) {
        const full = join(at, d.name);
        const st = await stat(full).catch(() => null);
        // A source is a page of text at most: anything bigger is not one.
        if (!st || st.size > 64 * 1024) damaged++;
        else found.push({ full, path, names, at: st.mtimeMs });
      }
    }
  };
  await walk(dir, '', 0);
  found.sort((a, b) => b.at - a.at);
  const sources: FoundSource[] = [];
  let i = 0;
  for (; i < found.length && sources.length < limit; i++) {
    const f = found[i];
    let s: ImageSource | null = null;
    try {
      s = cleanSource(JSON.parse(await readFile(f.full, 'utf8')));
    } catch {
      s = null;
    }
    if (!s) damaged++;
    else sources.push({ ...s, path: f.path, pictureThere: f.names.some(x => x.isFile() && x.name === s!.file) });
  }
  if (i < found.length) more = true;
  sources.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { sources, more, damaged };
}

/**
 * Has git leave image sources out of the project in `folder`: the rule is added to its .gitignore (made when there is
 * none). True when the rule was added now; false when it was there already or the file could not be written.
 */
export async function ignoreSources(folder: string): Promise<boolean> {
  const file = join(folder, '.gitignore');
  try {
    const now = await readFile(file, 'utf8').catch(e => ((e as NodeJS.ErrnoException).code === 'ENOENT' ? '' : Promise.reject(e)));
    if (now.split(/\r?\n/).some(l => l.trim() === IGNORE_LINE)) return false;
    const eol = now.includes('\r\n') ? '\r\n' : '\n';
    await writeFile(file, `${now}${now && !/\n$/.test(now) ? eol : ''}# TOMLIN image sources (how each picture was made): copy them with the folder, git leaves them out${eol}${IGNORE_LINE}${eol}`);
    return true;
  } catch {
    return false;
  }
}
