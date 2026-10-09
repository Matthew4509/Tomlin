// Downloads that are checked before they are kept: a pinned model (pins.json), or a .gguf from a Hugging Face link,
// where Hugging Face's own SHA-256 for that exact revision is the check. A file is written as name.part, carries on
// from a partial file, and is renamed only when its size and SHA-256 match.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function sha256(path: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

export interface Progress {
  got: number;
  bytes: number;
  checking: boolean;
}

/** Downloads `url` to `dest` (via dest.part), checks size and hash, then keeps it. */
export async function fetchChecked(url: string, dest: string, bytes: number, hash: string, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<'kept' | 'already'> {
  if (existsSync(dest) && statSync(dest).size === bytes && (await sha256(dest)) === hash) return 'already';
  // Another model with the same file name (a different repo, or another size of it): never written over.
  if (existsSync(dest)) throw new Error(`A different model file named ${basename(dest)} is already on this PC. Delete it under Models first (or pick another model), then download this one.`);
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let have = 0;
  try {
    have = statSync(part).size;
  } catch {
    have = 0;
  }
  // Downloaded whole last time but not yet checked (it stopped before the last step): checked now, not fetched again.
  if (have === bytes) {
    onProgress?.({ got: have, bytes, checking: true });
    if ((await sha256(part)) === hash) {
      await rename(part, dest);
      return 'kept';
    }
  }
  if (have >= bytes) {
    await rm(part, { force: true });
    have = 0;
  }
  let res = await fetch(url, { headers: have ? { range: `bytes=${have}-` } : {}, redirect: 'follow', signal });
  // 416: the server cannot go on from where the part stopped (the file changed): the part goes, and it starts again.
  if (res.status === 416 && have) {
    await rm(part, { force: true });
    have = 0;
    res = await fetch(url, { redirect: 'follow', signal });
  }
  if (!res.ok || !res.body) throw new Error(`The download could not start: the server answered ${res.status}. Try again later.`);
  if (have && res.status !== 206) have = 0; // the server ignored the range: start again
  let got = have;
  onProgress?.({ got, bytes, checking: false });
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      got += chunk.length;
      onProgress?.({ got, bytes, checking: false });
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(part, { flags: have ? 'a' : 'w' }), { signal });
  onProgress?.({ got, bytes, checking: true });
  const actual = await sha256(part);
  if (actual !== hash) {
    await rm(part, { force: true });
    throw new Error('The downloaded file did not match its SHA-256 check, so it was deleted. Try again; if it fails again, the file on the server has changed.');
  }
  await rename(part, dest);
  return 'kept';
}

// ---- Hugging Face links ----

export interface HfFile {
  /** Path inside the repo. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface HfModel {
  /** Shown name: the file name, without parts. */
  name: string;
  /** All its files (more than one when the model comes in parts), in order. */
  files: HfFile[];
  bytes: number;
}

export interface HfLookup {
  repo: string;
  rev: string;
  licence: string;
  models: HfModel[];
  /** Parameters (from the GGUF header Hugging Face reads), when it says. */
  params: number | null;
}

/** owner/repo, and a file path when the link points at one. Only huggingface.co links are taken. */
export function parseHfLink(link: string): { repo: string; rev: string; path: string } | null {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/^(www\.)?huggingface\.co$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2 || ['api', 'datasets', 'spaces', 'docs', 'models'].includes(parts[0])) return null;
  const repo = `${parts[0]}/${parts[1]}`;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  if ((parts[2] === 'blob' || parts[2] === 'resolve' || parts[2] === 'tree') && parts[3]) {
    return { repo, rev: parts[3], path: parts.slice(4).join('/') };
  }
  return { repo, rev: 'main', path: '' };
}

const SPLIT = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

/** Groups .gguf files into models: parts of one model together, add-ons left out (vision: mmproj; the small draft heads some repos carry for faster answers: mtp-...). */
export function groupGguf(files: HfFile[]): HfModel[] {
  const models = new Map<string, HfModel>();
  for (const f of files) {
    const base = f.path.split('/').pop()!;
    if (!/\.gguf$/i.test(base) || /mmproj/i.test(base) || /^mtp[-_]/i.test(base)) continue;
    const split = SPLIT.exec(f.path);
    const key = split ? split[1] : f.path;
    const m = models.get(key) ?? { name: (split ? split[1] : f.path.replace(/\.gguf$/i, '')).split('/').pop()!, files: [], bytes: 0 };
    m.files.push(f);
    m.bytes += f.bytes;
    models.set(key, m);
  }
  for (const m of models.values()) m.files.sort((a, b) => a.path.localeCompare(b.path));
  return [...models.values()].sort((a, b) => a.bytes - b.bytes);
}

