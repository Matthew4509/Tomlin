// Pictures for the queue and for linked PCs: drawn here or on the artist's PC.
import { randomBytes } from 'node:crypto';
import type { Remote } from '../store.ts';
import * as brains from '../brains.ts';
import { detectMode, type Mode } from '../modes.ts';
import { drawsPictures } from '../staff.ts';
import type { Picture } from '../gallery.ts';
import { type Routes, chats, json, shortName, staff, store, workspaceDir } from './core.ts';
import { expandForProject, withAvoid } from './cards.ts';
import { images, runners, runnerUsed } from './panes.ts';
import { optionsFrom, promptWhy, refPictures, typedWhy } from '../images.ts';
import { REFS_SENT_MOST, seedWhy } from '../drawrefs.ts';
import { drawChoices } from '../nodestaff.ts';
import { newRid } from '../outbox.ts';
import type { Quality } from '../quality.ts';
import { answeringBusy, imageSpecialist } from './answering.ts';
import { isArtistWho } from './people.ts';
import { jobRoutes } from './jobs.ts';
import { readFile, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import * as ws from '../workspace.ts';
import { cleanSource, readSources, SOURCE_END } from '../sources.ts';
import { bothNegative, extraWords, pickedStyle, withWords, type PictureStyle } from '../styles.ts';

/** What drew a picture: the model's id (null when the PC that drew it did not say), its name, and the PC. */
export type Drawn = { model: string | null; modelName: string; pc: string };

/** This PC's name, as linked PCs know it (Network), else Windows' name for it. */
export const thisPcName = (): string => {
  try {
    return String(jobRoutes.shareView().name ?? '').trim() || hostname();
  } catch {
    return hostname();
  }
};

// ---- The Images pane's artist: a picture hire draws wherever they live ----

/**
 * Where the artist `as` draws when it is not this PC's connected picture model: a hire whose first ready brain is on a
 * linked PC (one of its shared picture models, or what it has loaded). Null: draw here as usual.
 */
async function artistAway(as: string): Promise<{ r: Remote; model?: string; name: string } | null> {
  const m = staff.get(as);
  if (!m || !drawsPictures(m.role)) return null;
  const here = images.pane.view.state === 'connected';
  for (const ref of brains.refsOf(m)) {
    const b = brains.parseRef(ref);
    if (b.kind === 'here' && here) return null;
    if (b.kind === 'remote') {
      const got = await jobRoutes.pictureDrawer([ref], false);
      if (got) return { r: got.r, model: got.model, name: m.name };
    }
  }
  return null;
}

/**
 * A picture on another PC goes on there when the link drops (its request id keeps it in that PC's outbox), and this PC
 * asks for it again for up to 6 hours: a slow PC or a network that drops for a while does not lose the picture.
 */
export const KEEP_DRAWING_MS = 6 * 3600_000;

const AWAY_RUNNING = ['queued', 'starting', 'drawing', 'decoding', 'finishing'];
type AwayJob = { id: string; pc: string; pcName: string; who: string; state: string; step: number; steps: number; startedAt: number; etaSeconds: number | null; perStep: number | null; prompt: string; note: string | null; error: string | null; results: unknown[]; chat: string | null; ac: AbortController };
/** The pictures being drawn on linked PCs for the Images window: one at a time on each PC, any number of PCs at once (T1). */
const awayJobs = new Map<string, AwayJob>();
const running = (j: AwayJob | undefined): j is AwayJob => !!j && AWAY_RUNNING.includes(j.state);
/** The newest picture on another PC (running or just ended), the one the Images window follows when it is newer than this PC's. */
const newestAway = (): AwayJob | null => [...awayJobs.values()].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;

/**
 * The other pictures still being drawn on linked PCs, besides the one the Images window shows: each with its artist, PC
 * and step, so a picture here or on one PC never hides one going on another (T1).
 */
export function alsoDrawing(shown: string | null) {
  return [...awayJobs.values()].filter(j => running(j) && j.id !== shown).sort((a, b) => a.startedAt - b.startedAt)
    .map(j => ({ id: j.id, who: j.who, pc: j.pc, pcName: j.pcName, state: j.state, step: j.step, steps: j.steps, elapsed: Math.round((Date.now() - j.startedAt) / 1000), prompt: j.prompt }));
}

/** The Images pane's picture: one drawn on another PC while it is the newer one, else this PC's own. */
export function paneJob() {
  const here = images.jobView();
  const awayJob = newestAway();
  if (!awayJob) return here;
  const hereStarted = here ? Date.now() - here.elapsed * 1000 : 0;
  if (here && hereStarted > awayJob.startedAt) return here;
  const j = awayJob;
  return { id: j.id, state: j.state, mode: 'custom', modeWhy: '', target: null, generated: null, count: 1, steps: j.steps, step: j.step, image: 1, perStep: j.perStep, etaSeconds: j.etaSeconds,
    elapsed: Math.round((Date.now() - j.startedAt) / 1000), results: j.results, error: j.error, note: j.note, finalOf: null, queued: 0, prompt: j.prompt, chat: j.chat };
}

/** Starts a picture on the artist's PC for the Images pane; it comes back into the gallery here. */
async function startAway(away: { r: Remote; model?: string; name: string }, b: Record<string, unknown>, chat: string, refs: string[] = []): Promise<{ status: number; body: unknown }> {
  const prompt = String(b.prompt ?? '').trim();
  if (!prompt) return { status: 400, body: { error: 'Type a prompt first: what should the picture show?' } };
  const tooLong = promptWhy(prompt);
  if (tooLong) return { status: 400, body: { error: tooLong } };
  // A seed that PC could not draw with is refused here in words, as a picture drawn here would be.
  const badSeed = seedWhy(b.seed);
  if (badSeed) return { status: 400, body: { error: badSeed } };
  // One picture at a time on each linked PC; pictures on different PCs go at once, and the Images window shows each (T1).
  if (running(awayJobs.get(away.r.id))) {
    return { status: 409, body: { error: `${away.name}'s PC ("${away.r.name}") is busy drawing the last picture. Add this one to the queue: it is drawn when that one is done.`, queue: true } };
  }
  const look = pickedStyle(b.style);
  const chosen = look ? look.mode : typeof b.mode === 'string' && b.mode !== 'auto' ? b.mode : detectMode(prompt, null).mode;
  const style = brains.styleOfMode(chosen as Mode);
  // A style that is not a mode's own goes as words: that PC knows only the modes, whatever TOMLIN it runs.
  const extra = extraWords(look);
  const asked = { ...b, ...(extra.negative ? { negative: bothNegative(typeof b.negative === 'string' ? b.negative : '', extra.negative) } : {}) };
  const size = (v: unknown) => (typeof v === 'number' && v >= 256 && v <= 2048 ? Math.round(v) : undefined);
  const job: AwayJob = { id: randomBytes(6).toString('hex'), pc: away.r.id, pcName: away.r.name, who: away.name, state: 'starting', step: 0, steps: 0, startedAt: Date.now(), etaSeconds: null as number | null, perStep: null as number | null, prompt,
    note: `Asking ${away.name} on "${away.r.name}" to draw it…` as string | null, error: null as string | null, results: [] as unknown[], chat: chat || null, ac: new AbortController() };
  awayJobs.set(away.r.id, job);
  // A PC drawn on long ago (unlinked since, or not used again) is not kept: its last picture is in the gallery.
  for (const [pc, j] of awayJobs) if (!AWAY_RUNNING.includes(j.state) && Date.now() - j.startedAt > KEEP_DRAWING_MS + 3600_000) awayJobs.delete(pc);
  void (async () => {
    try {
      // The @Name pictures go with it as data: that PC has no copy of this project's files.
      const refImages = await refPictures(refs, REFS_SENT_MOST);
      const got = await jobRoutes.drawOn(away.r, { prompt: withWords(prompt, extra.boost), style, width: size(b.width), height: size(b.height), ...drawChoices(asked), ...(away.model ? { model: away.model } : {}), ...(refImages.length ? { refImages } : {}), rid: newRid(), keepMs: KEEP_DRAWING_MS }, p => {
        if (typeof p.text === 'string') {
          job.state = 'starting';
          job.note = `${away.name} on "${away.r.name}": ${p.text}…`;
          return;
        }
        if (typeof p.state === 'string' && AWAY_RUNNING.includes(p.state)) job.state = p.state;
        // What that PC says about this picture (moved to its CPU, drawn smaller), in place of "Loading … there".
        if (typeof p.note === 'string' && p.note.trim()) job.note = `${away.name} on "${away.r.name}": ${p.note.trim().slice(0, 400)}`;
        if (typeof p.step === 'number') job.step = p.step;
        if (typeof p.steps === 'number') job.steps = p.steps;
        job.etaSeconds = typeof p.etaSeconds === 'number' ? p.etaSeconds : null;
        if (job.step > 0) job.perStep = (Date.now() - job.startedAt) / 1000 / job.step;
      }, job.ac.signal);
      const pic = await images.receive({ png: got.png, prompt, modelPrompt: got.modelPrompt, mode: got.mode, modelName: got.modelName, pc: away.r.name, seconds: got.seconds, made: got.made, chat: job.chat ?? undefined });
      job.results = [pic];
      job.note = got.note ? `${away.r.name} ${got.note}` : null;
      job.state = 'done';
    } catch (error) {
      job.state = job.ac.signal.aborted ? 'cancelled' : 'failed';
      const why = (error as Error).message;
      job.error = job.ac.signal.aborted ? null : /no picture model is connected|not loaded|asleep/i.test(why)
        ? `${away.name} is asleep on "${away.r.name}": press Wake up above to load their model there, then Generate again.`
        : `${away.name} on "${away.r.name}" could not draw it: ${why}`;
    }
  })();
  return { status: 202, body: { id: job.id, job: paneJob() } };
}

/** The linked PCs a picture from the Images window is being drawn on now (their ids): the queue waits for each. */
export const awayBusy = (): string[] => [...awayJobs.values()].filter(running).map(j => j.pc);

/**
 * Before the queue loads picture model `id` here: chat models not answering are unloaded, the least recently used
 * first, until it fits (the queue does one thing at a time on each PC, so it may change what is loaded). Their names.
 */
async function roomForPicture(id: string): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    if ((images.list().find(m => m.id === id)?.fit.level ?? 'ok') !== 'no') break;
    const r = runners.filter(p => p.view.state === 'connected' && !answeringBusy(p)).sort((a, b) => (runnerUsed.get(a) ?? 0) - (runnerUsed.get(b) ?? 0))[0];
    if (!r) break;
    out.push(shortName(r.view.modelName ?? '') || 'a chat model');
    await r.disconnect();
    // The memory goes back to Windows a moment after the runner ends.
    await new Promise(res => setTimeout(res, 1500));
  }
  return out;
}

