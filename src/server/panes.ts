// The chat runners and the image pane: what is loaded, where a model goes, whether it fits, how each was started.
import { usedFromTimings } from '../meter.ts';
import { cardFit } from '../calc.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { freemem } from 'node:os';
import { dirname, join } from 'node:path';
import type { RpcProgram } from '../maxlend.ts';
import { builtInListed, cardsOf, listDevices, listSdDevices, pickSdDevice, startCards, type Card } from '../devices.ts';
import { runnerEnv } from '../worker.ts';
import { log } from '../log.ts';
import type { Gpu } from '../hardware.ts';
import { buildFits, ccFromName, cudaOrder, type Device, type GpuFacts, firstStartNote, missingCardRunner, RUNNER_NAMES, RUNNER_PINS, runnerDevice, runnerOfPin, type RunnerName, tccNote } from '../runtimes.ts';
import { noCardStart } from '../runnerpush.ts';
import { chatArgs, TEMPLATE_FAULT, whyItFailed } from '../llama.ts';
import { Pane } from '../pane.ts';
import * as runnersOf from '../runners.ts';
import { readings, runnerJson, streamChat } from '../engine.ts';
import { runnerHeaders } from '../runnerkeys.ts';
import type { Asked } from '../worker.ts';
import { Images } from '../images.ts';
import { TONES } from '../persona.ts';
import { cacheBytes, modelShape, type ModelShape } from '../gguf.ts';
import { cleanRunWith, devicesForRun, guessersFor } from '../runset.ts';
import { cleanFoldWait } from '../layers.ts';
import { DEFAULT_RUN, type RunOptions, type Settings } from '../store.ts';
import { shortBuild } from '../update.ts';
import { BUILD, GB, HOME, ROOT, type Routes, VERSION, apiError, body, cachedCopies, chatModels, gbText, hardware, hidden, json, publicSettings, runtimes, sampler, shortName, store } from './core.ts';
import { answeringBusy, endAnswer, stopOn, takeChat } from './answering.ts';
import { whoList } from './people.ts';
import { paneJob } from './pictures.ts';
import { readSpeedsNow } from './thispc.ts';
import { jobRoutes } from './jobs.ts';
import { maxPcs, rpcFor } from '../jobrun/maxhost.ts';

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
export const images = new Images({ root: ROOT, models: HOME.models, data: HOME.data, store, runtimes, hardware, sampler, chatPane: chat, devicesFor: (e, a) => devicesFor(e, a), sdDevice: d => sdDevice(d), fit: (b, p) => fit(b, p) });
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
    // A4: new PCs asking for a linked PC's backups kept here, for the pop-up (the Network page lists them too).
    claims: jobRoutes.claimsWaiting(),
  };
}

// ---- Models and fit ----

/** Will a model of `bytes` fit in what is free now? Counts back what this pane's own loaded model would free. */
/**
 * Card choice (src/devices.ts): the graphics cards this PC's card runners can use, biggest first, read once from each
 * installed runner (and again when the runners installed change). Empty until read, or with no card of its own.
 */
let cardList: Card[] = [];
let cardsRead: { key: string; done: Promise<Card[]> } | null = null;
/** A runner lists a chip built into the processor: a chat start then names the cards (devices.ts startCards). */
let builtInHere = false;
/**
 * A card runner that cannot use any card here, and why: its own device list was empty (a CUDA build with no NVIDIA
 * driver, or none for the card), or a start of it said so (runnerpush.noCardStart). Auto skips it until the runners
 * installed here change; it is never tried only to load the model on the CPU.
 */
