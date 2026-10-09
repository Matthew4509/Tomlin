// The chat runners and the image pane: what is loaded, where a model goes, whether it fits, how each was started.
import { usedFromTimings } from '../meter.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { freemem } from 'node:os';
import { log } from '../log.ts';
import type { Gpu } from '../hardware.ts';
import { type Device, missingCardRunner } from '../runtimes.ts';
import { chatArgs, TEMPLATE_FAULT, whyItFailed } from '../llama.ts';
import { Pane } from '../pane.ts';
import * as runnersOf from '../runners.ts';
import { readings, streamChat } from '../engine.ts';
import type { Asked } from '../worker.ts';
import { Images } from '../images.ts';
import { TONES } from '../persona.ts';
import { cacheBytes, modelShape, type ModelShape } from '../gguf.ts';
import { DEFAULT_RUN, type RunOptions, type Settings } from '../store.ts';
import { shortBuild } from '../update.ts';
import { BUILD, GB, HOME, ROOT, type Routes, VERSION, apiError, body, cachedCopies, chatModels, gbText, hardware, hidden, json, publicSettings, runtimes, sampler, shortName, store } from './core.ts';
import { answeringBusy, endAnswer, stopOn, takeChat } from './answering.ts';
import { whoList } from './people.ts';
import { paneJob } from './pictures.ts';
import { readSpeedsNow } from './thispc.ts';
import { jobRoutes } from './jobs.ts';

// The chat runners (src/runners.ts): one llama-server per chat model loaded at once. A loaded model stays until it is
// dropped or another needs its place: the next model goes beside it when it fits, else the least recently used goes.
export const runners: Pane[] = [];
/** How each runner's model was started (context, cache), and when each last answered. */
const runnerRun = new Map<Pane, RunOptions>();
export const runnerUsed = new Map<Pane, number>();
function addRunner(): Pane {
  const p = new Pane('chat');
  p.onChange = view => {
    sampler.watch(watchedPids());
    if (view.state === 'connected') {
      runnerUsed.set(p, Date.now());
      if (view.model && view.loadSeconds) void store.saveSettings({ loadSeconds: { [`chat:${view.model}`]: view.loadSeconds } }).catch(e => console.error('Could not save the load time:', e));
    }
  };
  runners.push(p);
  return p;
}
addRunner();
export const watchedPids = () => [...runners.map(p => p.worker.pid), images.pane.worker.pid].filter((p): p is number => !!p);
/** Every runner as src/runners.ts sees it: the model, the memory it holds now, when it last answered, answering now. */
function runnerLooks(): runnersOf.RunnerLook[] {
  return runners.map(p => {
    const v = p.view;
    return { model: v.model ?? null, name: shortName(v.modelName ?? v.model ?? ''), state: v.state, ram: v.pid ? sampler.latest.processes[v.pid]?.ram ?? 0 : 0, usedAt: runnerUsed.get(p) ?? 0, busy: answeringBusy(p) };
  });
}
/** The runner that answers a chat with no model of its own (the manager, enhance, alt text, /v1 without a model). */
export const main = (): Pane => runners[runnersOf.mainIndex(runnerLooks(), store.peek()?.chat.model ?? null)];
/** The runner holding model `id` (connected or loading), or null. */
export const runnerFor = (id: string | null | undefined): Pane | null => (id ? runners.find(p => p.view.model === id && (p.view.state === 'connected' || p.view.state === 'loading')) ?? null : null);
/** What a runner's model was started with. */
export const runOn = (p: Pane): RunOptions => runnerRun.get(p) ?? { ...DEFAULT_RUN };
/** "The chat pane" for everything that has one model in mind: the main runner. */
export const chat = {
  get view() { return main().view; },
  get worker() { return main().worker; },
  disconnect: () => main().disconnect(),
  busy: () => main().busy(),
};
export const images = new Images({ root: ROOT, models: HOME.models, data: HOME.data, store, runtimes, hardware, sampler, chatPane: chat, devicesFor: (e, a) => devicesFor(e, a), fit: (b, p) => fit(b, p) });
// The folder chosen under Models > "Models in another folder" is searched for picture-model files too.
images.registry.copies = () => [...cachedCopies(), ...(chatModels.other() ? [chatModels.other()!] : [])];
const panes = { chat, image: images.pane };
/** When each pane was last used; "chat" is the main runner's (a hire's runner is marked where it answers). */
export const lastUsed = {
  image: 0,
  get chat() { return runnerUsed.get(main()) ?? 0; },
  set chat(t: number) { runnerUsed.set(main(), t); },
};