/**
 * A picture for the queue (src/server/queue.ts): drawn by its artist where they live, whole (not a draft): on their
 * linked PC, or here, loading their picture model first (making room for it). It comes back into the gallery here.
 */
/**
 * An artist's preferred style (Edit staff; src/styles.ts, the style tiles' list), for a picture that names none: its style
 * tile is Auto, no mode is asked, and the words name no style (detectMode finds no icon, cartoon or photo words).
 */
export function preferredLook(artist: { style?: string | null } | undefined, prompt: string, style: unknown, mode: unknown): PictureStyle | null {
  if (!artist?.style || pickedStyle(style)) return null;
  if (typeof mode === 'string' && mode && mode !== 'auto') return null;
  if (detectMode(prompt, null).mode !== 'custom') return null;
  return pickedStyle(artist.style);
}

export async function queuedPicture(o: { prompt: string; as?: string; mode?: string; look?: string; plain?: boolean; width?: number; height?: number; negative?: string; rid?: string; quality?: 'draft' | 'mid' | 'high'; seed?: number; refs?: string[] }, signal: AbortSignal, progress: (p: Record<string, unknown>) => void): Promise<{ pic: Picture; where: string; by: string; note?: string; drawn: Drawn } | { error: string }> {
  const artist = o.as ? staff.get(o.as) ?? null : (await imageSpecialist()) ?? null;
  // The @Name pictures it was added with, found again in the workspace (one moved or deleted since is left out).
  const root = o.refs?.length ? await workspaceDir() : '';
  const refPaths = (await Promise.all((o.refs ?? []).map(r => ws.inside(root, r, false)))).filter((x): x is string => !!x);
  // Drawn and saved already for this request (TOMLIN was closed before its queue line was marked done): collected from
  // the gallery, never drawn a second time.
  const had = o.rid ? await images.gallery.ofQueue(o.rid) : undefined;
  if (had) {
    const where = had.device.startsWith('on ') ? `"${had.device.slice(3)}"` : 'this PC';
    // A linked PC's model id is not kept on the picture: such a picture is never kept as a style sample (sampleRecord).
    const drawn = had.model === 'remote' ? { model: null, modelName: had.modelName, pc: had.device.slice(3) } : { model: had.model, modelName: had.modelName, pc: thisPcName() };
    return { pic: had, where, by: artist ? artist.name.split(/\s+/)[0] : 'The picture model', note: 'It was drawn before TOMLIN was closed, so it was not drawn again.', drawn };
  }
  if (o.as && !artist) return { error: 'That artist is no longer on the team: add the picture again with another artist.' };
  const by = artist ? artist.name.split(/\s+/)[0] : 'The picture model';
  const refs = artist ? brains.refsOf(artist) : [];
  const first = refs[0] ? brains.parseRef(refs[0]) : null;
  // The style picked for this picture; else the artist's preferred one. A style sample (plain) keeps its own style only.
  const look = pickedStyle(o.look) ?? (o.plain ? null : preferredLook(artist ?? undefined, o.prompt, o.look, o.mode));
  const chosen = (look ? look.mode : o.mode && o.mode !== 'auto' ? o.mode : detectMode(o.prompt, null).mode) as Mode;
  if (first?.kind === 'remote') {
    const why: string[] = [];
    const away = await jobRoutes.pictureDrawer([refs[0]], false, why);
    if (!away) return { error: `${by} cannot draw now: ${why.join('; ') || 'their PC is off or not answering'}` };
    const recipe = artist && !o.plain ? images.recipe?.(artist.id) ?? null : null;
    const style = brains.styleOfMode(recipe?.mode ?? chosen);
    // A style that is not a mode's own goes as words (an artist whose way of working sets the mode keeps theirs).
    const extra = recipe?.mode ? { boost: '', negative: '' } : extraWords(look);
    // The artist's way of working goes with the words (that PC knows nothing about this team), unless a style is asked.
    const prompt = withWords(recipe?.boost && !style ? withWords(o.prompt, recipe.boost) : o.prompt, extra.boost);
    // The words to leave out go too (the asked ones, the style's, then the artist's own): that PC adds its own for the mode after them.
    const negative = [o.negative?.trim(), extra.negative, recipe?.negative].filter(Boolean).join(', ');
    progress({ text: `Asking "${away.r.name}" to draw it` });
    const refImages = await refPictures(refPaths, REFS_SENT_MOST);
    // Asked with the queue item's request id: when the link is lost, or this PC is closed while that PC draws, the picture
    // waits there and the next try collects it (src/jobrun/pictureback.ts). That PC forgets it only once it is saved here.
    const got = await jobRoutes.drawOn(away.r, { prompt, style, width: o.width, height: o.height, ...(negative ? { negative } : {}), ...(away.model ? { model: away.model } : {}), ...drawChoices({ quality: o.quality, seed: o.seed }), ...(refImages.length ? { refImages } : {}), queue: true, ...(o.rid ? { rid: o.rid } : {}) }, progress, signal);
    const pic = await images.receive({ png: got.png, prompt: o.prompt, modelPrompt: got.modelPrompt, mode: got.mode, modelName: got.modelName, pc: away.r.name, seconds: got.seconds, made: got.made, ...(o.rid ? { queued: o.rid } : {}) });
    await got.taken();
    // What drew it, as that PC said: its model's id (a TOMLIN from before it sent one says none) and name.
    const drawn = { model: got.made?.model || null, modelName: got.modelName, pc: away.r.name };
    return { pic, where: `"${away.r.name}"`, by, ...(got.note ? { note: got.note } : {}), drawn };
  }
  const v = images.pane.view;
  const want = first?.kind === 'here' ? first.id : v.state === 'connected' ? v.model ?? null : null;
  if (!want || !images.has(want)) return { error: artist ? `${by} has no picture model on this PC: give them one under Staff, then add it again.` : 'Nobody on the team draws, and no picture model is connected: hire an artist (Staff: hire and edit, in the left panel), then add it again.' };
  if (!(v.model === want && v.state === 'connected')) {
    const name = shortName(images.list().find(m => m.id === want)?.name) || 'the picture model';
    const dropped = await roomForPicture(want);
    progress({ text: `${dropped.length ? `Unloaded ${dropped.join(' and ')} to make room. ` : ''}Loading ${name}` });
    if (signal.aborted) return { error: 'Stopped.' };
    if (!(await loadImage(want))) return { error: `${name} did not load on this PC: it is busy with another picture, or too big for the memory free now` };
    // Stopped while it loaded (that can take minutes): no picture is asked for.
    if (signal.aborted) return { error: 'Stopped.' };
  }
  const job = await images.generate({ prompt: o.prompt, negative: o.negative, mode: o.mode && o.mode !== 'auto' ? (o.mode as Mode) : 'auto', ...(look ? { look: look.id } : {}), ...(o.plain ? { plain: true } : {}), width: o.width, height: o.height, exactSize: o.width !== undefined || o.height !== undefined, drafts: 1, full: true, source: 'api', as: artist?.id, ...(o.rid ? { queued: o.rid } : {}), ...(o.quality ? { quality: o.quality } : {}), ...(o.seed !== undefined ? { seed: o.seed } : {}), ...(refPaths.length ? { refs: refPaths } : {}) });
  if (!('id' in job)) return { error: job.error };
  const timer = setInterval(() => {
    const j = images.jobView();
    if (j && j.id === job.id) progress({ state: j.state, step: j.step, steps: j.steps, etaSeconds: j.etaSeconds });
  }, 1000);
  const stop = () => void images.cancel(job.id).catch(() => undefined);
  signal.addEventListener('abort', stop, { once: true });
  // Stopped while the picture was being asked for: the listener above never hears that one.
  if (signal.aborted) stop();
  await job.done.finally(() => {
    clearInterval(timer);
    signal.removeEventListener('abort', stop);
  });
  const pic = job.results[0];
  if (!pic) return { error: job.state === 'cancelled' ? 'Stopped.' : job.error ?? 'The picture did not come out.' };
  const said = images.jobView();
  return { pic, where: 'this PC', by, ...(said?.id === job.id && said.note ? { note: said.note } : {}), drawn: { model: pic.model, modelName: pic.modelName, pc: thisPcName() } };
}