const noCard = new Map<Device, string>();
export function readCards(): Promise<Card[]> {
  const exes = (['cuda', 'vulkan'] as const).map(d => ({ d, exe: hardware.gpus.length ? runtimes.exe('llama', d) : null })).filter((x): x is { d: 'cuda' | 'vulkan'; exe: string } => !!x.exe && (x.d !== 'cuda' || hardware.gpus.some(g => g.vendor === 'nvidia')));
  const key = exes.map(x => x.exe).join('|');
  if (cardsRead?.key !== key) {
    noCard.clear();
    cardsRead = {
      key,
      done: Promise.all(exes.map(x => listDevices(x.exe, runnerEnv(x.d)))).then(lists => {
        // An NVIDIA card here that the CUDA runner does not list: that runner cannot use it.
        const at = exes.findIndex(x => x.d === 'cuda');
        if (at >= 0 && !lists[at].length && cardsRead?.key === key) noCard.set('cuda', `the CUDA runner (${runtimes.pins[runtimes.id('llama', 'cuda')]?.name ?? 'CUDA'}) lists no card it can use on this PC`);
        const integrated = hardware.gpus.filter(g => g.integrated).map(g => g.name);
        builtInHere = builtInListed(lists, integrated);
        return (cardList = cardsOf(lists, integrated));
      }),
    };
  }
  return cardsRead.done;
}
/**
 * The picture runner's own device list per installed card build (sd-server --list-devices), read once per program.
 * A CUDA picture runner that lists no CUDA device cannot use any card here: pictures skip it (audit C6), as chat does
 * with noCard, instead of a failed start before Vulkan at every Connect.
 */
const sdLists = new Map<string, Promise<{ name: string; desc: string }[]>>();
const noPictureCard = new Map<Device, string>();
function sdDevices(device: Device): Promise<{ name: string; desc: string }[]> {
  const exe = device === 'cpu' ? null : runtimes.exe('sd', device);
  if (!exe) return Promise.resolve([]);
  let read = sdLists.get(exe);
  if (!read) {
    read = listSdDevices(exe, runnerEnv(device)).then(list => {
      if (device === 'cuda' && !list.some(d => /^CUDA\d/i.test(d.name))) noPictureCard.set('cuda', `the CUDA picture runner lists no card it can use on this PC`);
      else noPictureCard.delete(device);
      return list;
    });
    sdLists.set(exe, read);
  }
  return read;
}
/** The device a picture model is held to on `device`'s runner (src/devices.ts pickSdDevice), or null. */
export const sdDevice = async (device: Device) => pickSdDevice(await sdDevices(device), hardware.gpus);

/** The cards as last read (reading them again in the background when the runners changed). */
export function cardsNow(): Card[] {
  void readCards();
  return cardList;
}
/** The memory of the cards a model may use: the ones chosen for it when any of them is here, else every chat card. */
function cardBytesFor(ids: string[] | undefined): number[] {
  const chosen = ids?.length ? cardList.filter(c => c.ids.some(id => ids.includes(id))) : [];
  return chosen.length ? chosen.map(c => c.total) : chatCards().map(g => g.total ?? 0);
}

export function fit(bytes: number, pane: 'chat' | 'image', cardIds?: string[]) {
  // Chat: what the model that would be swapped out frees (the least recently used one not answering).
  const out = pane === 'chat' ? runnerLooks().filter(r => r.model && r.state === 'connected' && !r.busy).sort((a, b) => a.usedAt - b.usedAt)[0] : null;
  const own = pane === 'chat' ? out?.ram ?? 0 : panes[pane].view.pid ? sampler.latest.processes[panes[pane].view.pid!]?.ram ?? 0 : 0;
  const free = freemem() + own;
  // A chat model on a card of its own needs RAM only for what does not fit on the card (PLAN F8): the cards' memory,
  // less llama.cpp's margin of 1 GB on each, less what the other loaded models already hold there. An estimate:
  // other programs on the card are not counted, and llama.cpp's own fit reads the real free memory when it loads.
  const cards = pane === 'chat' ? cardBytesFor(cardIds) : [];
  const held = cards.length ? [...runners.filter(p => p.view.model && p.view.model !== out?.model), images.pane].reduce((n, p) => n + (p.view.pid ? sampler.latest.processes[p.view.pid]?.gpuDedicated ?? 0 : 0), 0) : 0;
  const card = Math.max(0, cards.reduce((n, total) => n + total - GB, 0) - held);
  const need = Math.max(0.8 * GB, bytes * 1.1 + 0.8 * GB - card);
  const other = pane === 'chat' ? images.pane : chat;
  const otherOn = other.view.state === 'connected' || other.view.state === 'loading';
  if (need <= free) return { level: 'ok' as const, need, free, otherOn, card };
  if (need <= free + 2 * GB) return { level: 'tight' as const, need, free, otherOn, card };
  return { level: 'no' as const, need, free, otherOn, card };
}