images.pane.onChange = view => {
  sampler.watch(watchedPids());
  if (view.state === 'connected') {
    lastUsed.image = Date.now();
    if (view.model && view.loadSeconds) void store.saveSettings({ loadSeconds: { [`image:${view.model}`]: view.loadSeconds } }).catch(e => console.error('Could not save the load time:', e));
  }
};

// ---- Status ----

/**
 * A runner's memory: `ram` (what Windows counts in its RAM), `gpu` (on a graphics card's own memory) and `borrowed` (the
 * graphics memory Windows calls shared: RAM the chip works from, already inside `ram`). In use = ram + gpu. Measured
 * 5 Oct 2026 on the HD 520: Gemma 2 2B held 2.76 GB of RAM and 2.67 GB shared, and Windows lost 2.7-2.8 GB, not 5.4.
 */
function paneStatus(pane: Pane) {
  const v = pane.view;
  const use = v.pid ? sampler.latest.processes[v.pid] : undefined;
  return { ...v, memory: use ? { ram: use.ram, gpu: use.gpuDedicated, borrowed: use.gpuShared } : null, idleMinutes: 0 };
}

/**
 * The chat pane as the open chat sees it: the runner of the model this chat answers on (the one picked for it). When
 * that model is not loaded, the pane says Disconnected for it, and a model loaded for someone else is listed beside it,
 * not shown as this chat's (it would read as Connected, and Disconnect would drop someone else's model).
 */
function chatPaneFor(s: Settings) {
  const m = main();
  const want = s.chat.model;
  const elsewhere = !!want && !!m.view.model && m.view.model !== want && m.view.state !== 'disconnected';
  const base = { idleMinutes: s.chat.idleMinutes, threadsSetting: s.chat.threads };
  if (!elsewhere) return { pane: { ...paneStatus(m), ...base, working: answeringBusy(m) }, beside: (p: Pane) => p !== m };
  const name = want.split('/').pop()?.replace(/\.gguf$/i, '') ?? null;
  return {
    pane: { ...paneStatus(m), ...base, state: 'disconnected' as const, model: want, modelName: name, pid: null, device: null, error: null, detail: null, note: null, stage: null, lastUnload: null, loadStartedAt: null, memory: null, working: false },
    beside: () => true,
  };
}

async function status() {
  // Watch the worker processes from the moment they start (their memory shows while they load, too).
  sampler.watch(watchedPids());
  const s = await store.settings();
  const here = chatPaneFor(s);
  return {
    version: VERSION,
    // What code this copy is, 7 characters (src/update.ts buildId; '' for the first moment after start).
    build: shortBuild(BUILD),
    hardware: sampler.latest,
    gpus: hardware.gpus,
    panes: {
      // working: answering, running a job step or drawing now (the top bar asks before dropping it).
      chat: here.pane,
      // The chat models loaded beside the open chat's (two or more chat models on this PC).
      chatAlso: runners.filter(p => here.beside(p) && p.view.model && (p.view.state === 'connected' || p.view.state === 'loading')).map(p => { const st = paneStatus(p); return { model: st.model, modelName: st.modelName, state: st.state, device: st.device, memory: st.memory, working: answeringBusy(p) }; }),
      image: { ...paneStatus(images.pane), idleMinutes: s.image.idleMinutes, threadsSetting: s.image.threads, job: paneJob(), working: images.busy() },
    },
    serving: jobRoutes.servingNow(),
  };
}

// ---- Models and fit ----