/** Every picture model in the registry, with the styles it is made for (registry recommendedModes). */
export function pictureModels(): brains.PictureModel[] {
  return images.list().map(m => ({ id: m.id, name: m.name, modes: images.registry.get(m.id)?.recommendedModes ?? [], installed: m.installed, bytes: m.bytes }));
}

/**
 * One picture for a linked PC, on the picture model connected here (F7 E2). It is drawn in memory and sent: it never
 * enters this PC's gallery or its folder, and this PC's Images pane shows only "Drawing for <that PC>".
 */
export async function drawForPc(o: { prompt: string; mode: string; width?: number; height?: number; forPc: string; quality?: string; seed?: number; negative?: string; refData?: string[] }, progress: (p: unknown) => void, signal: AbortSignal) {
  const job = await images.generate({ prompt: o.prompt, negative: o.negative, mode: o.mode as Mode, width: o.width, height: o.height, quality: o.quality as Quality, seed: o.seed, drafts: 1, source: 'api', forPc: o.forPc, exactSize: o.width !== undefined || o.height !== undefined, ...(o.refData?.length ? { refData: o.refData } : {}) });
  if (!('id' in job)) return { error: job.error };
  const timer = setInterval(() => {
    const j = images.jobView();
    // The note too: why the picture is slower (moved to the CPU, part of the model kept in RAM) is said where it was asked.
    if (j && j.id === job.id) progress({ state: j.state, step: j.step, steps: j.steps, elapsed: j.elapsed, etaSeconds: j.etaSeconds, queued: j.queued, note: images.noteOf(job.id) });
  }, 800);
  const stop = () => {
    // Only this picture: whatever this PC's owner has queued keeps going.
    if (job.state !== 'done' && job.state !== 'failed') void images.cancel(job.id).catch(() => undefined);
  };
  signal.addEventListener('abort', stop, { once: true });
  await job.done.finally(() => {
    clearInterval(timer);
    signal.removeEventListener('abort', stop);
  });
  const pic = images.takeAway(job.id);
  if (!pic) return { error: job.state === 'cancelled' ? 'it was stopped.' : job.error ?? 'the picture did not come out.' };
  return { png: pic.png, modelName: pic.modelName.replace(/\s*\(.*\)$/, ''), modelPrompt: pic.modelPrompt, mode: pic.mode, seconds: pic.seconds, note: pic.note, made: pic.made };
}

