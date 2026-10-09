// The list of GGUF chat models on Hugging Face, kept on this PC (data/hf-list.json), so the Models page searches every
// one with any words and ticks, a page at a time, without asking Hugging Face for each search. "Rescan Hugging Face" reads
// Hugging Face's whole list again: pages of 1,000, most downloaded first, down to the models fewer than 10 people
// downloaded last month (about 200 pages and 70 MB on 5 Oct 2026). The list from before stays until the new one is whole.
// A copy ships with TOMLIN (registry/hf-list.json.gz, made by tools/hf-list.ts), so the first search on a new PC
// already reads a list; Rescan Hugging Face replaces it with this PC's own.
// Plain functions tested in test/hflist.test.ts; the server keeps the file and reads each model's sizes, the page draws it.
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { writeAtomic } from './atomic.ts';
import { paramsFromName } from './download.ts';

/** One model: repo, downloads last month, likes, parameters from its name (null when the name does not say). */
export type ListedModel = [repo: string, downloads: number, likes: number, params: number | null];
export interface HfListFile { scannedAt: string; floor: number; models: ListedModel[] }

/** Fewer downloads than this last month and a model is left off the list. */
export const FLOOR = 10;
const FIRST = `https://huggingface.co/api/models?filter=gguf&sort=downloads&direction=-1&limit=1000&${['downloads', 'likes', 'gated', 'pipeline_tag', 'private'].map(e => `expand[]=${e}`).join('&')}`;
/** What Hugging Face says a chat model is for. A model with no task said is kept: most of those are chat models. */
const CHAT_TASKS = new Set(['text-generation', 'image-text-to-text', 'conversational', 'text2text-generation', 'any-to-any']);

/** One page of Hugging Face's list -> the models worth keeping: public, not behind a licence page, chat (or no task said), used. */
export function listed(page: unknown, floor = FLOOR): ListedModel[] {
  if (!Array.isArray(page)) return [];
  return page.flatMap(x => {
    const r = x as Record<string, unknown>;
    const repo = String(r.id ?? '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || r.private === true || (!!r.gated && r.gated !== 'false')) return [];
    if (r.pipeline_tag && !CHAT_TASKS.has(String(r.pipeline_tag))) return [];
    const downloads = Number(r.downloads) || 0;
    if (downloads < floor) return [];
    return [[repo, downloads, Number(r.likes) || 0, paramsFromName(repo.split('/')[1])] as ListedModel];
  });
}

/** The next page in Hugging Face's Link header, only ever on Hugging Face's own list. */
export function nextPage(link: string | null): string | null {
  const url = /<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1] ?? null;
  return url?.startsWith('https://huggingface.co/api/models?') ? url : null;
}

/** "qwen" finds Huihui-Qwen3.8: a word at the start of a word, or a number straight after letters ("3.5" in Qwen3.5). */
const wordStart = (w: string) => new RegExp(`(?:^|[^a-z0-9]|(?<=[a-z])(?=\\d))${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

/**
 * The listed models matching a search, most downloaded first: every word in the repo's owner/name ("all": every model),
 * any one of the ticked terms (abliterated, uncensored), and the size in billions when the name gives one (a name that
 * does not say is kept; its size is checked when its sizes are read).
 */
export function pick(models: ListedModel[], s: { q: string; terms?: string[]; minB?: number | null; maxB?: number | null }): ListedModel[] {
  const words = /^all$/i.test(s.q.trim()) ? [] : s.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8).map(wordStart);
  const terms = (s.terms ?? []).map(t => wordStart(t.toLowerCase()));
  const minB = Number(s.minB) > 0 ? Number(s.minB) : null;
  const maxB = Number(s.maxB) > 0 ? Number(s.maxB) : null;
  return models.filter(([repo, , , params]) => {
    const name = repo.toLowerCase();
    if (!words.every(w => w.test(name))) return false;
    if (terms.length && !terms.some(t => t.test(name))) return false;
    return params == null || ((!minB || params >= minB * 0.95e9) && (!maxB || params <= maxB * 1.05e9));
  });
}

export interface ScanState { read: number; kept: number; startedAt: string }

const usable = (f: unknown): HfListFile | null => {
  const l = f as HfListFile | null;
  return l && Array.isArray(l.models) && typeof l.scannedAt === 'string' ? l : null;
};

export class HfList {
  private file: string;
  private shipped: string | null;
  private list: HfListFile | null | undefined;
  private job: (ScanState & { ac: AbortController }) | null = null;
  private error = '';

  /** `file`: this PC's own scan; `shipped`: the gzipped copy that comes with TOMLIN, read until there is one. */
  constructor(file: string, shipped: string | null = null) {
    this.file = file;
    this.shipped = shipped;
  }

  /** This PC's own scan; else the copy shipped with TOMLIN; else null. */
  async get(): Promise<HfListFile | null> {
    if (this.list === undefined) {
      // A file that is missing, cut short or not a list counts as none.
      this.list = await readFile(this.file, 'utf8').then(t => usable(JSON.parse(t))).catch(() => null);
      if (!this.list && this.shipped) this.list = await readFile(this.shipped).then(z => usable(JSON.parse(gunzipSync(z).toString('utf8')))).catch(() => null);
    }
    return this.list;
  }

  async status(): Promise<{ scannedAt: string | null; count: number; scanning: ScanState | null; error: string }> {
    const l = await this.get();
    const j = this.job;
    return { scannedAt: l?.scannedAt ?? null, count: l?.models.length ?? 0, scanning: j ? { read: j.read, kept: j.kept, startedAt: j.startedAt } : null, error: this.error };
  }

  /** Reads Hugging Face's whole list again in the background; the list from before stays until the new one is saved. */
  scan(fetchPage: typeof fetch = fetch): void {
    if (this.job) return;
    const job = { read: 0, kept: 0, startedAt: new Date().toISOString(), ac: new AbortController() };
    this.job = job;
    this.error = '';
    void (async () => {
      try {
        const seen = new Map<string, ListedModel>();
        let url: string | null = FIRST;
        for (let page = 0; url && page < 500; page++) {
          const r = await fetchPage(url, { signal: AbortSignal.any([job.ac.signal, AbortSignal.timeout(60_000)]) });
          if (!r.ok) throw new Error(`Hugging Face answered ${r.status} on page ${page + 1}`);
          const list = (await r.json()) as { downloads?: number }[];
          if (!Array.isArray(list) || !list.length) break;
          job.read += list.length;
          // Downloads change while the list is read, so a model can come twice: the first (higher) one stays.
          for (const m of listed(list)) if (!seen.has(m[0])) seen.set(m[0], m);
          job.kept = seen.size;
          if ((Number(list.at(-1)?.downloads) || 0) < FLOOR) break;
          url = nextPage(r.headers.get('link'));
        }
        const file: HfListFile = { scannedAt: new Date().toISOString(), floor: FLOOR, models: [...seen.values()].sort((a, b) => b[1] - a[1]) };
        await writeAtomic(this.file, JSON.stringify(file));
        this.list = file;
      } catch (e) {
        this.error = job.ac.signal.aborted
          ? 'Scan stopped. The list from before is kept.'
          : `The scan stopped: ${(e as Error).name === 'TimeoutError' ? 'Hugging Face took too long to answer' : (e as Error).message}. The list from before is kept; check the internet connection and scan again in a few minutes.`;
      } finally {
        this.job = null;
      }
    })();
  }

  stop(): void {
    this.job?.ac.abort();
  }
}