/** Will a model of `bytes` fit in what is free now? Counts back what this pane's own loaded model would free. */
export function fit(bytes: number, pane: 'chat' | 'image') {
  // Chat: what the model that would be swapped out frees (the least recently used one not answering).
  const out = pane === 'chat' ? runnerLooks().filter(r => r.model && r.state === 'connected' && !r.busy).sort((a, b) => a.usedAt - b.usedAt)[0] : null;
  const own = pane === 'chat' ? out?.ram ?? 0 : panes[pane].view.pid ? sampler.latest.processes[panes[pane].view.pid!]?.ram ?? 0 : 0;
  const free = freemem() + own;
  // A chat model on a card of its own needs RAM only for what does not fit on the card (PLAN F8): the cards' memory,
  // less llama.cpp's margin of 1 GB on each, less what the other loaded models already hold there. An estimate:
  // other programs on the card are not counted, and llama.cpp's own fit reads the real free memory when it loads.
  const cards = pane === 'chat' ? chatCards() : [];
  const held = cards.length ? [...runners.filter(p => p.view.model && p.view.model !== out?.model), images.pane].reduce((n, p) => n + (p.view.pid ? sampler.latest.processes[p.view.pid]?.gpuDedicated ?? 0 : 0), 0) : 0;
  const card = Math.max(0, cards.reduce((n, g) => n + (g.total ?? 0) - GB, 0) - held);
  const need = Math.max(0.8 * GB, bytes * 1.1 + 0.8 * GB - card);
  const other = pane === 'chat' ? images.pane : chat;
  const otherOn = other.view.state === 'connected' || other.view.state === 'loading';
  if (need <= free) return { level: 'ok' as const, need, free, otherOn, card };
  if (need <= free + 2 * GB) return { level: 'tight' as const, need, free, otherOn, card };
  return { level: 'no' as const, need, free, otherOn, card };
}

// ---- How each chat model is started: context size, cache type, experts in RAM ----

/** Context sizes offered (tokens). */
const CONTEXTS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
/** Each chat model's shape (layers, heads...), read from its header once; null when it could not be read. */
const shapes = new Map<string, ModelShape | null>();
export async function loadShapes(): Promise<void> {
  for (const m of chatModels.list()) {
    if (shapes.has(m.id)) continue;
    const path = chatModels.path(m.id);
    shapes.set(m.id, path ? await modelShape(path) : null);
  }
}
void loadShapes().catch(() => undefined);

export const runOf = (s: Settings, id: string): RunOptions => {
  const r = s.run[id] as (Partial<RunOptions> & { cpuMoe?: boolean }) | undefined;
  // Saved before F8: the "expert weights in RAM" tick.
  return { ctx: r?.ctx ?? DEFAULT_RUN.ctx, cache: r?.cache ?? DEFAULT_RUN.cache, place: r?.place ?? (r?.cpuMoe ? 'ram' : DEFAULT_RUN.place) };
};

/** Graphics cards with memory of their own that chat can use now (CUDA: NVIDIA only); none when Run on is CPU. */
export function chatCards(): Gpu[] {
  const asked = store.peek()?.chat.asked ?? 'auto';
  if (asked === 'cpu') return [];
  const devices = devicesFor('llama', asked);
  return hardware.gpus.filter(g => !g.integrated && (g.total ?? 0) > 0 && ((devices.includes('cuda') && g.vendor === 'nvidia') || devices.includes('vulkan')));
}
/** True when `device` is a graphics card with memory of its own (Auto lets llama.cpp fit the model to it). */
const cardFor = (device: Device) => device !== 'cpu' && hardware.gpus.some(g => !g.integrated && (g.total ?? 0) > 0 && (device !== 'cuda' || g.vendor === 'nvidia'));
/** How the connected chat model was started (for the jobs' room in the context and the worker's hello). */

export function cleanRun(raw: unknown): RunOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ctx = CONTEXTS.includes(Number(r.ctx)) ? Number(r.ctx) : DEFAULT_RUN.ctx;
  const cache = r.cache === 'q8_0' || r.cache === 'q4_0' ? r.cache : 'f16';
  const place = r.place === 'card' || r.place === 'ram' || r.place === 'auto' ? r.place : r.cpuMoe === true ? 'ram' : 'auto';
  return { ctx, cache, place };
}

/** Bytes the context cache takes for this model and options (0 when its shape is unknown). */
export function contextBytes(id: string, run: RunOptions): number {
  const s = shapes.get(id);
  return s ? cacheBytes(s, run.ctx, run.cache) : 0;
}