/** Swaps this PC's connected picture model for another of its own (a paired PC asked for a style this one draws better). */
export async function swapImage(id: string): Promise<boolean> {
  if (images.busy() || images.pane.view.state !== 'connected') return false;
  return loadImage(id);
}

/**
 * Loads picture model `id` in the Images pane (in place of the one connected, if any) and waits until it is connected:
 * for a linked PC's artist drawing on one of the picture models this PC lets linked PCs use. False when it did not load.
 */
export async function loadImage(id: string, signal?: AbortSignal): Promise<boolean> {
  if (images.pane.view.model === id && images.pane.view.state === 'connected') return true;
  // Loading already (a Cancel loads the model again): waited for, not loaded a second time over it.
  if (!(images.pane.view.model === id && images.pane.view.state === 'loading')) {
    if (images.busy()) return false;
    const a = (await store.settings()).image;
    const r = await images.connect(id, a.asked, a.threads);
    if ('error' in r) return false;
  }
  const t0 = Date.now();
  // Stop on that PC ends the wait at once (27 Nov: a cancelled picture held the Z820 "1st in line" for 10 minutes).
  // A model still loading is waited for up to an hour: a 12-28 GB model read from a hard disk took over 10 minutes on
  // the Z820, was given up on, and then loaded and drew anyway with no one to take the picture (27 Nov).
  while (Date.now() - t0 < loadWaitMs(images.pane.view.model === id && images.pane.view.state === 'loading') && !signal?.aborted) {
    await new Promise(res => setTimeout(res, 400));
    const v = images.pane.view;
    if (v.model === id && v.state === 'connected') return true;
    if (v.model === id && (v.state === 'failed' || v.state === 'disconnected')) return false;
  }
  return false;
}

