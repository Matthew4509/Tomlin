// Chat models from Hugging Face: search, sizes, one download at a time; and models in another folder.
import { statSync } from 'node:fs';
import { totalmem } from 'node:os';
import { cursorPlaces, fetchChecked, hfUrl, lookUpHf, searchHf, usualModel, type HfLookup } from '../download.ts';
import { pick } from '../hflist.ts';
import { GB, type Routes, chatModels, hfList, json } from './core.ts';
import { chatCards, fit, loadShapes } from './panes.ts';

// ---- Chat models from Hugging Face (a node chooses and downloads its own; nobody else can) ----

let hfJob: { repo: string; name: string; state: 'downloading' | 'done' | 'failed' | 'stopped'; got: number; bytes: number; error: string; ac: AbortController } | null = null;
/** A look-up's fault in plain words (a time limit ran out, or Hugging Face's own message). */
const hfSaid = (error: unknown) => ((error as Error).name === 'TimeoutError' ? 'Hugging Face took too long to answer. Check the internet connection, then try again.' : (error as Error).message);

/** A Get being looked up (before hfJob exists). */
let hfStarting = false;
const hfView = () => (hfJob ? { repo: hfJob.repo, name: hfJob.name, state: hfJob.state, got: hfJob.got, bytes: hfJob.bytes, error: hfJob.error } : null);

/**
 * Whether a model file this size could run on this PC at all (not "now": other programs and loaded models come and go):
 * RAM less 2 GB for Windows, plus the graphics cards' own memory less 1 GB each. Used to mark sizes in the Models list.
 */
function fitsPc(bytes: number): 'ok' | 'tight' | 'no' {
  const card = chatCards().reduce((n, g) => n + Math.max(0, (g.total ?? 0) - GB), 0);
  const room = Math.max(0, totalmem() - 2 * GB) + card;
  const need = bytes * 1.1 + 0.8 * GB;
  return need <= room * 0.85 ? 'ok' : need <= room ? 'tight' : 'no';
}

/** A repo's files, read from Hugging Face once per half hour (a search asks for up to 30 at a time). */
const hfLooked = new Map<string, { at: number; got: Promise<HfLookup> }>();
function lookCached(repo: string): Promise<HfLookup> {
  const hit = hfLooked.get(repo);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.got;
  const got = lookUpHf(`https://huggingface.co/${repo}`);
  hfLooked.set(repo, { at: Date.now(), got });
  got.catch(() => hfLooked.delete(repo));
  return got;
}

/** What the Models list shows for a repo before anything is pressed: each size with whether it fits, and the usual one. */
async function hfSizes(repo: string) {
  const l = await lookCached(repo);
  const models = l.models.map(m => ({ name: m.name, bytes: m.bytes, have: m.files.every(f => chatModels.has(f.path)), fits: fitsPc(m.bytes), fit: fit(m.bytes, 'chat').level }));
  const usual = usualModel(l.models);
  return { repo: l.repo, rev: l.rev, licence: l.licence, params: l.params, usual: usual?.name ?? null, models };
}

/** Runs `f` over `items`, at most `n` at a time. */
async function inTurns<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  }));
  return out;
}

function startHf(repo: string, rev: string, m: { name: string; bytes: number; files: { path: string; bytes: number; sha256: string }[] }): void {
  const job = { repo, name: m.name, state: 'downloading' as const, got: 0, bytes: m.bytes, error: '', ac: new AbortController() };
  hfJob = job;
  void (async () => {
    let before = 0;
    try {
      for (const f of m.files) {
        await fetchChecked(hfUrl(repo, rev, f.path), chatModels.target(f.path), f.bytes, f.sha256, pr => { job.got = before + pr.got; }, job.ac.signal);
        before += f.bytes;
        job.got = before;
      }
      (job as { state: string }).state = 'done';
      chatModels.forget();
      void loadShapes().catch(() => undefined);
    } catch (error) {
      (job as { state: string }).state = job.ac.signal.aborted ? 'stopped' : 'failed';
      job.error = job.ac.signal.aborted ? '' : (error as Error).message;
    }
  })();
}

// ---- Routes ----

/** GET requests answered here, by path. */
export const hfGet: Routes = {
  '/api/chatmodels/get': async ({ res }) => json(res, 200, hfView()),
  '/api/hflist': async ({ res }) => json(res, 200, await hfList.status()),
};