export function chatList() {
  const s = store.peek();
  return chatModels.list().map(m => {
    const run = s ? runOf(s, m.id) : { ...DEFAULT_RUN };
    const shape = shapes.get(m.id);
    // What each context size costs in memory, for the settings hint (only sizes the model was trained for, and 8k).
    const cost = shape ? Object.fromEntries((['f16', 'q8_0', 'q4_0'] as const).map(c => [c, Object.fromEntries(CONTEXTS.filter(n => n <= Math.max(8192, shape.trainedContext || 8192)).map(n => [n, Math.round(cacheBytes(shape, n, c))]))])) : null;
    return { id: m.id, name: m.file.split('/').pop()!.replace(/\.gguf$/i, ''), bytes: m.bytes, where: m.where, fit: fit(m.bytes + contextBytes(m.id, run), 'chat'), run, trained: shape?.trainedContext ?? null, moe: (shape?.experts ?? 0) > 0, places: placesHere(m.id), cost, reading: readSpeedsNow()[m.id] ?? null };
  });
}

/**
 * Devices to try, best first. Auto skips a graphics chip built into the processor for chat: on the Intel HD 520 the
 * CPU read prompts four times faster and wrote faster too (measured 3 Oct 2026); GPU still uses it when chosen.
 */
function devicesFor(engine: 'llama' | 'sd', asked: Asked): Device[] {
  const gpu: Device[] = [];
  if (hardware.gpus.some(g => g.vendor === 'nvidia') && runtimes.installed(engine, 'cuda')) gpu.push('cuda');
  if (hardware.gpus.length && runtimes.installed(engine, 'vulkan')) gpu.push('vulkan');
  const cpu: Device[] = runtimes.installed(engine, 'cpu') ? ['cpu'] : [];
  if (asked === 'cpu') return cpu;
  if (asked === 'gpu') return gpu;
  if (autoSkipsGpu(engine)) return cpu.length ? cpu : gpu;
  return [...gpu, ...cpu];
}

/** True when Auto should use the CPU even though a graphics chip is there (only a built-in one, for chat). */
function autoSkipsGpu(engine: 'llama' | 'sd'): boolean {
  return engine === 'llama' && hardware.gpus.length > 0 && hardware.gpus.every(g => g.integrated);
}

function runtimeList() {
  return Object.entries(runtimes.pins).map(([id, p]) => ({ id, engine: p.engine, device: p.device, name: p.name, bytes: runtimes.bytes(p.engine, p.device), installed: runtimes.installed(p.engine, p.device) }));
}

/**
 * Where a chat model would load (src/runners.ts): the runner that has it, a runner beside the loaded ones when it fits,
 * or the place of the least recently used one not answering. An error in plain words when it does not fit.
 */
export function chatPlace(id: string): runnersOf.Place {
  const entry = chatModels.list().find(m => m.id === id);
  if (!entry) return { error: `The model ${id} is not in the models folder any more. Pick another.` };
  const s = store.peek();
  const run = s ? runOf(s, id) : { ...DEFAULT_RUN };
  return runnersOf.place(id, shortName(entry.file.split('/').pop()!.replace(/\.gguf$/i, '')), chatNeed(entry.bytes, contextBytes(id, run)), freemem(), runnerLooks());
}

/** The memory a chat model is expected to need: its file and context cache, a tenth more, and 0.8 GB for the runner. */
const chatNeed = (file: number, cache: number) => (file + cache) * 1.1 + 0.8 * GB;

/**
 * Starts loading a chat model in the runner chatPlace picks (returns at once; the runner's state shows progress).
 * `main`: picked in the chat pane, so the manager answers on it from now on (a hire's model loads beside it or swaps).
 */
/** One placement at a time: two loads asked together (a job step and a node's switch) never pick the same runner. */
let placing: Promise<unknown> = Promise.resolve();
export function connectChat(id: string, asked: Asked, threads: number, main = false): Promise<{ ok: true; runner: Pane } | { error: string }> {
  const turn = placing.then(() => placeChat(id, asked, threads, main));
  placing = turn.catch(() => undefined);
  return turn;
}