/** How long loadImage waits: 10 minutes, or an hour while the model is still loading. */
export const loadWaitMs = (stillLoading: boolean): number => (stillLoading ? 60 : 10) * 60_000;

// ---- Routes ----

/** GET requests answered here, by path. */
export const picturesGet: Routes = {
  '/api/images/sources': async ({ res, url }) => {
    // ?folder=<a folder in the workspace, '' for all of it>: Load previously made images. Every image source in it
    // (src/sources.ts), newest first, whether its picture file is still there or not.
    const folder = (url.searchParams.get('folder') ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const root = await workspaceDir();
    const probe = folder ? await ws.inside(root, `${folder}/x`, false) : null;
    const dir = folder ? (probe ? dirname(probe) : null) : await realpath(root).catch(() => null);
    if (!dir) return json(res, 400, { error: folder ? 'That is not a folder in the workspace. Type a folder as Files shows it (a project folder, say), or leave it empty for the whole workspace.' : 'The workspace folder is not there. Choose it under Settings, then try again.' });
    const r = await readSources(dir);
    return json(res, 200, { folder, ...r, sources: r.sources.map(s => ({ ...s, path: folder ? `${folder}/${s.path}` : s.path })) });
  },
};

/** POST requests answered here, by path (the body is read already). */
export const picturesPost: Routes = {
  '/api/images/generate': async ({ res, b }) => {
    // {chat}: the chat the picture goes into ('' = none), named by the page: not whichever chat another window opened last.
    if (typeof b.chat !== 'string') return json(res, 400, { error: 'Nothing was drawn: this names no chat for the picture (the page may be from an older TOMLIN). Reload the page, then draw again.' });
    const chat = b.chat ? await chats.get(b.chat) : null;
    if (b.chat && !chat) return json(res, 404, { error: 'Nothing was drawn: that chat is not there any more (it may have been deleted in another window). Open a chat from the list, then draw again.' });
    // An artist's chat still called "New chat" is named after the first picture asked in it, once the picture has started.
    const name = () => (chat && isArtistWho(chat.who) && typeof b.prompt === 'string' && b.prompt.trim() ? chats.touch(chat.id, b.prompt) : null);
    // @Ember, @Pine forest: the chat's project's characters and locations add their words (src/cards.ts).
    // Their ticked pictures go to a model that takes reference pictures: read here, and sent as data to a linked PC.
    // What was typed is checked before the cards add their words, so their words never make it "too long".
    const typedLong = typedWhy(String(b.prompt ?? '').trim());
    if (typedLong) return json(res, 400, { error: typedLong });
    let refs: string[] = [];
    if (chat?.project && typeof b.prompt === 'string' && b.prompt.includes('@')) {
      const e = await expandForProject(b.prompt, chat.project);
      if (e.used.length) b = { ...b, prompt: e.prompt, negative: withAvoid(b.negative, e.avoid) };
      refs = e.refs;
    }
    // Style Auto, no mode, and words that name no style: the artist's preferred style (Edit staff), here or on their PC.
    const pref = preferredLook(typeof b.as === 'string' ? staff.get(b.as) : undefined, String(b.prompt ?? ''), b.style, b.mode);
    if (pref) b = { ...b, style: pref.id };
    const away = typeof b.as === 'string' && b.as ? await artistAway(b.as) : null;
    if (away) {
      const r = await startAway(away, b, chat?.id ?? '', refs);
      if (r.status === 202) await name();
      return json(res, r.status, r.body);
    }
    // This PC is a node and a linked PC is drawing here (or has a picture model loaded here): asked first.
    const impact = jobRoutes.shareOn() && b.agree !== true ? jobRoutes.impactOf(null, true) : null;
    if (impact) return json(res, 409, { error: impact, impact });
    const r = await images.generate({ ...optionsFrom(b, 'page'), chat: chat?.id ?? '', ...(refs.length ? { refs } : {}) });
    if (!('id' in r)) return json(res, r.status, { error: r.error });
    await name();
    return json(res, 202, { id: r.id, job: images.jobView() });
  },
  '/api/images/from-source': async ({ res, b }) => {
    // {path, seed: 'same' | 'new', chat}: draws an image source found by Load previously made images again on this
    // PC's picture model: the same words, size and settings, with its seed or a new one.
    if (typeof b.chat !== 'string') return json(res, 400, { error: 'Nothing was drawn: this names no chat for the picture. Reload the page, then try again.' });
    const chat = b.chat ? await chats.get(b.chat) : null;
    if (b.chat && !chat) return json(res, 404, { error: 'Nothing was drawn: that chat is not there any more. Open a chat from the list, then try again.' });
    const path = typeof b.path === 'string' && b.path.endsWith(SOURCE_END) ? await ws.inside(await workspaceDir(), b.path, false) : null;
    const src = path ? cleanSource(await readFile(path, 'utf8').then(JSON.parse).catch(() => null)) : null;
    if (!src) return json(res, 404, { error: 'That image source is not there any more, or cannot be read. Press Look again.' });
    const r = await images.generate({ prompt: '', source: 'page', chat: chat?.id ?? '', fromSource: src, newSeed: b.seed === 'new', ...(src.settings === 'known' ? {} : { drafts: 1 }) });
    if (!('id' in r)) return json(res, r.status, { error: r.error });
    return json(res, 202, { id: r.id, job: images.jobView() });
  },
  '/api/images/cancel': async ({ req, res, url, b }) => {
    // {id}: that picture (one of the others drawing); none named: the one the Images window shows. Only that one is
    // stopped: a picture that has just ended is never swapped for another one still going (on this PC or another).
    const want = typeof b.id === 'string' && b.id ? b.id : paneJob()?.id ?? null;
    const away = want ? [...awayJobs.values()].find(j => j.id === want) : undefined;
    if (away) {
      const going = running(away);
      if (going) away.ac.abort();
      return json(res, 200, { ok: true, ...(going ? {} : { ended: true }) });
    }
    const here = images.jobView();
    if (want && here?.id !== want) return json(res, 200, { ok: true, ended: true });
    // Named, so the pictures waiting behind it (another chat's, the queue's) are never cancelled with it.
    if (await images.post(req, res, url, want ? { ...b, id: want } : b)) return;
    return json(res, 404, { error: 'Not found.' });
  },
};