// ---- How each chat model is started: context size, cache type, experts in RAM ----

/** Context sizes offered (tokens). */
export const CONTEXTS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
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

/** This PC's chat models as src/runset.ts checks them (a guessing model counts only while it is still on this PC). */
const listed = () => chatModels.list().map(m => ({ id: m.id, name: m.file.split('/').pop()!.replace(/\.gguf$/i, ''), bytes: m.bytes, ...((shapes.get(m.id)?.mtp ?? 0) > 0 ? { mtp: true } : {}), ...(shapes.get(m.id)?.vocab ? { vocab: shapes.get(m.id)!.vocab } : {}) }));
export const runOf = (s: Settings, id: string): RunOptions => (s.run[id] ? cleanRunWith(s.run[id], id, listed(), CONTEXTS) : { ...DEFAULT_RUN });
/** The guessing model's file and its own context cache (0 with none): counted wherever the model's memory is. */
const draftBytes = (run: RunOptions) => {
  const d = run.draft ? chatModels.list().find(m => m.id === run.draft) : undefined;
  return d ? d.bytes + contextBytes(d.id, { ...run, draft: '' }) : 0;
};

/** Graphics cards with memory of their own that chat can use now (CUDA: NVIDIA only); none when Run on is CPU. */
export function chatCards(): Gpu[] {
  const asked = store.peek()?.chat.asked ?? 'auto';
  if (asked === 'cpu') return [];
  const devices = devicesFor('llama', asked);
  return hardware.gpus.filter(g => !g.integrated && (g.total ?? 0) > 0 && ((devices.includes('cuda') && g.vendor === 'nvidia') || devices.includes('vulkan')));
}
/** The cards chat can use, counted and their memory added up (the Models page's "Fits my card"). */
export const cardMem = () => (cards => ({ n: cards.length, total: cards.reduce((n, g) => n + (g.total ?? 0), 0) }))(chatCards());
/** True when `device` is a graphics card with memory of its own (Auto lets llama.cpp fit the model to it). */
const cardFor = (device: Device) => device !== 'cpu' && hardware.gpus.some(g => !g.integrated && (g.total ?? 0) > 0 && (device !== 'cuda' || g.vendor === 'nvidia'));
/** How the connected chat model was started (for the jobs' room in the context and the worker's hello). */

/** A model's run settings as sent or saved, only known values kept (src/runset.ts cleanRunWith). */
export const cleanRun = (raw: unknown, id: string): RunOptions => cleanRunWith(raw, id, listed(), CONTEXTS);

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
    return { id: m.id, name: m.file.split('/').pop()!.replace(/\.gguf$/i, ''), bytes: m.bytes, where: m.where, fit: fit(m.bytes + contextBytes(m.id, run) + draftBytes(run), 'chat', run.cards), run, trained: shape?.trainedContext ?? null, moe: (shape?.experts ?? 0) > 0, mtp: (shape?.mtp ?? 0) > 0, guessers: guessersFor(listed().find(x => x.id === m.id) ?? { id: m.id, name: '', bytes: m.bytes }, listed()), places: placesHere(m.id), cost, reading: readSpeedsNow()[m.id] ?? null, foldWait: cleanFoldWait(s?.foldWait?.[m.id]) };
  });
}

/**
 * Devices to try, best first. Auto skips a graphics chip built into the processor for chat: on the Intel HD 520 the
 * CPU read prompts four times faster and wrote faster too (measured 3 Oct 2026); GPU still uses it when chosen.
 */