/** POST requests answered here, by path (the body is read already). */
export const hfPost: Routes = {
  '/api/models/folder': async ({ res, b }) => {
    // {dir}: use the models in that folder where they are (chat models, and picture-model files by name and size);
    // {dir: null} stops. Nothing is copied or moved.
    if (b.dir === null || b.dir === '') {
      chatModels.setOther(null);
      return json(res, 200, { folder: null });
    }
    const dir = String(b.dir).trim().replace(/^"|"$/g, '');
    // A whole drive (D:\) would be walked file by file on every listing: a folder on it is asked for instead.
    if (/^[a-z]:[\\/]?$/i.test(dir) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?$/.test(dir)) return json(res, 400, { error: `${dir} is a whole drive. Pick the folder on it that holds the models (for example D:\\Models), then try again.` });
    try {
      if (!statSync(dir).isDirectory()) throw new Error('not a folder');
    } catch {
      return json(res, 400, { error: `There is no folder at ${dir}. Copy its path from File Explorer's address bar, then try again.` });
    }
    chatModels.setOther(dir);
    return json(res, 200, { folder: chatModels.other(), chat: chatModels.list().filter(m => m.where === 'other').length });
  },
  '/api/hflist/scan': async ({ res }) => {
    hfList.scan();
    return json(res, 200, await hfList.status());
  },
  '/api/hflist/stop': async ({ res }) => {
    hfList.stop();
    return json(res, 200, await hfList.status());
  },
  '/api/chatmodels/search': async ({ res, b }) => {
    // {q, terms, minB, maxB, minGB, maxGB, cursor}: one page of GGUF chat models on Hugging Face matching the words
    // ("all": every one) and sizes, each with its file sizes read already (the list shows them before anything is
    // pressed). A repo with no model file TOMLIN can download (none at all, or behind a Hugging Face licence
    // page) is left out. Hugging Face is asked for up to 3 lots of 40 until 20 are kept, so the size filters do not
    // leave a page nearly empty; `next` is the cursor for the page after (null on the last).
    // With no list on this PC yet, Hugging Face's own search answers, and it takes one search at a time: ticked terms
    // (abliterated, uncensored) are either-or, so each term is its own search with the words, a share of each lot
    // from each, merged most downloaded first; the cursor is one place per search (false once that one has no more).
    const num = (v: unknown) => (Number(v) > 0 ? Number(v) : null);
    const minB = num(b.minB), maxB = num(b.maxB), minGB = num(b.minGB), maxGB = num(b.maxGB);
    const inGB = (bytes: number) => (!minGB || bytes >= minGB * GB) && (!maxGB || bytes <= maxGB * GB);
    const q = String(b.q ?? '');
    const terms = [...new Set((Array.isArray(b.terms) ? b.terms : []).map(String))].filter(t => t === 'abliterated' || t === 'uncensored');
    const list = await hfList.get();
    if (list) {
      // The file list (shipped, or this PC's own rescan): every match is known at once, so ticked terms are simply either-or.
      // Each page reads the sizes of the next matches until 20 fit (at most 60 read); `next` is where the next page
      // starts in the matches, `total` how many matched the words, ticks and the size in the name.
      const picked = pick(list.models, { q, terms, minB, maxB });
      const inB = (n: number | null) => n == null || ((!minB || n >= minB * 0.95e9) && (!maxB || n <= maxB * 1.05e9));
      // Hugging Face turning this PC away for asking too often (429) ends the page at that model, so Next starts there
      // and nothing is skipped without a word.
      let at = Number.isInteger(b.cursor) && Number(b.cursor) >= 0 ? Number(b.cursor) : 0;
      const found: object[] = [];
      let limited = false;
      for (let read = 0; at < picked.length && found.length < 20 && read < 60 && !limited; ) {
        const lot = picked.slice(at, at + Math.max(6, 20 - found.length));
        const sized = await inTurns(lot, 6, async ([repo, downloads, likes, params]) => {
          try {
            const s = await hfSizes(repo);
            return { ...s, repo, downloads, likes, gated: false, params: s.params ?? params };
          } catch (error) {
            return /\b429\b/.test((error as Error).message) ? 'limited' : null;
          }
        });
        const stop = sized.indexOf('limited');
        limited = stop >= 0;
        const kept = limited ? sized.slice(0, stop) : sized;
        for (const x of kept) if (x && x !== 'limited' && inB(x.params) && x.models.some(m => inGB(m.bytes))) found.push(x);
        at += kept.length;
        read += kept.length;
      }
      const note = limited ? 'Hugging Face is turning this PC away for asking too often just now (429), so this page stops here. Wait a minute, then press Next to carry on from here.' : '';
      return json(res, 200, { found, next: at < picked.length ? at : null, total: picked.length, listAt: list.scannedAt, note });
    }
    // No list on this PC yet: Hugging Face's own search, live.
    const searches = terms.length ? terms.map(t => `${/^all$/i.test(q.trim()) ? '' : q} ${t}`.trim()) : [q];
    let at = cursorPlaces(b.cursor, searches.length);
    try {
      const found: { repo: string; downloads: number }[] = [];
      const seen = new Set<string>();
      let lots = 0;
      do {
        const got = await Promise.all(searches.map((words, i) => (at[i] === false ? null : searchHf(words, { minB, maxB }, at[i] || null, Math.ceil(40 / searches.length)))));
        at = got.map(lot => lot?.next ?? false);
        lots++;
        const fits = got.flatMap(lot => lot?.found ?? []).filter(x => !seen.has(x.repo) && seen.add(x.repo) && !x.gated && (!x.params || ((!minB || x.params >= minB * 0.95e9) && (!maxB || x.params <= maxB * 1.05e9))));
        const sized = await inTurns(fits, 6, async x => {
          try {
            return { ...x, ...(await hfSizes(x.repo)) };
          } catch {
            return null;
          }
        });
        for (const x of sized) if (x && x.models.some(m => inGB(m.bytes))) found.push(x);
      } while (at.some(c => c !== false) && found.length < 20 && lots < 3);
      found.sort((x, y) => y.downloads - x.downloads);
      return json(res, 200, { found, next: at.some(c => c !== false) ? at : null });
    } catch (error) {
      return json(res, 502, { error: (error as Error).name === 'TimeoutError' ? 'Hugging Face took too long to answer. Check the internet connection, then search again.' : (error as Error).message });
    }
  },
  '/api/chatmodels/sizes': async ({ res, b }) => {
    // {repos}: the sizes of a few repos (the suggested list), read once per half hour.
    const repos = (Array.isArray(b.repos) ? b.repos : []).map(String).filter(r => /^[\w.-]+\/[\w.-]+$/.test(r)).slice(0, 20);
    const got = await inTurns(repos, 6, async repo => {
      try {
        return await hfSizes(repo);
      } catch (error) {
        return { repo, error: (error as Error).message };
      }
    });
    return json(res, 200, { sizes: got });
  },
  '/api/chatmodels/look': async ({ res, b }) => {
    try {
      const found = await lookUpHf(String(b.link ?? ''));
      return json(res, 200, { ...found, models: found.models.map(m => ({ ...m, have: m.files.every(f => chatModels.has(f.path)), fit: fit(m.bytes, 'chat').level })) });
    } catch (error) {
      return json(res, 400, { error: hfSaid(error) });
    }
  },
  '/api/chatmodels/get': async ({ res, b }) => {
    // {repo, rev, name}: downloads one model's files from that fixed revision, each checked against Hugging Face's SHA-256.
    if (hfJob?.state === 'downloading') return json(res, 409, { error: `${hfJob.name} is still downloading. Wait for it, or stop it.` });
    // Taken before the look-up (a second or two): a second Get pressed meanwhile is told to wait, never started beside it.
    if (hfStarting) return json(res, 409, { error: 'A download is starting. Wait a moment, then try again.' });
    hfStarting = true;
    try {
      const found = await lookUpHf(`https://huggingface.co/${String(b.repo ?? '')}/tree/${String(b.rev ?? '')}`);
      const m = found.models.find(x => x.name === b.name);
      if (!m) return json(res, 404, { error: 'That model is not at that link any more. Look the link up again.' });
      startHf(found.repo, found.rev, m);
      return json(res, 200, hfView());
    } catch (error) {
      return json(res, 400, { error: hfSaid(error) });
    } finally {
      hfStarting = false;
    }
  },
  '/api/chatmodels/stop': async ({ res }) => {
    hfJob?.ac.abort();
    return json(res, 200, hfView());
  },
};