async function placeChat(id: string, asked: Asked, threads: number, main: boolean): Promise<{ ok: true; runner: Pane } | { error: string }> {
  const path = chatModels.path(id);
  if (!path) return { error: `The model ${id} is not in the models folder any more. Pick another.` };
  const entry = chatModels.list().find(m => m.id === id)!;
  const name = entry.file.split('/').pop()!.replace(/\.gguf$/i, '');
  const s = await store.settings();
  const at = chatPlace(id);
  if ('error' in at) return at;
  await store.saveSettings({ chat: main || !s.chat.model ? { model: id, asked, threads } : { asked, threads } });
  const runner = runners[at.index] ?? addRunner();
  if (at.already) return { ok: true, runner };
  const expected = s.loadSeconds[`chat:${id}`] ?? Math.round(entry.bytes / (150 * 2 ** 20)) + 4;
  const ready = async (port: number) => (await fetch(`http://127.0.0.1:${port}/health`)).ok;
  const run = runOf(s, id);
  runnerRun.set(runner, run);
  const beside = at.replaces === null ? runners.filter(p => p !== runner && p.view.state === 'connected').map(p => ({ name: shortName(p.view.modelName ?? '') })) : [];
  const notes = [
    asked !== 'cpu' ? missingCardRunner('llama', hardware.gpus, d => runtimes.installed('llama', d)) : '',
    asked === 'auto' && autoSkipsGpu('llama') ? `Auto picked the CPU: faster for chat than the built-in graphics chip (choose GPU to use it anyway).` : '',
    run.ctx !== DEFAULT_RUN.ctx || run.cache !== 'f16' ? `Context ${run.ctx.toLocaleString()} tokens${run.cache !== 'f16' ? `, ${run.cache} cache` : ''}.` : '',
    asked === 'cpu' ? '' : run.place === 'ram' ? 'Expert weights in RAM, the rest on the graphics card.' : run.place === 'card' ? 'Every layer on the graphics chip.' : chatCards().length ? `Auto: llama.cpp fills ${chatCards().length > 1 ? `the ${chatCards().length} graphics cards` : 'the graphics card'} and puts what does not fit in RAM.` : '',
    beside.length ? `Loaded beside ${runnersOf.namesOf(beside)}.` : '',
  ].filter(Boolean);
  const loading = runner.connect({
    model: id,
    modelName: name,
    asked,
    threads,
    devices: devicesFor('llama', asked),
    expectedSeconds: expected,
    build: device => ({ exe: runtimes.exe('llama', device)!, args: port => chatArgs(path, port, device, threads, false, run, cardFor(device)), ready, device, timeoutSeconds: 600 }),
    retry: (device, tail) => (TEMPLATE_FAULT.test(tail) ? { exe: runtimes.exe('llama', device)!, args: port => chatArgs(path, port, device, threads, true, run, cardFor(device)), ready, device, timeoutSeconds: 600 } : null),
    why: whyItFailed,
    note: notes.join(' ') || undefined,
  });
  // What it holds once loaded, beside what was expected, goes in the log: a fit refusal that looked wrong (a model
  // refused, then loaded once memory was freed) can be checked against the real figure.
  void loading.then(async () => {
    await new Promise(r => setTimeout(r, 15_000));
    const use = runner.view.pid && runner.view.model === id ? sampler.latest.processes[runner.view.pid] : undefined;
    if (!use) return;
    const cache = contextBytes(id, run);
    log.info('fit', `${name}: expected ${gbText(chatNeed(entry.bytes, cache))} (file ${gbText(entry.bytes)}, context cache ${gbText(cache)} for ${run.ctx.toLocaleString()} tokens); holds ${gbText(use.ram + use.gpuDedicated)} once loaded (${gbText(use.ram)} in RAM, ${gbText(use.gpuDedicated)} on a graphics card).`);
  }).catch(() => undefined);
  // The next placement waits until this runner shows as loading (after any old model is unloaded), or 30 s at most.
  let settled = false;
  void loading.catch(() => undefined).finally(() => { settled = true; });
  for (let t = 0; !settled && runner.view.state !== 'loading' && t < 600; t++) await new Promise(r => setTimeout(r, 50));
  return { ok: true, runner };
}

// ---- Try each way (PLAN F8 M3): load a chat model each way it can be placed on this PC, measure, keep the fastest ----

const PLACE_WORDS: Record<RunOptions['place'], string> = { auto: 'Auto (fill the card, the rest in RAM)', card: 'Every layer on the graphics chip', ram: 'Expert weights in RAM' };
type TryRow = { place: RunOptions['place']; words: string; perSecond: number | null; note: string };
let tryJob: { id: string; name: string; rows: TryRow[]; state: 'running' | 'done' | 'stopped'; now: string; was: RunOptions['place']; best: RunOptions['place'] | null } | null = null;
let tryStopped = false;
/** The measuring answer of the try running now: Stop ends it at once. */
let tryAnswer: AbortController | null = null;