/** What a Hugging Face link offers: its .gguf models at one fixed revision, each file with Hugging Face's SHA-256. */
export async function lookUpHf(link: string): Promise<HfLookup> {
  const at = parseHfLink(link);
  if (!at) throw new Error('That is not a Hugging Face model link. Paste a link that starts https://huggingface.co/ followed by the model\'s owner and name.');
  const info = await fetch(`https://huggingface.co/api/models/${at.repo}/revision/${encodeURIComponent(at.rev)}`, { signal: AbortSignal.timeout(15_000) });
  if (info.status === 401 || info.status === 404) throw new Error(`Hugging Face has no public model ${at.repo}. Check the link.`);
  if (!info.ok) throw new Error(`Hugging Face answered ${info.status}. Try again later.`);
  const meta = await info.json() as { sha: string; gated?: unknown; cardData?: { license?: string }; gguf?: { total?: number } };
  if (meta.gated) throw new Error('This model needs a Hugging Face account and an accepted licence to download. Download it with LM Studio or the website, then use Search this PC.');
  const dir = at.path && !/\.gguf$/i.test(at.path) ? at.path : at.path.split('/').slice(0, -1).join('/');
  // Every folder, not only the top one: bigger models keep each size in a folder of its own (Q4_K_M/...-00001-of-00003.gguf).
  const entries = await hfTree(at.repo, meta.sha, dir);
  const files = entries.filter(e => e.type === 'file' && e.lfs).map(e => ({ path: e.path, bytes: e.lfs!.size, sha256: e.lfs!.oid }));
  let models = groupGguf(files);
  if (/\.gguf$/i.test(at.path)) {
    const want = SPLIT.exec(at.path)?.[1] ?? at.path;
    models = models.filter(m => (SPLIT.exec(m.files[0].path)?.[1] ?? m.files[0].path) === want);
  }
  if (!models.length) throw new Error('No .gguf model files at that link. Chat models here are GGUF files: look for a repo whose name ends in -GGUF.');
  const params = Number(meta.gguf?.total) > 0 ? Number(meta.gguf!.total) : null;
  return { repo: at.repo, rev: meta.sha, licence: meta.cardData?.license ?? 'not stated', models, params };
}

type TreeEntry = { type: string; path: string; size: number; lfs?: { oid: string; size: number } };
/** A repo's files at one revision, every folder down (Hugging Face pages a long list: its Link header names the next page). */
async function hfTree(repo: string, rev: string, dir: string): Promise<TreeEntry[]> {
  let url: string | null = `https://huggingface.co/api/models/${repo}/tree/${rev}${dir ? `/${dir.split('/').map(encodeURIComponent).join('/')}` : ''}?recursive=true`;
  const all: TreeEntry[] = [];
  for (let page = 0; url && page < 10; page++) {
    const r: Response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`Hugging Face answered ${r.status} for the file list. Try again later.`);
    all.push(...await r.json() as TreeEntry[]);
    url = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') ?? '')?.[1] ?? null;
  }
  return all;
}

/** The size most people pick: Q4_K_M when there is one, else the smallest file of at least 4 bits, else the biggest. */
export function usualModel(models: HfModel[]): HfModel | null {
  if (!models.length) return null;
  return models.find(m => /q4_k_m/i.test(m.name))
    ?? models.find(m => /(?:^|[-_.])(?:i?q4|q5|q6|q8)/i.test(m.name))
    ?? models[models.length - 1];
}

/** Parameters from a repo or file name ("Qwen3.5-9B", "35B-A3B", "0.8B", "270M"), for when Hugging Face does not say. */
export function paramsFromName(name: string): number | null {
  const m = /(?:^|[^\w.])(\d+(?:\.\d+)?)\s*([BM])(?![a-z])/i.exec(name.replace(/[-_]A\d+(?:\.\d+)?B/i, ''));
  if (!m) return null;
  const n = Number(m[1]) * (m[2].toUpperCase() === 'B' ? 1e9 : 1e6);
  return n > 0 ? n : null;
}

export interface HfFound { repo: string; downloads: number; likes: number; gated: boolean; params: number | null }

const CHAT_TAGS = new Set(['text-generation', 'image-text-to-text', 'conversational', 'text2text-generation']);

/**
 * Hugging Face's list answer -> the repos worth showing: GGUF, not private, most downloaded first. When the answer
 * carries the file list and the GGUF header (asked with expand), a repo with no model file of its own (only a vision
 * add-on, or nothing at all) and one that is not a chat model (pictures, speech, search vectors: no chat template and
 * no chat task) are left out: they cannot be used in a chat.
 */
