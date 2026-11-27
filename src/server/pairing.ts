// Which pictures make good starts for video (src/pairing.ts): each clip made from a start picture is noted in
// data/pairing.json (written whole, never half) with the facts that picture gives, looked up here: a gallery picture
// (found by its file, or by a project's copy of it) says its model and, when it says one, its style; a style sample says
// both; any other picture (a file, a clip's frame) says nothing, so its facts stay not known. Keep this one in a shot
// list and deleting a clip are noted too. Never a fault for the clip: a note that cannot be written is only logged.
import { join, relative, resolve } from 'node:path';
import { readData, setAside, updateData } from '../atomic.ts';
import type { ClipRecord, Picture } from '../gallery.ts';
import * as pairing from '../pairing.ts';
import { pickedStyle, isModelKey } from '../styles.ts';
import { shortVideoName, videoModel } from '../videomodels.ts';
import * as ws from '../workspace.ts';
import { HOME, type Routes, json, workspaceDir } from './core.ts';
import { images } from './panes.ts';

const FILE = join(HOME.data, 'pairing.json');
const SAMPLES = join(HOME.data, 'stylesamples');

const same = (a: string) => resolve(a).toLowerCase();

/** A video model's name from its id (the id itself for one not in the list). */
export const videoName = (id: string): string => {
  const m = videoModel(id);
  return m ? shortVideoName(m) : id;
};

/** The gallery picture whose file (or one of its projects' copies) is `file`, or undefined. */
async function pictureAt(file: string): Promise<Picture | undefined> {
  const want = same(file);
  const all = (await images.gallery.all()).filter(p => !p.removed && !p.private);
  const here = all.find(p => [p.output, p.original].some(rel => rel && same(join(images.gallery.dir, rel)) === want));
  if (here) return here;
  const root = await workspaceDir().catch(() => '');
  if (!root) return undefined;
  return all.findLast(p => p.savedTo?.some(s => same(join(root, ...s.path.split('/'))) === want));
}

/** What a start picture at `file` says about how it was drawn. */
export async function startFactsOf(file: string | undefined): Promise<pairing.StartFacts> {
  if (!file) return pairing.unknownFacts(null);
  const p = await pictureAt(file);
  if (p) return pairing.factsOfPicture(p);
  // A style sample: data/stylesamples/<model id>/<style id>.png (or .webp).
  const rel = relative(SAMPLES, resolve(file)).split(/[\\/]/);
  if (rel.length === 2 && rel[0] !== '..') {
    const [model, name] = rel;
    const style = pickedStyle(name.replace(/\.(png|webp)$/i, ''));
    if (isModelKey(model) && style) return pairing.factsOfSample(model, style.id);
  }
  return pairing.unknownFacts(`file:${same(file)}`);
}

/** A file another program holds (a virus scanner, OneDrive, a backup) is waited for this long before a note is given up. */
export const HELD_WAIT_MS = 120_000;
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
let notesTurn: Promise<unknown> = Promise.resolve();

/**
 * Runs `job` after every note asked for before (so a Keep pressed just after a clip is made finds that clip's note),
 * and tries it again while pairing.json is held by another program, for up to HELD_WAIT_MS.
 */
function inNotesTurn(job: () => Promise<void>): Promise<void> {
  const run = notesTurn.then(async () => {
    const until = Date.now() + HELD_WAIT_MS;
    for (;;) {
      try {
        return await job();
      } catch (e) {
        if (!BUSY.has((e as NodeJS.ErrnoException).code ?? '') || Date.now() >= until) throw e;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  });
  notesTurn = run.catch(() => undefined);
  return run;
}

/**
 * One change to the notes, in pairing.json's turn: nothing is written when `change` gives null. A file that is JSON but
 * not the shape this TOMLIN reads (from another version, or edited by hand) is set aside first, never written over.
 */
const changeNotes = (change: (f: pairing.PairingFile) => pairing.PairingFile | null): Promise<unknown> =>
  updateData<unknown>(FILE, pairing.emptyPairing(), async now => {
    const next = change(pairing.cleanPairing(now));
    if (!next) return undefined;
    if (!pairing.isPairingShape(now)) await setAside(FILE);
    return next;
  });

/** A clip made: noted with its start picture's facts (a clip with no start picture is not noted). */
export function noteClip(clip: ClipRecord): Promise<void> {
  const path = clip.start?.path;
  if (!path) return Promise.resolve();
  return inNotesTurn(async () => {
    const facts = await startFactsOf(path);
    await changeNotes(f => pairing.withClip(f, facts, clip));
  });
}

/** Keep this one in a shot list: that take kept, the shot's other takes not. */
export function noteKept(kept: string, takes: string[]): Promise<void> {
  return inNotesTurn(async () => void (await changeNotes(f => pairing.withKept(f, kept, takes))));
}

/** Clips deleted from the Videos shelf. */
export function noteDeleted(ids: string[]): Promise<void> {
  if (!ids.length) return Promise.resolve();
  return inNotesTurn(async () => void (await changeNotes(f => pairing.withDeleted(f, ids, new Date()))));
}

/** Every note counted now. */
export async function seenNow(): Promise<pairing.SeenRow[]> {
  return pairing.seenRows(pairing.cleanPairing(await readData<unknown>(FILE, pairing.emptyPairing())), Date.now());
}

/** Each style's tile line for the picture model `key` / `name`. */
export function styleFits(key: string, name: string, rows: pairing.SeenRow[]): Record<string, pairing.FitView> {
  return Object.fromEntries(Object.keys(pairing.EXPECTED).map(id => [id, pairing.styleFit(id, key, name, rows, videoName)]));
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const listOf = (v: unknown) => (Array.isArray(v) ? v.slice(0, 60) : []).map(x => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {}));

export const pairingGet: Routes = {
  // ?gallery=<picture id or file> or ?project=<workspace path>: the start picture's style and the warning for it ('' when none).
  '/api/pairing/start': async ({ res, url }) => {
    const g = url.searchParams.get('gallery');
    const pr = url.searchParams.get('project');
    let facts = pairing.unknownFacts(null);
    if (g) {
      const p = (await images.gallery.all()).find(x => !x.removed && !x.private && (x.id === g.slice(0, 200) || x.output === g.slice(0, 200)));
      if (p) facts = pairing.factsOfPicture(p);
    } else if (pr) {
      const file = await ws.inside(await workspaceDir(), pr.slice(0, 400), false).catch(() => null);
      if (file) facts = await startFactsOf(file);
    }
    const s = pickedStyle(facts.style);
    return json(res, 200, { style: s?.id ?? null, styleName: s?.name ?? null, fit: s ? pairing.expectedOf(s.id).fit : null, warning: pairing.driftWarning(s?.id) });
  },
};

export const pairingPost: Routes = {
  // {pictures: [{key, name}], videos: [{id, name}]}: each picture model's line per video model, and each video model's line.
  '/api/pairing/lines': async ({ res, b }) => {
    const rows = await seenNow();
    const videos = listOf(b.videos).map(v => ({ id: str(v.id, 80), name: str(v.name, 120) || videoName(str(v.id, 80)) })).filter(v => v.id);
    const pictures = listOf(b.pictures).map(p => ({ key: str(p.key, 120), name: str(p.name, 120) })).filter(p => p.key || p.name);
    return json(res, 200, {
      pictures: Object.fromEntries(pictures.map(p => [p.key || p.name, videos.map(v => ({ video: v.id, ...pairing.pictureLine({ key: p.key, name: p.name || p.key }, v, rows) }))])),
      videos: Object.fromEntries(videos.map(v => [v.id, pairing.videoLine(v, rows)])),
    });
  },
};