function devicesFor(engine: 'llama' | 'sd', asked: Asked): Device[] {
  const gpu: Device[] = [];
  const found = (d: Device) => !(engine === 'llama' ? noCard : noPictureCard).has(d);
  if (hardware.gpus.some(g => g.vendor === 'nvidia') && runtimes.usable(engine, 'cuda') && found('cuda')) gpu.push('cuda');
  if (hardware.gpus.length && runtimes.installed(engine, 'vulkan') && found('vulkan')) gpu.push('vulkan');
  const cpu: Device[] = runtimes.installed(engine, 'cpu') ? ['cpu'] : [];
  if (asked === 'cpu') return cpu;
  if (asked === 'gpu') return gpu;
  if (autoSkipsGpu(engine)) return cpu.length ? cpu : gpu;
  return [...gpu, ...cpu];
}

/**
 * Max mode on a node (src/maxlend.ts): the RPC server beside the chat runner Auto would start here (a card's first, the
 * CPU's with no card, or with only one built into the processor), or null when no runner here has one.
 */
export function rpcProgram(): RpcProgram | null {
  for (const device of devicesFor('llama', 'auto')) {
    const exe = runtimes.exe('llama', device);
    const rpc = exe ? join(dirname(exe), process.platform === 'win32' ? 'ggml-rpc-server.exe' : 'ggml-rpc-server') : '';
    if (rpc && existsSync(rpc)) return { exe: rpc, device, threads: store.peek()?.chat.threads ?? 0 };
  }
  return null;
}

/**
 * The card runners installed here for chat, in the order Auto tries them (the CUDA builds this PC can use, the one that
 * suits its card first, then Vulkan): the speed finder tries each one against the one in use.
 */
export function cardRunners(): RunnerName[] {
  const out: RunnerName[] = [];
  for (const d of devicesFor('llama', 'gpu')) {
    if (d === 'vulkan') out.push('vulkan');
    if (d === 'cuda') for (const id of runtimes.order('llama', 'cuda')) if (runtimes.installedPin(id) && runnerOfPin(id)) out.push(runnerOfPin(id) as RunnerName);
  }
  return out;
}

