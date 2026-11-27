// A Videographer's chat: make a clip from the words typed, follow it, stop it, and the Videos shelf (src/clips.ts,
// src/gallery.ts ClipShelf). The engine here is set with setVideoRunner (src/server.ts); a hire on a linked PC uses RemoteVideoRunner; TOMLIN_FAKE_VIDEO=1 (a dev switch, never set by the
// app) uses the pretend runner in test/fakeclip.ts so the flow can be seen without a graphics card.
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, extname, join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Clips, CLIP_QUALITIES, CLIP_SIZES, SEED_MAX, START_SENT_MAX, STEPS_MAX, againAsk, cleanAsk, clipAbout, isJoined, isVideographer, lowDiskLine, picturesIn, progressLine, sizeRefused, startFromPage, type StartPlan } from '../clips.ts';
import * as folders from '../folders.ts';
import * as ws from '../workspace.ts';
import { images } from './panes.ts';
import { projectFolder } from './places.ts';
import { fitTo } from '../imaging.ts';
import { takesStartPicture, wordsOnlyLine } from '../videomodels.ts';
import { ClipShelf, type ClipRecord } from '../gallery.ts';
import { freeOn } from '../lowdisk.ts';
import { namedChat } from '../chats.ts';
import { MAX_CLIP_SECONDS, MAX_START_BYTES, type VideoRunner } from '../videotypes.ts';
import { RemoteVideoRunner, videoWireFor } from '../videolink.ts';
import { HOME, SECURITY_HEADERS, type Routes, chats, decoded, json, staff, store, workspaceDir } from './core.ts';
import { cardsOf, expandForChat, withAvoid } from './cards.ts';
import { chatPersonHere, chatToSend, clipModelOf, sendTarget } from './people.ts';
import { noteClip, noteDeleted } from './pairing.ts';

let runnerNow: VideoRunner | null = null;
/** The engine clips on this PC are made with (src/video.ts once it is in), or null for none. */
export function setVideoRunner(r: VideoRunner | null): void {
  runnerNow = r;
}

const fake = process.env.TOMLIN_FAKE_VIDEO;
if (fake) {
  // Only a source copy has test/: a built copy finds nothing and stays as it is.
  void import('../../test/fakeclip.ts').then(m => {
    runnerNow ??= m.devRunner(fake);
    console.log(`Clips use the pretend video runner (TOMLIN_FAKE_VIDEO=${fake}).`);
  }, () => undefined);
}

export const clipShelf = new ClipShelf(join(HOME.data, 'videos'));

// A gallery picture a clip on the shelf started from leaves the gallery when it is deleted, but its file stays: the
// clip's Started from and Make again use it (the clip keeps no copy of its own: src/clips.ts keepStart).
images.gallery.needed = async file => {
  const want = resolve(file).toLowerCase();
  return (await clipShelf.all()).some(c => !c.removed && !!c.start?.path && resolve(c.start.path).toLowerCase() === want);
};
/** A linked PC's clips: made there and fetched into the shelf's folder; null when that PC is no longer linked. */
function linkedRunner(pc: string, hire?: { id: string; first: string }): VideoRunner | null {
  const r = store.peek()?.remotes.find(x => x.id === pc);
  return r ? new RemoteVideoRunner({ pc: r.name, wire: videoWireFor(r), dir: clipShelf.dir, ...(hire ? { hire } : {}) }) : null;
}

/** Set by src/server.ts: a finished clip asked in a project's chat is copied into that project (src/server/places.ts). */
export const clipHooks: { made: ((clip: ClipRecord, file: string) => Promise<void>) | null } = { made: null };

/** A project picture the picker may offer and the clip may start from. */
/** A project picture a clip may start from (an Artist's, a character's or a location's): PNG or WebP, as the page shows them. */
const PROJECT_PICTURE = /\.(png|webp)$/i;
const NOT_HERE = 'That start picture is not on this PC any more. Pick it again.';

/**
 * The start picture as the page chose it: `start` (a PNG data URL: a file, a clip's frame), or `startFrom` naming one
 * already on this PC ({gallery: <picture id or file>}, {project: <workspace path>} or {clip: <clip id>}, Make again). Its bytes, its file ('' for a new one)
 * and words for its name; null when none was chosen.
 */