/** The ways a chat model can be placed here that really differ: none without a card of its own (or with Run on: CPU). */
function placesHere(id: string): RunOptions['place'][] {
  // TOMLIN_TRY_ALL: a test copy on a PC without such a card still runs the steps (each way then loads the same).
  if (!chatCards().length && process.env.TOMLIN_TRY_ALL !== '1') return [];
  return (shapes.get(id)?.experts ?? 0) > 0 ? ['auto', 'card', 'ram'] : ['auto', 'card'];
}

function tryView() {
  return tryJob ? { ...tryJob, rows: tryJob.rows } : null;
}

/** Loads `id` each way in turn on the main runner, asks for about 80 words each time, then keeps the fastest way. */
async function tryPlaces(id: string): Promise<void> {
  const entry = chatModels.list().find(m => m.id === id)!;
  const places = placesHere(id);
  tryJob = { id, name: shortName(entry.file), rows: [], state: 'running', now: 'Starting…', was: runOf(store.peek()!, id).place, best: null };
  tryStopped = false;
  const job = tryJob;
  const setPlace = async (place: RunOptions['place']) => store.saveSettings({ run: { [id]: { ...runOf(await store.settings(), id), place } } });
  const load = async (place: RunOptions['place']) => {
    await setPlace(place);
    const holder = runnerFor(id);
    // A chat (or a step) answering on this model now is never cut off for a measurement: the try stops instead.
    if (holder && answeringBusy(holder)) return { error: 'busy' as const };
    if (holder) await holder.disconnect();
    const s = await store.settings();
    const c = await connectChat(id, s.chat.asked, s.chat.threads, true);
    if ('error' in c) return { error: c.error };
    for (let t = 0; t < 1800 && c.runner.view.state === 'loading' && !tryStopped; t++) await new Promise(r => setTimeout(r, 500));
    return c.runner.view.state === 'connected' && c.runner.worker.base ? { runner: c.runner } : { error: c.runner.view.error ?? 'It did not load this way.' };
  };
  try {
    for (const place of places) {
      if (tryStopped) break;
      job.now = `Loading it: ${PLACE_WORDS[place]}…`;
      const l = await load(place);
      if ('error' in l && l.error === 'busy') {
        tryStopped = true;
        job.rows.push({ place, words: PLACE_WORDS[place], perSecond: null, note: 'Stopped: someone started answering on this model, and a measurement would have cut them off.' });
        break;
      }
      if ('error' in l) {
        job.rows.push({ place, words: PLACE_WORDS[place], perSecond: null, note: tryStopped ? 'Stopped.' : l.error ?? 'It did not load this way.' });
        continue;
      }
      if (tryStopped) break;
      job.now = `Measuring: ${PLACE_WORDS[place]}…`;
      const ac = new AbortController();
      tryAnswer = ac;
      takeChat(ac, l.runner, '', '', 'Try each way');
      const timer = setTimeout(() => ac.abort(), 300_000);
      try {
        const r = await streamChat(l.runner.worker.base!, id, [{ role: 'user', content: 'Write about 80 words on why people bake their own bread. Plain sentences.' }], () => undefined, ac.signal, 100);
        const st = paneStatus(l.runner).memory;
        const where = st ? [st.gpu > 64 * 2 ** 20 ? `${gbText(st.gpu)} on the graphics card` : '', `${gbText(st.ram)} in RAM${st.borrowed > 64 * 2 ** 20 ? ` (${gbText(st.borrowed)} of it for the graphics chip)` : ''}`].filter(Boolean).join(', ') : '';
        job.rows.push({ place, words: PLACE_WORDS[place], perSecond: r.perSecond ? Math.round(r.perSecond * 10) / 10 : null, note: where });
      } catch (error) {
        job.rows.push({ place, words: PLACE_WORDS[place], perSecond: null, note: tryStopped ? 'Stopped.' : `The measuring stopped: ${(error as Error).message}` });
      } finally {
        clearTimeout(timer);
        endAnswer(ac);
        tryAnswer = null;
      }
    }
    // The fastest, unless the way chosen before is within 5% of it (a difference that small is noise).
    const fastest = [...job.rows].filter(r => r.perSecond).sort((a, b) => b.perSecond! - a.perSecond!)[0] ?? null;
    const before = job.rows.find(r => r.place === job.was && r.perSecond);
    job.best = tryStopped || !fastest ? null : before && before.perSecond! * 1.05 >= fastest.perSecond! ? before.place : fastest.place;
    if (tryStopped) {
      // Stopped: the way chosen before is kept (from the next Connect); whatever is loaded stays as it is.
      await setPlace(job.was);
    } else {
      // Kept: the fastest way (the one before when nothing could be measured), loaded that way if it is not already.
      const keep = job.best ?? job.was;
      if (runOf(await store.settings(), id).place !== keep) {
        job.now = `Loading it again: ${PLACE_WORDS[keep]}…`;
        await load(keep);
      }
    }
    job.state = tryStopped ? 'stopped' : 'done';
    job.now = '';
  } catch (error) {
    job.state = 'stopped';
    job.now = `Stopped: ${(error as Error).message}`;
    await setPlace(job.was).catch(() => undefined);
  }
}