export function hfFound(list: unknown): HfFound[] {
  if (!Array.isArray(list)) return [];
  const fileName = (s: unknown) => String((s as { rfilename?: unknown } | null)?.rfilename ?? '');
  return list.flatMap(x => {
    const r = x as Record<string, unknown>;
    const repo = String(r.id ?? r.modelId ?? '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || r.private === true) return [];
    if (Array.isArray(r.siblings) && !r.siblings.some(s => /\.gguf$/i.test(fileName(s)) && !/mmproj/i.test(fileName(s)))) return [];
    const g = r.gguf as { total?: unknown; chat_template?: unknown } | undefined;
    if (g && !g.chat_template && !CHAT_TAGS.has(String(r.pipeline_tag ?? ''))) return [];
    const total = Number(g?.total) || 0;
    // A header that says far fewer parameters than the name (a small draft or vision file read first) is not believed.
    const named = paramsFromName(repo.split('/')[1]);
    const params = named && (!total || total < named / 2) ? named : total || null;
    return [{ repo, downloads: Number(r.downloads) || 0, likes: Number(r.likes) || 0, gated: !!r.gated && r.gated !== 'false', params }];
  }).sort((a, b) => b.downloads - a.downloads);
}

/** 9 -> "9B" for Hugging Face's parameter filter (it takes 0.5B, 9B, 120B). */
const hfB = (n: number) => `${Math.round(n * 100) / 100}B`;

/**
 * One lot of GGUF models on Hugging Face, most downloaded first, cut to the chat ones: those whose name matches `q`
 * ("all": every one), and, given `minB`/`maxB` (billions of parameters), only that size. The words may be left out
 * when a size is given. Hugging Face pages by a cursor, not a page number: `cursor` is the `next` of the lot before
 * (null for the first), and `next` is null on the last lot. `limit` is the lot's size (40, or a share of it).
 */
export async function searchHf(q: string, size: { minB?: number | null; maxB?: number | null } = {}, cursor: string | null = null, limit = 40, signal?: AbortSignal): Promise<{ found: HfFound[]; next: string | null }> {
  const every = /^all$/i.test(q.trim());
  const words = every ? '' : q.replace(/[^\w .+-]/g, ' ').trim().slice(0, 80);
  const minB = Number(size.minB) > 0 ? Number(size.minB) : null;
  const maxB = Number(size.maxB) > 0 ? Number(size.maxB) : null;
  if (!every && words.length < 2 && !minB && !maxB) return { found: [], next: null };
  const range = [minB ? `min:${hfB(minB)}` : '', maxB ? `max:${hfB(maxB)}` : ''].filter(Boolean).join(',');
  const expand = ['gguf', 'siblings', 'downloads', 'likes', 'gated', 'pipeline_tag', 'private'].map(e => `expand[]=${e}`).join('&');
  const url = `https://huggingface.co/api/models?${words.length >= 2 ? `search=${encodeURIComponent(words)}&` : ''}filter=gguf${range ? `&num_parameters=${range}` : ''}&sort=downloads&direction=-1&limit=${Math.max(1, Math.min(100, Math.round(limit)))}&${expand}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const r = await fetch(url, { signal: signal ?? AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Hugging Face did not answer the search (${r.status}). Try again in a minute.`);
  return { found: hfFound(await r.json()), next: nextCursor(r.headers.get('link')) };
}

/**
 * A page cursor sent back by the page: one place per search (null = from the top, false = that search has no more).
 * Anything else starts every search from the top.
 */
export function cursorPlaces(cursor: unknown, searches: number): (string | null | false)[] {
  const place = (c: unknown) => c === null || c === false || (typeof c === 'string' && /^[\w+/=-]{1,2000}$/.test(c));
  return Array.isArray(cursor) && cursor.length === searches && cursor.every(place) ? cursor : Array.from({ length: searches }, () => null);
}

/** The cursor in Hugging Face's Link header (`<…&cursor=…>; rel="next"`), or null on the last lot. */
export function nextCursor(link: string | null): string | null {
  const at = /[?&]cursor=([^&>]+)[^>]*>;\s*rel="next"/.exec(link ?? '');
  return at ? decodeURIComponent(at[1]) : null;
}

export function hfUrl(repo: string, rev: string, path: string): string {
  return `https://huggingface.co/${repo}/resolve/${rev}/${path.split('/').map(encodeURIComponent).join('/')}`;
}
