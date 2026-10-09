// Pictures for the queue and for linked PCs: drawn here or on the artist's PC.
import { randomBytes } from 'node:crypto';
import type { Remote } from '../store.ts';
import * as brains from '../brains.ts';
import { detectMode, type Mode } from '../modes.ts';
import { roleOf } from '../staff.ts';
import type { Picture } from '../gallery.ts';
import { type Routes, chats, json, shortName, staff, store } from './core.ts';
import { images, runners, runnerUsed } from './panes.ts';
import { optionsFrom } from '../images.ts';
import { answeringBusy, imageSpecialist } from './answering.ts';
import { isArtistWho } from './people.ts';
import { jobRoutes } from './jobs.ts';

// ---- The Images pane's artist: a picture hire draws wherever they live ----

/**
 * Where the artist `as` draws when it is not this PC's connected picture model: a hire whose first ready brain is on a
 * linked PC (one of its shared picture models, or what it has loaded). Null: draw here as usual.
 */
async function artistAway(as: string): Promise<{ r: Remote; model?: string; name: string } | null> {
  const m = staff.get(as);
  if (!m || !roleOf(m.role).kind) return null;
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

const AWAY_RUNNING = ['queued', 'starting', 'drawing', 'decoding', 'finishing'];
let awayJob: { id: string; pc: string; state: string; step: number; steps: number; startedAt: number; etaSeconds: number | null; perStep: number | null; prompt: string; note: string | null; error: string | null; results: unknown[]; chat: string | null; ac: AbortController } | null = null;

/** The Images pane's picture: one drawn on another PC while it is the newer one, else this PC's own. */
export function paneJob() {
  const here = images.jobView();
  if (!awayJob) return here;
  const hereStarted = here ? Date.now() - here.elapsed * 1000 : 0;
  if (here && hereStarted > awayJob.startedAt) return here;
  const j = awayJob;
  return { id: j.id, state: j.state, mode: 'custom', modeWhy: '', target: null, generated: null, count: 1, steps: j.steps, step: j.step, image: 1, perStep: j.perStep, etaSeconds: j.etaSeconds,
    elapsed: Math.round((Date.now() - j.startedAt) / 1000), results: j.results, error: j.error, note: j.note, finalOf: null, queued: 0, prompt: j.prompt, chat: j.chat };
}

/** Starts a picture on the artist's PC for the Images pane; it comes back into the gallery here. */
async function startAway(away: { r: Remote; model?: string; name: string }, b: Record<string, unknown>, chat: string): Promise<{ status: number; body: unknown }> {
  const prompt = String(b.prompt ?? '').trim().slice(0, 1000);
  if (!prompt) return { status: 400, body: { error: 'Type a prompt first: what should the picture show?' } };
  // The Images window follows one picture drawn on another PC at a time; the queue runs one on each PC at once.
  if (awayJob && AWAY_RUNNING.includes(awayJob.state)) {
    const busyName = (await store.settings()).remotes.find(x => x.id === awayJob?.pc)?.name ?? 'another PC';
    return { status: 409, body: { error: awayJob.pc === away.r.id
      ? `${away.name}'s PC ("${away.r.name}") is busy drawing the last picture. Add this one to the queue: it is drawn when that one is done.`
      : `The Images window is following a picture being drawn on "${busyName}". Add this one to the queue: ${away.name} starts it on "${away.r.name}" at once.`, queue: true } };
  }
  const chosen = typeof b.mode === 'string' && b.mode !== 'auto' ? b.mode : detectMode(prompt, null).mode;
  const style = brains.styleOfMode(chosen as Mode);
  const size = (v: unknown) => (typeof v === 'number' && v >= 256 && v <= 2048 ? Math.round(v) : undefined);
  const job = { id: randomBytes(6).toString('hex'), pc: away.r.id, state: 'starting', step: 0, steps: 0, startedAt: Date.now(), etaSeconds: null as number | null, perStep: null as number | null, prompt,
    note: `Asking ${away.name} on "${away.r.name}" to draw it…` as string | null, error: null as string | null, results: [] as unknown[], chat: chat || null, ac: new AbortController() };
  awayJob = job;
  void (async () => {
    try {
      const got = await jobRoutes.drawOn(away.r, { prompt, style, width: size(b.width), height: size(b.height), ...(away.model ? { model: away.model } : {}) }, p => {
        if (typeof p.text === 'string') {
          job.state = 'starting';
          job.note = `${away.name} on "${away.r.name}": ${p.text}…`;
          return;
        }
        if (typeof p.state === 'string' && AWAY_RUNNING.includes(p.state)) job.state = p.state;
        if (typeof p.step === 'number') job.step = p.step;
        if (typeof p.steps === 'number') job.steps = p.steps;
        job.etaSeconds = typeof p.etaSeconds === 'number' ? p.etaSeconds : null;
        if (job.step > 0) job.perStep = (Date.now() - job.startedAt) / 1000 / job.step;
      }, job.ac.signal);
      const pic = await images.receive({ png: got.png, prompt, modelPrompt: got.modelPrompt, mode: got.mode, modelName: got.modelName, pc: away.r.name, seconds: got.seconds, chat: job.chat ?? undefined });
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

/** The linked PC the Images window's picture is being drawn on now (its id), or null: the queue waits for it. */
export const awayBusy = () => (awayJob && AWAY_RUNNING.includes(awayJob.state) ? awayJob.pc : null);

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
export async function queuedPicture(o: { prompt: string; as?: string; mode?: string; width?: number; height?: number }, signal: AbortSignal, progress: (p: Record<string, unknown>) => void): Promise<{ pic: Picture; where: string; by: string } | { error: string }> {
  const artist = o.as ? staff.get(o.as) ?? null : (await imageSpecialist()) ?? null;
  if (o.as && !artist) return { error: 'That artist is no longer on the team: add the picture again with another artist.' };
  const by = artist ? artist.name.split(/\s+/)[0] : 'The picture model';
  const refs = artist ? brains.refsOf(artist) : [];
  const first = refs[0] ? brains.parseRef(refs[0]) : null;
  const chosen = (o.mode && o.mode !== 'auto' ? o.mode : detectMode(o.prompt, null).mode) as Mode;
  if (first?.kind === 'remote') {
    const why: string[] = [];
    const away = await jobRoutes.pictureDrawer([refs[0]], false, why);
    if (!away) return { error: `${by} cannot draw now: ${why.join('; ') || 'their PC is off or not answering'}` };
    const recipe = artist ? images.recipe?.(artist.id) ?? null : null;
    const style = brains.styleOfMode(recipe?.mode ?? chosen) ?? (brains.isStyle(artist?.style) ? artist.style : null);
    // The artist's way of working goes with the words (that PC knows nothing about this team), unless a style is asked.
    const prompt = recipe?.boost && !style ? `${o.prompt.replace(/[\s,.]+$/, '')}, ${recipe.boost}` : o.prompt;
    progress({ text: `Asking "${away.r.name}" to draw it` });
    const got = await jobRoutes.drawOn(away.r, { prompt, style, width: o.width, height: o.height, ...(away.model ? { model: away.model } : {}), queue: true }, progress, signal);
    const pic = await images.receive({ png: got.png, prompt: o.prompt, modelPrompt: got.modelPrompt, mode: got.mode, modelName: got.modelName, pc: away.r.name, seconds: got.seconds });
    return { pic, where: `"${away.r.name}"`, by };
  }
  const v = images.pane.view;
  const want = first?.kind === 'here' ? first.id : v.state === 'connected' ? v.model ?? null : null;
  if (!want || !images.has(want)) return { error: artist ? `${by} has no picture model on this PC: give them one under Staff, then add it again.` : 'Nobody on the team draws, and no picture model is connected: hire an artist (Settings, Set up, Staff), then add it again.' };
  if (!(v.model === want && v.state === 'connected')) {
    const name = shortName(images.list().find(m => m.id === want)?.name) || 'the picture model';
    const dropped = await roomForPicture(want);
    progress({ text: `${dropped.length ? `Unloaded ${dropped.join(' and ')} to make room. ` : ''}Loading ${name}` });
    if (signal.aborted) return { error: 'Stopped.' };
    if (!(await loadImage(want))) return { error: `${name} did not load on this PC: it is busy with another picture, or too big for the memory free now` };
  }
  const job = await images.generate({ prompt: o.prompt, mode: o.mode && o.mode !== 'auto' ? (o.mode as Mode) : 'auto', width: o.width, height: o.height, drafts: 1, full: true, source: 'api', as: artist?.id });
  if (!('id' in job)) return { error: job.error };
  const timer = setInterval(() => {
    const j = images.jobView();
    if (j && j.id === job.id) progress({ state: j.state, step: j.step, steps: j.steps, etaSeconds: j.etaSeconds });
  }, 1000);
  const stop = () => void images.cancel(job.id).catch(() => undefined);
  signal.addEventListener('abort', stop, { once: true });
  await job.done.finally(() => {
    clearInterval(timer);
    signal.removeEventListener('abort', stop);
  });
  const pic = job.results[0];
  if (!pic) return { error: job.state === 'cancelled' ? 'Stopped.' : job.error ?? 'The picture did not come out.' };
  return { pic, where: 'this PC', by };
}

/** Every picture model in the registry, with the styles it is made for (registry recommendedModes). */
export function pictureModels(): brains.PictureModel[] {
  return images.list().map(m => ({ id: m.id, name: m.name, modes: images.registry.get(m.id)?.recommendedModes ?? [], installed: m.installed, bytes: m.bytes }));
}

/**
 * One picture for a linked PC, on the picture model connected here (F7 E2). It is drawn in memory and sent: it never
 * enters this PC's gallery or its folder, and this PC's Images pane shows only "Drawing for <that PC>".
 */
export async function drawForPc(o: { prompt: string; mode: string; width?: number; height?: number; forPc: string }, progress: (p: unknown) => void, signal: AbortSignal) {
  const job = await images.generate({ prompt: o.prompt, mode: o.mode as Mode, width: o.width, height: o.height, drafts: 1, source: 'api', forPc: o.forPc });
  if (!('id' in job)) return { error: job.error };
  const timer = setInterval(() => {
    const j = images.jobView();
    if (j && j.id === job.id) progress({ state: j.state, step: j.step, steps: j.steps, elapsed: j.elapsed, etaSeconds: j.etaSeconds, queued: j.queued });
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
  return { png: pic.png, modelName: pic.modelName.replace(/\s*\(.*\)$/, ''), modelPrompt: pic.modelPrompt, mode: pic.mode, seconds: pic.seconds };
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
export async function loadImage(id: string): Promise<boolean> {
  if (images.pane.view.model === id && images.pane.view.state === 'connected') return true;
  // Loading already (a Cancel loads the model again): waited for, not loaded a second time over it.
  if (!(images.pane.view.model === id && images.pane.view.state === 'loading')) {
    if (images.busy()) return false;
    const a = (await store.settings()).image;
    const r = await images.connect(id, a.asked, a.threads);
    if ('error' in r) return false;
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 10 * 60_000) {
    await new Promise(res => setTimeout(res, 400));
    const v = images.pane.view;
    if (v.model === id && v.state === 'connected') return true;
    if (v.model === id && (v.state === 'failed' || v.state === 'disconnected')) return false;
  }
  return false;
}

// ---- Routes ----

/** POST requests answered here, by path (the body is read already). */
export const picturesPost: Routes = {
  '/api/images/generate': async ({ res, b }) => {
    // {chat}: the chat the picture goes into ('' = none), named by the page: not whichever chat another window opened last.
    if (typeof b.chat !== 'string') return json(res, 400, { error: 'Nothing was drawn: this names no chat for the picture (the page may be from an older TOMLIN). Reload the page, then draw again.' });
    const chat = b.chat ? await chats.get(b.chat) : null;
    if (b.chat && !chat) return json(res, 404, { error: 'Nothing was drawn: that chat is not there any more (it may have been deleted in another window). Open a chat from the list, then draw again.' });
    // An artist's chat still called "New chat" is named after the first picture asked in it, once the picture has started.
    const name = () => (chat && isArtistWho(chat.who) && typeof b.prompt === 'string' && b.prompt.trim() ? chats.touch(chat.id, b.prompt) : null);
    const away = typeof b.as === 'string' && b.as ? await artistAway(b.as) : null;
    if (away) {
      const r = await startAway(away, b, chat?.id ?? '');
      if (r.status === 202) await name();
      return json(res, r.status, r.body);
    }
    // This PC is a node and a linked PC is drawing here (or has a picture model loaded here): asked first.
    const impact = jobRoutes.shareOn() && b.agree !== true ? jobRoutes.impactOf(null, true) : null;
    if (impact) return json(res, 409, { error: impact, impact });
    const r = await images.generate({ ...optionsFrom(b, 'page'), chat: chat?.id ?? '' });
    if (!('id' in r)) return json(res, r.status, { error: r.error });
    await name();
    return json(res, 202, { id: r.id, job: images.jobView() });
  },
  '/api/images/cancel': async ({ req, res, url, b }) => {
    if (awayJob && AWAY_RUNNING.includes(awayJob.state)) {
      awayJob.ac.abort();
      return json(res, 200, { ok: true });
    }
    if (await images.post(req, res, url, b)) return;
    return json(res, 404, { error: 'Not found.' });
  },
};
