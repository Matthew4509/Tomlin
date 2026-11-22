// Chat models from Hugging Face: search, sizes, the downloads list (one at a time, in order: src/dlqueue.ts); and models
// in another folder.
import { readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { totalmem } from 'node:os';
import { cursorPlaces, fetchChecked, hfUrl, lookUpHf, searchHf, usualModel, type HfLookup } from '../download.ts';
import { hasVisionFlags, isMoe, ordered, pick } from '../hflist.ts';
import { capsPass, cleanKinds } from '../capabilities.ts';
import { GB, HOME, type Routes, chatModels, hfList, json, modelsHome } from './core.ts';
import { SPARE, drives, freeOn, otherDriveHint } from '../modelhome.ts';
import { writeAtomic } from '../atomic.ts';
import { randomBytes } from 'node:crypto';
import * as DQ from '../dlqueue.ts';
import { jobsHere } from '../drivejobs.ts';
import { isNetworkPath, NETWORK_WHY } from '../workspace.ts';
import { cardFit, fitsRoom } from '../calc.ts';
import { cardMem, chatCards, fit, images, loadShapes } from './panes.ts';

// ---- Chat models from Hugging Face (a node chooses and downloads its own; nobody else can) ----

/** A look-up's fault in plain words (a time limit ran out, or Hugging Face's own message). */
const hfSaid = (error: unknown) => ((error as Error).name === 'TimeoutError' ? 'Hugging Face took too long to answer. Check the internet connection, then try again.' : (error as Error).message);

// ---- The downloads list (src/dlqueue.ts), kept in data/download-queue.json ----

const QFILE = join(HOME.data, 'download-queue.json');
let dlList: DQ.DlItem[] | null = null;
/** The one running now, with its Stop and why it was stopped. */
let dlRun: { id: string; ac: AbortController; why: 'stop' | 'cancel' | null } | null = null;
function dlNow(): DQ.DlItem[] {
  if (!dlList) {
    try {
      dlList = DQ.afterRestart(DQ.cleanList(JSON.parse(readFileSync(QFILE, 'utf8'))));
    } catch {
      dlList = [];
    }
  }
  return dlList;
}
function dlSet(list: DQ.DlItem[]): void {
  dlList = DQ.trimmed(list);
  void writeAtomic(QFILE, JSON.stringify(dlList, null, 2)).catch(e => console.error(`The downloads list was not saved: ${(e as Error).message}`));
}
const dlItem = (id: string) => dlNow().find(x => x.id === id);

/** A Get being looked up (before it is in the list). */
let hfStarting = false;
/** A chat model is downloading into the models folder now, or waits to (that folder is not changed meanwhile). */
export const hfBusy = () => hfStarting || dlNow().some(x => (x.state === 'running' || x.state === 'waiting') && x.to === 'models');
/**
 * The download the Models page follows, as it always had it: the one running into the models folder, else the last one
 * that ended there; with how many wait in the list.
 */
const hfView = () => {
  const mine = dlNow().filter(x => x.to === 'models');
  const j = mine.find(x => x.state === 'running') ?? DQ.shown(mine).find(x => x.state !== 'waiting' && x.state !== 'cancelled');
  const waiting = dlNow().filter(x => x.state === 'waiting').length;
  // The ones in line for the models folder: their Download buttons say Pending.
  const pending = mine.filter(x => x.state === 'waiting').map(x => ({ repo: x.repo, name: x.name }));
  if (!j) return waiting ? { repo: '', name: '', state: 'waiting', got: 0, bytes: 0, error: '', waiting, pending } : null;
  return { repo: j.repo, name: j.name, state: j.state === 'running' ? 'downloading' : j.state, got: j.got, bytes: j.bytes, error: j.error, waiting, pending };
};
/** This PC's downloads list, as the downloads window shows it. */
export const dlLines = () => DQ.shown(dlNow());

/**
 * Whether a model file this size could run on this PC at all (not "now": other programs and loaded models come and go):
 * RAM less 2 GB for Windows, plus the graphics cards' own memory less 1 GB each. Used to mark sizes in the Models list.
 */
function fitsPc(bytes: number): 'ok' | 'tight' | 'no' {
  return fitsRoom(bytes, totalmem(), chatCards().map(g => g.total ?? 0));
}

/** A repo's files, read from Hugging Face once per half hour (a search asks for up to 30 at a time). */
const hfLooked = new Map<string, { at: number; got: Promise<HfLookup> }>();
export function lookCached(repo: string): Promise<HfLookup> {
  const hit = hfLooked.get(repo);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.got;
  const got = lookUpHf(`https://huggingface.co/${repo}`);
  // One older than the half hour is never used again: it goes (each search kept up to 30 repos' file lists for good).
  for (const [k, v] of hfLooked) if (Date.now() - v.at >= 30 * 60_000) hfLooked.delete(k);
  hfLooked.set(repo, { at: Date.now(), got });
  got.catch(() => hfLooked.delete(repo));
  return got;
}

/** What the Models list shows for a repo before anything is pressed: each size with whether it fits, and the usual one. */
async function hfSizes(repo: string) {
  const l = await lookCached(repo);
  const cards = cardMem();
  const models = l.models.map(m => ({ name: m.name, bytes: m.bytes, have: m.files.every(f => chatModels.has(f.path)), fits: fitsPc(m.bytes), fit: fit(m.bytes, 'chat').level, card: cardFit(m.bytes, cards) }));
  const usual = usualModel(l.models);
  return { repo: l.repo, rev: l.rev, licence: l.licence, params: l.params, chat: l.chat, caps: l.caps, usual: usual?.name ?? null, models };
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

// ---- Where each downloaded chat model came from (data/model-sources.json), so the speed finder can find the same
// model's other files on Hugging Face (src/server/smaller.ts). Written when a download is whole. ----

export interface ModelSource { repo: string; rev: string; bytes: number; at: string }
const SOURCES = join(HOME.data, 'model-sources.json');
export async function modelSources(): Promise<Record<string, ModelSource>> {
  try {
    const j = JSON.parse(await readFile(SOURCES, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}
async function keepSource(name: string, s: ModelSource): Promise<void> {
  await writeAtomic(SOURCES, JSON.stringify({ ...(await modelSources()), [name]: s }, null, 2));
}

/** Where one of a download's files is written: the models folder, or the Model store folder on its drive. */
const dlTarget = (x: DQ.DlItem, path: string) => (x.to === 'store' ? join(`${x.drive}\\`, DQ.STORE_FOLDER, path) : chatModels.target(path));

/** Starts the next one waiting, when none runs; each one that ends starts the next. */
function dlPump(): void {
  const next = DQ.nextUp(dlNow());
  if (!next) return;
  const ac = new AbortController();
  const run = { id: next.id, ac, why: null as 'stop' | 'cancel' | null };
  dlRun = run;
  dlSet(dlNow().map(x => (x.id === next.id ? { ...x, state: 'running' as const, error: '' } : x)));
  void (async () => {
    const x = dlItem(next.id)!;
    let before = 0;
    let state: DQ.DlState = 'done';
    let error = '';
    try {
      for (const f of x.files) {
        await fetchChecked(hfUrl(x.repo, x.rev, f.path), dlTarget(x, f.path), f.bytes, f.sha256, pr => { x.got = before + pr.got; }, ac.signal);
        before += f.bytes;
        x.got = before;
      }
      if (x.to === 'models') {
        await keepSource(x.name, { repo: x.repo, rev: x.rev, bytes: x.bytes, at: new Date().toISOString() }).catch(e => console.error(`Where ${x.name} came from was not written down: ${(e as Error).message}`));
        chatModels.forget();
        void loadShapes().catch(() => undefined);
      }
    } catch (e) {
      state = ac.signal.aborted ? (run.why === 'cancel' ? 'cancelled' : 'stopped') : 'failed';
      error = ac.signal.aborted ? '' : (e as Error).message;
    }
    if (dlRun === run) dlRun = null;
    dlSet(dlNow().map(y => (y.id === x.id ? { ...y, state, error, got: x.got, ended: new Date().toISOString() } : y)));
    dlPump();
  })();
}

/** Carries on with the list at start: the one that was running when TOMLIN stopped starts again from its .part. */
export function resumeDownloads(): void {
  dlPump();
}

/** Cancel: one waiting is taken out of the list; the one running is stopped and taken out (the next one starts). */
export function cancelDl(id: string): boolean {
  const c = DQ.cancelled(dlNow(), id, new Date().toISOString());
  if (!c.found) return false;
  if (c.stopRunning && dlRun?.id === id) {
    dlRun.why = 'cancel';
    dlRun.ac.abort();
  } else dlSet(c.list);
  return true;
}
/** Download again: a stopped, failed or cancelled one goes back to the end of the line. */
export function againDl(id: string): void {
  dlSet(DQ.again(dlNow(), id));
  dlPump();
}
export function clearDl(): void {
  dlSet(DQ.cleared(dlNow()));
}

/**
 * Adds one chat model to this PC's downloads list (Download on the Models page, a linked main PC's Download to that PC,
 * or the Model store filled from the Network page). It starts at once when nothing else runs, else waits its turn.
 * Refused when it is in the list already, and when its drive has not got room for it and for the ones before it.
 */
export async function getHf(repo: string, rev: string, name: string, place: { to?: DQ.DlTo; drive?: string; by?: string } = {}): Promise<{ status: number; json: unknown }> {
  const to: DQ.DlTo = place.to === 'store' ? 'store' : 'models';
  const drive = to === 'store' ? String(place.drive ?? '').toUpperCase() : '';
  if (to === 'store' && !(jobsHere()[drive] ?? []).includes('store')) return { status: 400, json: { error: `Drive ${drive || '?'} is not part of Main model storage on this PC. Add it under Network Storage first.` } };
  const already = DQ.sameOpen(dlNow(), { repo, name, to, drive });
  if (already) return { status: 409, json: { error: `${name} is in the downloads list already (${DQ.dlWords(already)}).` } };
  // Taken before the look-up (a second or two): a second Get pressed meanwhile is told to wait, never added beside it.
  if (hfStarting) return { status: 409, json: { error: 'A download is being added. Wait a moment, then try again.' } };
  hfStarting = true;
  try {
    const found = await lookUpHf(`https://huggingface.co/${repo}/tree/${rev}`);
    const m = found.models.find(x => x.name === name);
    if (!m) return { status: 404, json: { error: 'That model is not at that link any more. Look the link up again.' } };
    // The folder models are kept in is on a drive that is not there now (a USB drive unplugged): said, not tried.
    const gone = to === 'models' ? modelsHome.missing() : '';
    if (gone) return { status: 400, json: { error: `Your models are kept in ${gone}, and that folder is not there now. Plug its drive in, or choose another folder (Models, Import models, Where models are kept), then try again.` } };
    const free = to === 'store' ? await freeOn(`${drive}\\`) : m.files.length ? await freeOn(dirname(chatModels.target(m.files[0].path))) : Infinity;
    const before = DQ.stillToCome(dlNow(), to, drive);
    // SPARE (2 GB) is left free on the drive after it, as every other writer keeps; the ones before it in line count.
    if (m.bytes + before + SPARE > free) {
      const ahead = before ? `, and the downloads before it in the list need ${(before / GB).toFixed(1)} GB of that` : '';
      return { status: 507, json: { error: `Not enough free disk space: ${m.name} needs ${(m.bytes / GB).toFixed(1)} GB, and ${to === 'store' ? `drive ${drive}` : 'the drive'} has ${(free / GB).toFixed(1)} GB free${ahead}. Free some space (or delete a model you no longer use), then try again.${to === 'models' ? otherDriveHint(m.bytes, chatModels.own, await drives().catch(() => [])) : ''}`, room: { name: m.name, bytes: m.bytes, free } } };
    }
    const item: DQ.DlItem = { id: `d${Date.now().toString(36)}${randomBytes(3).toString('hex')}`, repo: found.repo, rev: found.rev, name: m.name, bytes: m.bytes, files: m.files.map(f => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })), to, drive, state: 'waiting', got: 0, error: '', added: new Date().toISOString(), by: place.by || 'This PC' };
    dlSet([...dlNow(), item]);
    dlPump();
    return { status: 200, json: { ...hfView(), id: item.id, place: DQ.placeOf(dlNow(), item.id) } };
  } catch (error) {
    return { status: 400, json: { error: hfSaid(error) } };
  } finally {
    hfStarting = false;
  }
}

/**
 * A download asked for by a linked main PC (Download, To this PC, on its Models page): a chat model from Hugging Face
 * ({kind: 'chat', repo, rev, name}) or a picture model from TOMLIN's list ({kind: 'image', id}), downloaded here, by
 * this PC. /worker/fetch-start starts it, /worker/fetch-state says how far it is, /worker/fetch-stop stops it. No tick
 * is needed (since 2.0.56); the node's door refuses it while someone there is using that PC (src/jobrun/node.ts).
 */
export async function fetchHere(p: string, b: Record<string, unknown>, by = 'A linked PC'): Promise<{ status: number; json: Record<string, unknown> }> {
  // The downloads list, for the PC that shows every PC's list, with its Cancel, Download again and Clear.
  if (p === '/worker/dl-queue') return { status: 200, json: { lines: dlLines() } };
  if (p === '/worker/dl-cancel') return cancelDl(String(b.id ?? '')) ? { status: 200, json: { lines: dlLines() } } : { status: 404, json: { error: 'That download is not in the list there any more.' } };
  if (p === '/worker/dl-again') return againDl(String(b.id ?? '')), { status: 200, json: { lines: dlLines() } };
  if (p === '/worker/dl-clear') return clearDl(), { status: 200, json: { lines: dlLines() } };
  const image = b.kind === 'image';
  const id = String(b.id ?? '');
  const repo = String(b.repo ?? '');
  const name = String(b.name ?? '');
  const to: DQ.DlTo = b.to === 'store' ? 'store' : 'models';
  const drive = to === 'store' ? String(b.drive ?? '').toUpperCase() : '';
  /** This model's line to this place: the one not finished, else the newest. */
  const mine = () => {
    const all = DQ.shown(dlNow()).filter(x => x.repo === repo && x.name === name && x.to === to && x.drive === drive);
    return all.find(x => x.state === 'running' || x.state === 'waiting') ?? all[0];
  };
  const state = (): Record<string, unknown> => {
    if (image) {
      const m = images.registry.get(id);
      if (m && images.registry.installed(m)) return { state: 'done', got: images.registry.bytes(m), bytes: images.registry.bytes(m) };
      const dl = images.registry.download(id);
      if (!dl) return { state: 'none' };
      return { state: dl.error ? (/^Stopped\./.test(dl.error) ? 'stopped' : 'failed') : dl.done ? 'done' : 'downloading', got: dl.got, bytes: dl.bytes, error: dl.error ?? '' };
    }
    const x = mine();
    if (!x) return { state: 'none' };
    // Said as it always was ('downloading', and 'stopped' for one taken out), with 'waiting' for one in line.
    const st = x.state === 'running' ? 'downloading' : x.state === 'cancelled' ? 'stopped' : x.state;
    return { state: st, got: x.got, bytes: x.bytes, error: x.error, id: x.id, place: DQ.placeOf(dlNow(), x.id) };
  };
  if (p === '/worker/fetch-state') return { status: 200, json: state() };
  if (p === '/worker/fetch-stop') {
    if (image) images.registry.stop(id);
    else {
      const x = mine();
      if (x && (x.state === 'running' || x.state === 'waiting')) cancelDl(x.id);
    }
    return { status: 200, json: state() };
  }
  if (image) {
    try {
      await images.registry.start(id);
      return { status: 200, json: state() };
    } catch (error) {
      return { status: 400, json: { error: (error as Error).message } };
    }
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !name) return { status: 400, json: { error: 'that is not a Hugging Face model this PC can download.' } };
  const r = await getHf(repo, String(b.rev ?? 'main'), name, { to, drive, by });
  return { status: r.status, json: r.status === 200 ? state() : (r.json as Record<string, unknown>) };
}

// ---- Routes ----

/** GET requests answered here, by path. */
export const hfGet: Routes = {
  '/api/chatmodels/get': async ({ res }) => json(res, 200, hfView()),
  '/api/download-queue': async ({ res }) => json(res, 200, { lines: dlLines() }),
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
    // A network folder: models are run from it, and another PC could change them there.
    if (isNetworkPath(dir)) return json(res, 400, { error: `For the models, ${NETWORK_WHY}.` });
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
    // {q, terms, moe, caps, order, minB, maxB, minGB, maxGB, card, fitOn, cursor}: one page of GGUF chat models on Hugging Face matching the words
    // ("all": every one) and sizes, each with its file sizes read already (the list shows them before anything is
    // pressed). A repo with no model file TOMLIN can download (none at all, or behind a Hugging Face licence
    // page) is left out, and so is one that is not a chat model (no chat template and no chat task: video, music). Hugging Face is asked for up to 3 lots of 40 until 20 are kept, so the size filters do not
    // leave a page nearly empty; `next` is the cursor for the page after (null on the last).
    // With no list on this PC yet, Hugging Face's own search answers, and it takes one search at a time: ticked terms
    // (abliterated, uncensored) are either-or, so each term is its own search with the words, a share of each lot
    // from each, merged most downloaded first; the cursor is one place per search (false once that one has no more).
    const num = (v: unknown) => (Number(v) > 0 ? Number(v) : null);
    const minB = num(b.minB), maxB = num(b.maxB), minGB = num(b.minGB), maxGB = num(b.maxGB);
    const inGB = (bytes: number) => (!minGB || bytes >= minGB * GB) && (!maxGB || bytes <= maxGB * GB);
    // Fits my card ticked: only a size that sits wholly on this PC's graphics cards (an estimate, src/calc.ts cardFit).
    const card = b.card === true;
    // Fits (a drop-down on the page): 'here' = fits this PC; {ram, vram} = fits a linked PC with that memory (its last
    // report, which the page has); anything else = all sizes.
    const on = b.fitOn as { ram?: unknown; vram?: unknown } | string | undefined;
    const there = on && typeof on === 'object' && Number(on.ram) > 0 ? { ram: Number(on.ram), cards: Number(on.vram) > 0 ? [Number(on.vram)] : [] } : null;
    const fitsOn = (m: { bytes: number; fits: string }) => (on === 'here' ? m.fits !== 'no' : there ? fitsRoom(m.bytes, there.ram, there.cards) !== 'no' : true);
    const sizeOk = (m: { bytes: number; card: string | null; fits: string }) => inGB(m.bytes) && (!card || m.card === 'ok') && fitsOn(m);
    const q = String(b.q ?? '');
    const terms = [...new Set((Array.isArray(b.terms) ? b.terms : []).map(String))].filter(t => t === 'abliterated' || t === 'uncensored');
    // Mixture-of-experts ticked: mixtures of experts only (by name). Order: Size or A to Z on the page (most downloaded when not set).
    const moe = b.moe === true;
    // Reads pictures / Uses tools / General ticked: a repo passes when it is any one of them (read from its task, files and chat template).
    const kinds = cleanKinds(b.caps);
    const order = ['size-asc', 'size-desc', 'name-asc', 'name-desc'].includes(String(b.order)) ? String(b.order) : '';
    const list = await hfList.get();
    if (list) {
      // The file list (shipped, or this PC's own rescan): every match is known at once, so ticked terms are simply either-or.
      // Each page reads the sizes of the next matches until 20 fit (at most 60 read); `next` is where the next page
      // starts in the matches, `total` how many matched the words, ticks and the size in the name.
      // Only pictures ticked, and the list carries the pictures flag: the list itself narrows to them, so a page is not read from 60 other repos to find a few.
      const picked = ordered(pick(list.models, { q, terms, moe, minB, maxB, vision: kinds.length === 1 && kinds[0] === 'images' && hasVisionFlags(list.models) }), order);
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
        for (const x of kept) if (x && x !== 'limited' && x.chat && inB(x.params) && x.models.some(sizeOk) && capsPass(x.caps, kinds)) found.push(x);
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
        const fits = got.flatMap(lot => lot?.found ?? []).filter(x => !seen.has(x.repo) && seen.add(x.repo) && !x.gated && (!moe || isMoe(x.repo)) && capsPass(x.caps, kinds) && (!x.params || ((!minB || x.params >= minB * 0.95e9) && (!maxB || x.params <= maxB * 1.05e9))));
        const sized = await inTurns(fits, 6, async x => {
          try {
            return { ...x, ...(await hfSizes(x.repo)) };
          } catch {
            return null;
          }
        });
        for (const x of sized) if (x && x.chat && x.models.some(sizeOk) && capsPass(x.caps, kinds)) found.push(x);
      } while (at.some(c => c !== false) && found.length < 20 && lots < 3);
      // Hugging Face's own search answers most downloaded first: Size and A to Z order each page as it comes.
      found.sort((x, y) => y.downloads - x.downloads);
      return json(res, 200, { found, next: at.some(c => c !== false) ? at : null, pageOrder: !!order });
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
    const r = await getHf(String(b.repo ?? ''), String(b.rev ?? ''), String(b.name ?? ''));
    return json(res, r.status, r.json);
  },
  '/api/chatmodels/stop': async ({ res }) => {
    // Stop on the Models page: the one running into the models folder stops (Download again carries on); the next starts.
    const x = dlNow().find(y => y.state === 'running' && y.to === 'models');
    if (x && dlRun?.id === x.id) {
      dlRun.why = 'stop';
      dlRun.ac.abort();
    }
    return json(res, 200, hfView());
  },
  '/api/download-queue/cancel': async ({ res, b }) => (cancelDl(String(b.id ?? '')) ? json(res, 200, { lines: dlLines() }) : json(res, 404, { error: 'That download is not in the list any more.' })),
  '/api/download-queue/again': async ({ res, b }) => (againDl(String(b.id ?? '')), json(res, 200, { lines: dlLines() })),
  '/api/download-queue/clear': async ({ res }) => (clearDl(), json(res, 200, { lines: dlLines() })),
};