export async function startChosen(b: Record<string, unknown>): Promise<{ png: Buffer; file: string; name: string } | { error: string } | null> {
  const name = typeof b.startName === 'string' ? b.startName.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const sent = startFromPage(b.start);
  if (sent && 'error' in sent) return sent;
  if (sent) return { png: sent, file: '', name: name || 'start frame' };
  const from = b.startFrom && typeof b.startFrom === 'object' ? (b.startFrom as Record<string, unknown>) : null;
  if (!from) return null;
  let file: string | null = null;
  let words = name;
  if (typeof from.gallery === 'string') {
    // By its id (the viewer, the picker) or its file (a picture shown in a chat).
    const key = from.gallery.slice(0, 200);
    const p = (await images.gallery.all()).find(x => x.id === key || x.output === key);
    file = p && !p.removed ? await images.gallery.file(p.output) : null;
    words ||= p?.prompt ?? '';
  } else if (typeof from.clip === 'string') {
    // Make again: the picture that clip started from, wherever it is kept.
    const c = await clipShelf.get(from.clip.slice(0, 40));
    file = c && !c.removed ? c.start?.path ?? null : null;
    words ||= file ? basename(file).replace(/\.[a-z]+$/i, '') : '';
  } else if (typeof from.project === 'string' && PROJECT_PICTURE.test(from.project)) {
    file = await ws.inside(await workspaceDir(), from.project, false);
    words ||= basename(from.project).replace(PROJECT_PICTURE, '');
  }
  const size = file ? await stat(file).then(s => (s.isFile() ? s.size : -1), () => -1) : -1;
  if (!file || size < 0) return { error: NOT_HERE };
  if (size > START_SENT_MAX) return { error: `The start picture is too large (over ${START_SENT_MAX / 2 ** 20} MB). Pick a smaller one.` };
  const png = await readFile(file).catch(() => null);
  return png ? { png, file, name: words } : { error: NOT_HERE };
}

export const clips = new Clips({
  runner: (pc, hire) => (pc === 'here' ? runnerNow : linkedRunner(pc, hire)),
  shelf: clipShelf,
  free: freeOn,
  saveLine: async (chat, line) => void (await store.changeChat(chats.file(chat), lines => [...lines, line])),
  made: async (clip, file) => {
    // Which picture it started from, for which pictures make good starts (src/pairing.ts): never a fault for the clip.
    await noteClip(clip).catch(e => console.warn(`A clip could not be noted for its start picture: ${(e as Error).message}`));
    await clipHooks.made?.(clip, file);
  },
});

const roomLine = async () => lowDiskLine(await freeOn(clipShelf.dir).then(f => f ?? freeOn(HOME.data)));

const viewOut = (v: ReturnType<Clips['view']>) => (v ? { ...v, line: progressLine(v) } : null);

export const clipsGet: Routes = {
  // What a clip can be: lengths, sizes (`hd`: only for a hire whose model is made for 720p) and qualities, and the low-disk line.
  '/api/clips/options': async ({ res }) => json(res, 200, { maxSeconds: MAX_CLIP_SECONDS, sizes: CLIP_SIZES, qualities: CLIP_QUALITIES, maxSteps: STEPS_MAX, maxSeed: SEED_MAX, lowDisk: await roomLine() }),
  // ?id=<clip>: one clip on the shelf, with how it was made (the clip viewer).
  '/api/clips/one': async ({ res, url }) => {
    const c = await clipShelf.get(String(url.searchParams.get('id') ?? '').slice(0, 40));
    return c ? json(res, 200, { clip: c, ...clipAbout(c) }) : json(res, 404, { error: 'That clip is not on the shelf any more.' });
  },
  // ?id=<clip>: that clip; ?chat=<id>: the newest clip asked in that chat.
  '/api/clips/job': ({ res, url }) => {
    const id = url.searchParams.get('id');
    const chat = url.searchParams.get('chat');
    return json(res, 200, { job: viewOut(id ? clips.view(id.slice(0, 40)) : chat ? clips.forChat(chat.slice(0, 80)) : null) });
  },
  // ?chat=<id>: the pictures that chat's project's Artists handed in (specialists\images), newest first, and its
  // characters' and locations' pictures (specialists\characters\<Name>, locations\<Name>); none outside a project.
  '/api/clips/project-pictures': async ({ res, url }) => {
    const c = await chats.get((url.searchParams.get('chat') ?? '').slice(0, 80)).catch(() => null);
    const folder = await projectFolder(c?.project);
    if (folder === null) return json(res, 200, { project: null, pictures: [], cards: [] });
    const rel = folders.projectImages(folder);
    const pictures = await picturesIn(join(await workspaceDir(), ...rel.split('/')), rel);
    // A project at the top of the workspace has no folder for cards (src/server/cards.ts folderFor).
    const cards = folder ? (await cardsOf(folder).catch(() => [])).map(k => ({ kind: k.kind, name: k.name, pictures: k.pictures.filter(p => PROJECT_PICTURE.test(p)).reverse() })) : [];
    return json(res, 200, { project: folder || 'the workspace', folder: rel, pictures, cards });
  },
  // ?id=<clip>: the picture that clip started from (Started from), wherever it is kept.
  '/api/clips/start': async ({ res, url }) => {
    const c = await clipShelf.get((url.searchParams.get('id') ?? '').slice(0, 40));
    const path = c && !c.removed ? c.start?.path : undefined;
    const type = ({ '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' } as Record<string, string>)[extname(path ?? '').toLowerCase()];
    const data = path && type ? await readFile(path).catch(() => null) : null;
    if (!data) return json(res, 404, { error: 'The start picture is not on this PC any more.' });
    res.writeHead(200, { 'content-type': type!, ...SECURITY_HEADERS, 'cache-control': 'no-store' });
    return void res.end(data);
  },
  // The Videos shelf, newest first: ?chat= for one chat's clips, ?q= for words in the prompt.
  '/api/clips/shelf': async ({ res, url }) => {
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(200, Number(url.searchParams.get('limit')) || 60);
    const chat = url.searchParams.get('chat');
    const list = await clipShelf.list(offset, limit, (url.searchParams.get('q') ?? '').slice(0, 200), chat === null ? undefined : chat.slice(0, 80));
    return json(res, 200, { ...list, lowDisk: await roomLine() });
  },
};