const nameKey = (s: string) => s.toLowerCase().replace(/\(r\)|\(tm\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** A card as the runners list it, with its compute level from this PC's hardware list (else from its name). */
function gpuOfCard(c: Card): GpuFacts {
  const g = hardware.gpus.find(x => x.vendor === 'nvidia' && nameKey(x.name) === nameKey(c.label) && (!x.total || Math.abs(x.total - c.total) <= x.total * 0.15));
  return { name: c.label, vendor: c.ids.some(id => id.startsWith('CUDA')) ? 'nvidia' : g?.vendor ?? 'other', integrated: false, total: c.total, cc: g?.cc ?? ccFromName(c.label) };
}
/** The NVIDIA cards a model with these settings is spread over: the ones it is held to, else every one here. */
function gpusFor(run: RunOptions): GpuFacts[] {
  const every = hardware.gpus.filter(g => g.vendor === 'nvidia' && !g.integrated);
  const held = run.cards?.length ? cardList.filter(c => c.ids.some(id => run.cards!.includes(id))) : [];
  return held.length ? held.map(gpuOfCard).filter(g => g.vendor === 'nvidia') : every;
}
/** The card runners with code for this card (a CUDA build may have none for an older one): the speed finder's rows. */
export function runnersForCard(c: Card): RunnerName[] {
  return cardRunners().filter(r => runnerDevice(r) !== 'cuda' || (c.ids.some(id => id.startsWith('CUDA')) && buildFits(runtimes.pins[RUNNER_PINS[r]], [gpuOfCard(c)], hardware.nvidiaDriver ?? null)));
}

/**
 * The runner a model is held to when that build is installed here, this PC can use it, and (for a CUDA build) it has
 * code for every card the model is held to: CUDA 13 held to a GTX 1060 beside an RTX 5080 is not. Undefined: Auto.
 */
function heldRunner(run: RunOptions): RunnerName | undefined {
  const r = run.runner;
  if (!r || !RUNNER_NAMES.includes(r) || !cardRunners().includes(r)) return undefined;
  return runnerDevice(r) !== 'cuda' || buildFits(runtimes.pins[RUNNER_PINS[r]], gpusFor(run), hardware.nvidiaDriver ?? null) ? r : undefined;
}

/**
 * The program a chat start on `device` runs: the build the model is held to, or the one Auto picks for the cards it is
 * held to (or every card here).
 */
function chatExe(device: Device, held: RunnerName | undefined, run: RunOptions): { exe: string; runner?: string; id: string } {
  if (held && runnerDevice(held) === device) {
    const exe = runtimes.exePin(RUNNER_PINS[held]);
    if (exe) return { exe, runner: held, id: RUNNER_PINS[held] };
  }
  const fits = device === 'cuda' && run.cards?.length ? cudaOrder(runtimes.pins, 'llama', gpusFor(run), hardware.nvidiaDriver ?? null).find(id => runtimes.installedPin(id)) : undefined;
  const id = fits ?? runtimes.id('llama', device);
  const named = runnerOfPin(id);
  return { exe: runtimes.exePin(id)!, ...(named ? { runner: named } : {}), id };
}

/** The CUDA builds that have started on this PC since TOMLIN started: the "first start compiles" note is said before. */
const cudaStarted = new Set<string>();

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
  return runnersOf.place(id, shortName(entry.file.split('/').pop()!.replace(/\.gguf$/i, '')), chatNeed(entry.bytes + draftBytes(run), contextBytes(id, run)), freemem(), runnerLooks());
}

/** The memory a chat model is expected to need: its file and context cache, a tenth more, and 0.8 GB for the runner. */
const chatNeed = (file: number, cache: number) => (file + cache) * 1.1 + 0.8 * GB;

/**
 * Starts loading a chat model in the runner chatPlace picks (returns at once; the runner's state shows progress).
 * `main`: picked in the chat pane, so the manager answers on it from now on (a hire's model loads beside it or swaps).
 */
/** One placement at a time: two loads asked together (a job step and a node's switch) never pick the same runner. */
let placing: Promise<unknown> = Promise.resolve();
export function connectChat(id: string, asked: Asked, threads: number, main = false, tryRun?: RunOptions): Promise<{ ok: true; runner: Pane } | { error: string }> {
  const turn = placing.then(() => placeChat(id, asked, threads, main, tryRun));
  placing = turn.catch(() => undefined);
  return turn;
}

/** `tryRun`: the speed finder's try, used for this load only (nothing is saved). */
async function placeChat(id: string, asked: Asked, threads: number, main: boolean, tryRun?: RunOptions): Promise<{ ok: true; runner: Pane } | { error: string }> {
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
  const run = tryRun ?? runOf(s, id);
  runnerRun.set(runner, run);
  const draftPath = run.draft ? chatModels.path(run.draft) : null;
  // Max mode (hidden: TOMLIN_MAX names the linked PCs): their cards join this load as more devices.
  const max = maxPcs().length ? await rpcFor() : null;
  // A laptop's built-in chip beside its card: Vulkan would spread the layers over both, so the cards are named.
  const cards = startCards(run.cards, await readCards(), builtInHere);
  const started = { ...run, cards, draft: draftPath ?? undefined, moe: (shapes.get(id)?.experts ?? 0) > 0, ...(max?.endpoints.length ? { rpc: max.endpoints } : {}) };
  const draftName = draftPath ? draftPath.split(/[\\/]/).pop()!.replace(/\.gguf$/i, '') : '';
  const beside = at.replaces === null ? runners.filter(p => p !== runner && p.view.state === 'connected').map(p => ({ name: shortName(p.view.modelName ?? '') })) : [];
  const held = heldRunner(run);
  const runnerWords: Record<RunnerName, string> = { cuda: 'CUDA 12', cuda13: 'CUDA 13', vulkan: 'Vulkan' };
  const devices = devicesForRun(devicesFor('llama', asked), held && runnerDevice(held));
  // The CUDA build this load would start, for the words about the card: a Pascal card compiles its code at the first
  // start; a card in compute-only mode (TCC) is out of the Vulkan runner's sight.
  const cudaPin = devices.includes('cuda') ? chatExe('cuda', held, run).id : '';
  const notes = [
    asked !== 'cpu' && run.runner && !held ? `This model is set to the ${runnerWords[run.runner] ?? run.runner} runner, which is not installed here or has no code for ${run.cards?.length ? 'the cards it is held to' : 'this PC\'s cards'}: Auto picked the runner instead.` : '',
    asked !== 'cpu' ? missingCardRunner('llama', hardware.gpus, d => runtimes.installed('llama', d)) : '',
    asked !== 'cpu' && noCard.size ? `Skipped: ${[...noCard.values()].join('; ')}.` : '',
    asked === 'auto' && autoSkipsGpu('llama') ? `Auto picked the CPU: faster for chat than the built-in graphics chip (choose GPU to use it anyway).` : '',
    asked !== 'cpu' ? tccNote(hardware.gpus, !!cudaPin, 'chat') : '',
    cudaPin && !cudaStarted.has(cudaPin) ? firstStartNote(runtimes.pins[cudaPin], run.cards?.length ? gpusFor(run) : hardware.gpus) : '',
    run.ctx !== DEFAULT_RUN.ctx || run.cache !== 'f16' ? `Context ${run.ctx.toLocaleString()} tokens${run.cache !== 'f16' ? `, ${run.cache} cache` : ''}.` : '',
    asked === 'cpu' ? '' : run.place === 'ram' ? 'Expert weights in RAM, the rest on the graphics card.' : run.place === 'layers' ? `The experts of the first ${run.moeCpu} layers in RAM, the rest on the graphics card.` : run.place === 'card' ? 'Every layer on the graphics chip.' : chatCards().length ? `Auto: llama.cpp fills ${chatCards().length > 1 ? `the ${chatCards().length} graphics cards` : 'the graphics card'} and puts what does not fit in RAM.` : '',
    beside.length ? `Loaded beside ${runnersOf.namesOf(beside)}.` : '',
    draftName ? `Guessing model: ${draftName} (it guesses the next few words, this model checks them; the answer is this model's own).` : '',
    max?.lent.length ? `Max mode: borrowing the card memory of ${max.lent.map(n => `"${n}"`).join(' and ')}.` : '',
    ...(max?.notes ?? []),
  ].filter(Boolean);
  const loading = runner.connect({
    model: id,
    modelName: name,
    asked,
    threads,
    // A runner saved for this model (the speed finder's CUDA 12, CUDA 13 or Vulkan row) is the only one it starts on,
    // when it is installed and this PC can use it.
    devices,
    expectedSeconds: expected,
    build: device => ({ ...chatExe(device, held, run), args: (port, key) => chatArgs(path, port, device, threads, false, started, cardFor(device), key), ready, device, timeoutSeconds: 600 }),
    retry: (device, tail) => (TEMPLATE_FAULT.test(tail) ? { ...chatExe(device, held, run), args: (port, key) => chatArgs(path, port, device, threads, true, started, cardFor(device), key), ready, device, timeoutSeconds: 600 } : null),
    why: whyItFailed,
    // A card start that put the model on the CPU counts as failed (Max mode's lent cards aside): the next device is
    // tried, and Auto skips that runner from now on.
    started: (device, facts) => {
      const why = started.rpc?.length ? '' : noCardStart(device, facts);
      if (why) noCard.set(device, why);
      else if (device === 'cuda' && cudaPin) cudaStarted.add(cudaPin);
      return why;
    },
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

const PLACE_WORDS: Record<RunOptions['place'], string> = { auto: 'Auto (fill the card, the rest in RAM)', card: 'Every layer on the graphics chip', ram: 'Expert weights in RAM', layers: 'The experts of some layers in RAM, the rest on the card' };
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
    const upstream = await fetch(`${runner.worker.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...runnerHeaders(runner.worker.base) }, body: runnerJson(b), signal: ac.signal });
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
    const cards = cardMem();
    return json(res, 200, { cards, cardList: cardsNow(), chat: chatList().map(m => ({ ...m, hidden: hidden.has(m.id), card: cardFit(m.bytes, cards) })), image: images.list().map(m => ({ ...m, hidden: hidden.has(m.id) })), runtimes: runtimeList(), folder: chatModels.other(), ownFolder: chatModels.own, copies: cachedCopies(), hardware, settings: publicSettings(await store.settings()), who: whoList(), tones: TONES.map(({ id, name }) => ({ id, name })), contexts: CONTEXTS });
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