/** OpenAI-compatible chat for other apps: passed through to the connected model. Never loads one by itself. */
export async function openAiChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await body(req);
  // "model" names one of the chat models loaded here (two or more can be); otherwise the main one answers.
  const runner = (typeof b.model === 'string' ? runners.find(p => p.view.state === 'connected' && p.view.model === b.model) : undefined) ?? main();
  if (runner.view.state !== 'connected' || !runner.worker.base) return apiError(res, 409, 'TOMLIN\'s chat pane is not connected. Connect a model in TOMLIN (or POST /api/models/{id}/load) first; nothing loads by itself.', 'model_not_loaded');
  runnerUsed.set(runner, Date.now());
  // Counted as answering on its runner (idle unload and placing a new model leave it alone), and ended when the
  // program stops asking.
  const ac = new AbortController();
  takeChat(ac, runner, '', '', 'A program asking through /v1');
  res.once('close', () => ac.abort());
  try {
    const upstream = await fetch(`${runner.worker.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b), signal: ac.signal });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
    // Passed through as it comes; its end is kept to read llama.cpp's timings, so the answer counts on this PC (src/meter.ts).
    const dec = new TextDecoder();
    let tail = '';
    if (upstream.body) for await (const c of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      res.write(c);
      tail = (tail + dec.decode(c, { stream: true })).slice(-8000);
    }
    const t = [...tail.matchAll(/"timings"\s*:\s*(\{[^{}]*\})/g)].at(-1)?.[1];
    const used = t ? usedFromTimings((() => { try { return JSON.parse(t); } catch { return null; } })()) : null;
    if (used) readings.used?.(runner.view.model ?? '', used);
  } catch (error) {
    if (!ac.signal.aborted && !res.headersSent) return apiError(res, 502, `The model stopped answering: ${(error as Error).message}`, 'model_failed');
  } finally {
    endAnswer(ac);
    runnerUsed.set(runner, Date.now());
    if (!res.writableEnded) res.end();
  }
}

// ---- Idle unload (off unless set) ----

setInterval(async () => {
  const s = await store.settings();
  // Every chat runner on its own clock (the chat idle setting), and the image pane.
  for (const [name, pane] of [...runners.map(p => ['chat', p] as const), ['image', images.pane] as const]) {
    const minutes = s[name].idleMinutes;
    const busy = name === 'chat' ? answeringBusy(pane) : images.busy();
    const used = name === 'chat' ? runnerUsed.get(pane) ?? 0 : lastUsed.image;
    if (minutes > 0 && pane.view.state === 'connected' && !busy && Date.now() - Math.max(used, images.lastUsedAt(name)) > minutes * 60_000) {
      console.log(`Unloading the ${name} model after ${minutes} idle minutes.`);
      await pane.disconnect();
    }
  }
}, 30_000).unref();

export const threadsOf = (v: unknown) => Math.max(0, Math.min(hardware.threads, Math.floor(Number(v) || 0)));
export const askedOf = (v: unknown): Asked => (v === 'gpu' || v === 'cpu' ? v : 'auto');

/** Load or unload one model: POST /api/models/<id>/load or /unload. */
export async function loadModel(load: RegExpExecArray, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const id = decodeURIComponent(load[1]);
  const b = await body(req);
  const pane = images.has(id) ? 'image' : chatModels.path(id) ? 'chat' : null;
  if (!pane) return json(res, 404, { error: `There is no model ${id}.` });
  // A chat model is in the runner that holds it (two or more chat models can be loaded at once).
  const held = pane === 'chat' ? runnerFor(id) : panes.image.view.model === id ? panes.image : null;
  if (load[2] === 'unload') {
    if (!held) return json(res, 409, { error: `${id} is not loaded.` });
    // Unloaded, it stays unloaded: a picture being drawn is cancelled without loading the model again.
    if (pane === 'image') await images.cancel(undefined, { restart: false });
    else stopOn(held);
    return json(res, 200, await held.disconnect());
  }
  if (held?.busy() || (pane === 'image' && panes.image.busy())) return json(res, 409, { error: `The ${pane} pane is busy (${(held ?? panes.image).view.state}). Wait a moment.` });
  // Loading another picture model would end the picture being drawn now.
  if (pane === 'image' && !held && images.busy()) return json(res, 409, { error: 'A picture is being drawn. Wait for it to finish (or press Cancel), then load another picture model.' });
  // This PC is a node and the load would push out a model a linked PC is using: asked first (the page shows why).
  const impact = jobRoutes.shareOn() && b.agree !== true && !held ? jobRoutes.impactOf(pane === 'chat' ? id : null, pane === 'image') : null;
  if (impact) return json(res, 409, { error: impact, impact });
  const asked = askedOf(b.device);
  const threads = threadsOf(b.threads);
  // From the chat pane (or a program): the manager answers on it. main: false (a hire's Load it) loads it for them only.
  const r = pane === 'chat' ? await connectChat(id, asked, threads, b.main !== false) : await images.connect(id, asked, threads);
  if ('error' in r) return json(res, 400, r);
  const held2 = pane === 'chat' && 'runner' in r ? (r as { runner: Pane }).runner : panes.image;
  return json(res, 202, { ok: true, pane, state: held2.view.state });
}

/** POST /api/panes/<chat|image>/unload. */
export async function unloadPane(paneOff: RegExpExecArray, res: ServerResponse): Promise<void> {
  if (paneOff[1] === 'image') await images.cancel(undefined, { restart: false });
  if (paneOff[1] === 'chat') stopOn(main());
  return json(res, 200, await panes[paneOff[1] as 'chat' | 'image'].disconnect());
}

// ---- Routes ----

/** GET requests answered here, by path. */
export const panesGet: Routes = {
  '/api/status': async ({ res }) => json(res, 200, await status()),
  '/api/models': async ({ res }) => {
    await loadShapes();
    return json(res, 200, { chat: chatList().map(m => ({ ...m, hidden: hidden.has(m.id) })), image: images.list().map(m => ({ ...m, hidden: hidden.has(m.id) })), runtimes: runtimeList(), folder: chatModels.other(), ownFolder: chatModels.own, copies: cachedCopies(), hardware, settings: publicSettings(await store.settings()), who: whoList(), tones: TONES.map(({ id, name }) => ({ id, name })), contexts: CONTEXTS });
  },
  '/api/place/try': async ({ res }) => json(res, 200, { job: tryView() }),
  '/v1/models': async ({ res }) => json(res, 200, { object: 'list', data: [chat, images.pane].filter(x => x.view.state === 'connected').map(x => ({ id: x.view.model, object: 'model', owned_by: 'tomlin' })) }),
};

/** POST requests answered here, by path (the body is read already). */
export const panesPost: Routes = {
  '/api/place/try': async ({ res, b }) => {
    if (b.stop === true) {
      tryStopped = true;
      tryAnswer?.abort();
      return json(res, 200, { job: tryView() });
    }
    if (tryJob?.state === 'running') return json(res, 409, { error: 'A try is already running. Wait for it, or stop it first.' });
    const id = String(b.id ?? '');
    if (!chatModels.list().some(m => m.id === id)) return json(res, 400, { error: 'Pick a chat model first.' });
    await loadShapes();
    if (placesHere(id).length < 2) return json(res, 400, { error: 'On this PC the model can only run one way (it needs a graphics card with memory of its own, and Run on: Auto or GPU).' });
    if ((main().view.state === 'connected' && answeringBusy(main())) || answeringBusy(runnerFor(id))) return json(res, 409, { error: 'The chat model is answering something. Wait for it to finish, then try again.' });
    void tryPlaces(id).catch(() => undefined);
    return json(res, 202, { job: tryView() });
  },
};