/**
 * {chatId, who, prompt, seconds, size, quality, negative, seed, steps, start?, startFrom?, startName?}: the words go into
 * the chat and the clip is put in line on the hire's PC. A seed left empty is a random one, kept with the clip. The
 * picture the clip starts from, if any, is chosen as startChosen says.
 */
/**
 * A chosen start picture made ready for `model` (one that takes one): fitted (cropped) to the clip's size for the runner,
 * a copy that goes once the clip ends, and the plan for keeping the picture with the clip (a new PNG kept as given).
 */
export async function fitStart(chosen: { png: Buffer; file: string; name: string }, ask: { width: number; height: number }, model: string): Promise<{ startPicture: string; start: StartPlan } | { error: string; wordsOnly?: boolean }> {
  if (!takesStartPicture(model)) return { error: wordsOnlyLine(model), wordsOnly: true };
  let fitted: Buffer;
  try {
    fitted = await fitTo(chosen.png, { width: ask.width, height: ask.height }, 'crop');
  } catch {
    return { error: 'The start picture could not be read. Add it again (from the gallery or a file).' };
  }
  if (fitted.length > MAX_START_BYTES) return { error: 'The start picture is too detailed to send with the clip. Pick another.' };
  const dir = join(clipShelf.dir, 'starts');
  await mkdir(dir, { recursive: true });
  const id = randomBytes(6).toString('hex');
  const startPicture = join(dir, `run-${id}.png`);
  await writeFile(startPicture, fitted);
  let file = chosen.file;
  if (!file) {
    // A new PNG is kept as it was given (not the cropped copy), with the clip once it is made.
    file = join(dir, `start-${id}.png`);
    await writeFile(file, chosen.png);
  }
  return { startPicture, start: { file, fresh: !chosen.file, name: chosen.name } };
}

/** In a project's chat the start picture also goes in the project's Start frames folder. */
export async function startInto(start: StartPlan, chat: string): Promise<void> {
  const folder = await projectFolder((await chats.get(chat).catch(() => null))?.project);
  if (folder === null) return;
  const rel = folders.startFrames(folder);
  start.into = { dir: join(await workspaceDir(), ...rel.split('/')), rel };
}

async function makeClip(res: ServerResponse, b: Record<string, unknown>) {
    const ask = cleanAsk(b);
    if ('error' in ask) return json(res, 400, { error: ask.error });
    const named = namedChat(b, true);
    if ('error' in named) return json(res, 400, { error: named.error });
    const to = await sendTarget(named);
    if ('error' in to) return json(res, to.status, { error: to.error });
    if (to.chat && !chatPersonHere(to.chat.who)) return json(res, 400, { error: 'The person in this chat is no longer on the team, so it can be read but not carried on. Press "New chat" to talk to someone else.' });
    const member = to.who.startsWith('staff:') ? staff.get(to.who.slice(6)) : undefined;
    if (!member || !isVideographer(member)) return json(res, 400, { error: 'Clips are made by a Videographer: open their chat and type what the clip should show.' });
    // A hire on a linked PC has its clip made there (src/videolink.ts) and brought back here.
    const { model, pc } = clipModelOf(member);
    const big = sizeRefused(ask.width, ask.height, model);
    if (big) return json(res, 400, { error: big });
    // A start picture: a new PNG (a file, a clip's frame) or one already here (a gallery picture, a project's).
    const chosen = await startChosen(b);
    if (chosen && 'error' in chosen) return json(res, 400, { error: chosen.error });
    if (chosen && !takesStartPicture(model)) return json(res, 400, { error: wordsOnlyLine(model), wordsOnly: true });
    const fit = chosen ? await fitStart(chosen, ask, model) : null;
    if (fit && 'error' in fit) return json(res, 400, fit);
    const startPicture = fit?.startPicture ?? '';
    const start = fit?.start;
    const into = await chatToSend(to);
    if (start) await startInto(start, into.id);
    const at = new Date().toISOString();
    await store.changeChat(chats.file(into.id), lines => [...lines, { role: 'user', content: ask.prompt, at }]);
    const pcName = pc === 'here' ? 'this PC' : store.peek()?.remotes.find(x => x.id === pc)?.name ?? pc;
    // @names: the chat's project's characters and locations add their words (src/cards.ts), and their words to leave out
    // go into the negative prompt, as for a picture; the chat keeps what was typed.
    const e = await expandForChat(ask.prompt, into.id);
    const negative = e.used.length ? withAvoid(ask.negative, e.avoid) : ask.negative;
    const v = clips.start({ ...ask, prompt: e.used.length ? e.prompt : ask.prompt, ...(negative ? { negative } : {}), model, who: to.who, name: member.name.split(/\s+/)[0], chat: into.id, pc, pcName, ...(startPicture ? { startPicture } : {}), ...(start ? { start } : {}) });
    if ('refused' in v) {
      if (startPicture) await rm(startPicture, { force: true }).catch(() => undefined);
      if (start?.fresh) await rm(start.file, { force: true }).catch(() => undefined);
      await store.changeChat(chats.file(into.id), lines => [...lines, { role: 'assistant', content: v.refused, at: new Date().toISOString(), failed: true }]);
      return json(res, 409, { error: v.refused, fault: v.fault, chat: into.id });
    }
    return json(res, 200, { chat: into.id, job: viewOut(v) });
}

export const clipsPost: Routes = {
  // A prompt typed on the page is held to PROMPT_MAX: only Make again's own ask may be longer (its @names filled in).
  '/api/clips/make': ({ res, b }) => makeClip(res, { ...b, filled: false }),
  // {id, seed: 'same' | 'new'}: a shelf clip made again in the chat it was asked in.
  '/api/clips/again': async ({ res, b }) => {
    const c = await clipShelf.get(String(b.id ?? '').slice(0, 40));
    if (!c) return json(res, 404, { error: 'That clip is not on the shelf any more.' });
    if (isJoined(c)) return json(res, 400, { error: 'A joined video is made from its shots, not from one prompt: press Redo on a shot in the shot list, then join them again.' });
    if (b.seed !== 'new' && typeof c.seed !== 'number') return json(res, 400, { error: 'The seed of this clip is not known (it was made before seeds were kept): make it again with a new seed.' });
    if (!c.chat || !(await chats.get(c.chat).catch(() => null))) return json(res, 400, { error: "The chat this clip was made in is gone: open a Videographer's chat and press Use this prompt." });
    return makeClip(res, againAsk(c, b.seed === 'new' ? 'new' : 'same'));
  },
  '/api/clips/stop': ({ res, b }) => json(res, 200, { stopped: clips.stop(String(b.id ?? '').slice(0, 40)) }),
  // {id} or {ids: [...]}: clips deleted from the shelf, their files from this PC.
  '/api/clips/delete': async ({ res, b }) => {
    const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).slice(0, 500).map(x => String(x ?? '').slice(0, 40)).filter(Boolean);
    const gone: string[] = [];
    for (const id of ids) if (await clipShelf.remove(id)) gone.push(id);
    const deleted = gone.length;
    await noteDeleted(gone).catch(e => console.warn(`Deleted clips could not be noted: ${(e as Error).message}`));
    return deleted || !ids.length ? json(res, 200, { ok: true, deleted }) : json(res, 404, { error: ids.length === 1 ? 'That clip is not on the shelf any more.' : 'Those clips are not on the shelf any more.' });
  },
};

/** GET /api/clips/file/<month>/<name>: a clip from the shelf, in parts when the player asks for a range. */
export async function clipFile(req: IncomingMessage, res: ServerResponse, p: string): Promise<boolean> {
  const m = /^\/api\/clips\/file\/(.+)$/.exec(p);
  if (!m) return false;
  const rel = decoded(m[1]);
  const f = rel === null ? null : await clipShelf.file(rel);
  const size = f ? await stat(f.path).then(s => s.size, () => -1) : -1;
  if (!f || size < 0) return json(res, 404, { error: 'That clip is not on the shelf any more.' }), true;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  const head = { 'content-type': f.mime, 'accept-ranges': 'bytes', ...SECURITY_HEADERS, 'cache-control': 'no-store' };
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}`, ...SECURITY_HEADERS });
      return res.end(), true;
    }
    res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    createReadStream(f.path, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...head, 'content-length': size });
  createReadStream(f.path).pipe(res);
  return true;
}
