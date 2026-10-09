// This PC and the linked ones: memory now, the Nodes page, reading speeds and the calculator.
import { readFile, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { modelParts } from '../carry.ts';
import { nowModel } from '../staff.ts';
import { writeAtomic } from '../atomic.ts';
import { readings, streamChat } from '../engine.ts';
import { workerName } from '../home.ts';
import * as calc from '../calc.ts';
import { memoryBar } from '../nodes.ts';
import * as nodestaff from '../nodestaff.ts';
import { hereKey, pcKey } from '../speed.ts';
import { DATA_DIR, type Routes, chatModels, hardware, hidden, json, sampler, shortName, speeds, staff, store } from './core.ts';
import { chatList, images, main, runnerFor, runners, watchedPids } from './panes.ts';
import { answeringBusy, endAnswer, takeChat } from './answering.ts';
import { jobRoutes } from './jobs.ts';

// ---- Nodes: this PC and the linked ones, their memory, and which models stay loaded ----

/** This PC's memory now, from the sampler: RAM and the graphics card, and what each loaded model holds. */
export function memoryNow() {
  // The sampler measures only the processes it is told to watch (a worker PC may have no page open to tell it).
  sampler.watch(watchedPids());
  const snap = sampler.latest;
  // Every chat runner (two or more chat models can be loaded) and the image pane.
  const held = [...runners.map(p => ['chat', p] as const), ['image', images.pane] as const].flatMap(([name, pane]) => {
    const v = pane.view;
    if (!v.model || (v.state !== 'connected' && v.state !== 'loading')) return [];
    const use = v.pid ? snap.processes[v.pid] : undefined;
    // Not measured yet (the sampler starts on a new process, or Windows was slow to answer): the file size, said as "about".
    const file = name === 'chat' ? chatModels.list().find(m => m.id === v.model)?.bytes : images.list().find(m => m.id === v.model)?.bytes;
    const measured = !!use?.ram;
    return [{ pane: name, id: v.model, name: String(v.modelName ?? v.model).replace(/\s*[(+].*$/, ''), ram: measured ? use!.ram : file ?? 0, measured, gpu: use?.gpuDedicated ?? 0, state: v.state }];
  });
  const gpu = snap.gpu && snap.gpu.total && !snap.gpu.shared ? { name: snap.gpu.name, total: snap.gpu.total, used: snap.gpu.used } : null;
  return {
    ram: { total: snap.ram.total, used: snap.ram.used, bar: memoryBar(snap.ram.total, snap.ram.used, held.map(h => ({ name: h.name, bytes: h.ram }))) },
    gpu: gpu ? { ...gpu, bar: memoryBar(gpu.total, gpu.used, held.map(h => ({ name: h.name, bytes: h.gpu }))) } : null,
    held,
  };
}

// ---- What can this PC run? (src/calc.ts) ----

/** This PC as the calculator reads it: RAM, the graphics card and its own memory, physical cores. */
function thisPcHardware(): calc.Hardware {
  const card = hardware.gpus.find(g => !g.integrated && (g.vendor === 'nvidia' || g.vendor === 'amd'));
  const builtin = hardware.gpus.some(g => g.integrated);
  return { ram: hardware.ram, vram: card?.total ?? 0, card: card ? (card.vendor as 'nvidia' | 'amd') : builtin ? 'builtin' : 'none', cores: hardware.cores };
}

// ---- Reading speed (PLAN F10 G1b): how fast each chat model reads its prompt on this PC ----
// llama.cpp reports it with every answer; the latest real figure (128 word-pieces read or more, so the start-up cost
// does not swamp it) is kept per model in data/reading.json. The context picker turns it into "about N min to read a
// full context here". A smaller sample does not replace a figure from one over 4x its size.
const READ_FILE = () => join(DATA_DIR, 'reading.json');
type Reading = { perSecond: number; tokens: number; at: string };
let readSpeeds: Record<string, Reading> | null = null;
export function readSpeedsNow(): Record<string, Reading> {
  if (!readSpeeds) {
    try {
      const got = JSON.parse(readFileSync(READ_FILE(), 'utf8')) as unknown;
      readSpeeds = got && typeof got === 'object' && !Array.isArray(got) ? (got as Record<string, Reading>) : {};
    } catch {
      readSpeeds = {};
    }
  }
  return readSpeeds;
}
readings.answered = (model, s) => {
  const entry = chatModels.list().find(m => m.id === model);
  // The model's name from its file (a model entry has no name of its own), as everywhere else on the page.
  if (entry) speeds.add(hereKey(model), shortName(entry.file.split('/').pop()!.replace(/\.gguf$/i, '')), 'this PC', s, 'answer');
};
readings.seen = (model, tokens, perSecond) => {
  if (tokens < 128 || !(perSecond > 0) || !chatModels.list().some(m => m.id === model)) return;
  const all = readSpeedsNow();
  const was = all[model];
  if (was && tokens * 4 < was.tokens && Date.now() - Date.parse(was.at) < 7 * 86_400_000) return;
  all[model] = { perSecond: Math.round(perSecond * 10) / 10, tokens, at: new Date().toISOString() };
  writeAtomic(READ_FILE(), JSON.stringify(all)).catch(() => undefined);
};

const CALC_FILE = () => join(DATA_DIR, 'calc-test.json');
type CalcTest = { speed: number; perSecond: number; model: string; at: string };
async function calcTested(): Promise<CalcTest | null> {
  try {
    const t = JSON.parse(await readFile(CALC_FILE(), 'utf8')) as CalcTest;
    return typeof t.speed === 'number' && t.speed > 0 ? t : null;
  } catch {
    return null;
  }
}

/** The fastest picture this PC has drawn (512 px, 4 steps), from the Images pane's own timings. */
async function pictureMeasured(): Promise<number | null> {
  const t = Object.values((await store.settings()).timings).filter(x => x.perStep > 0);
  return t.length ? Math.round(Math.min(...t.map(x => x.perStep * 4 + (x.decode || 0)))) : null;
}

/** The hardware typed in, kept to sane numbers. */
function calcHardware(b: Record<string, unknown>): calc.Hardware {
  const num = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const card = ['none', 'builtin', 'nvidia', 'amd'].includes(String(b.card)) ? (String(b.card) as calc.Hardware['card']) : 'none';
  return { ram: num(b.ramGB, 1, 1024, 8) * calc.GB, vram: card === 'nvidia' || card === 'amd' ? num(b.vramGB, 0, 192, 0) * calc.GB : 0, card, cores: Math.round(num(b.cores, 1, 128, 4)), cardSpeed: b.cardSpeed ? num(b.cardSpeed, 10, 4000, 0) || undefined : undefined };
}

async function calcView() {
  const tested = await calcTested();
  const here = chatList().map(m => ({ name: workerName(m.name), bytes: m.bytes }));
  return { thisPc: thisPcHardware(), cpuName: hardware.cpuName, cards: calc.CARDS, tested, here, postWords: calc.POST_WORDS };
}

/** Estimates for the hardware in `b`; `b.thisPc` true uses this PC's test and measured pictures. */
async function calcRows(b: Record<string, unknown>) {
  const hw = calcHardware(b);
  const mine = b.thisPc === true;
  const tested = mine ? (await calcTested())?.speed : undefined;
  const here = chatList();
  // This PC's own models first (marked "on this PC"), then the usual ones it does not have.
  const key = (n: string) => n.toLowerCase().replace(/[^a-z0-9.]/g, '');
  const own = here.map(m => ({ name: workerName(m.name), bytes: m.bytes, here: true, measured: calc.CHAT_MODELS.find(c => key(c.name) === key(workerName(m.name)))?.measured }));
  const ownKeys = new Set(own.map(m => key(m.name)));
  const list: calc.ChatModel[] = [...own, ...calc.CHAT_MODELS.filter(m => !ownKeys.has(key(m.name)))];
  const pic = mine ? await pictureMeasured() : null;
  return {
    chat: calc.chatRows(list, hw, tested).map(r => ({ ...r, postText: r.post ? `${calc.timeText(r.post.mid)} (${calc.timeText(r.post.low)}-${calc.timeText(r.post.high)})` : null })),
    picture: (() => {
      const r = calc.pictureRow(hw, pic ? { seconds: pic, on: 'this PC' } : undefined);
      return { ...r, text: r.seconds ? (r.basis === 'measured' ? calc.timeText(r.seconds.mid) : `${calc.timeText(r.seconds.mid)} (${calc.timeText(r.seconds.low)}-${calc.timeText(r.seconds.high)})`) : null };
    })(),
  };
}

/** "Test this PC": 120 tokens on the connected chat model (10 s for a 0.8B here, about 2 min for a 9B on a CPU); its speed becomes this PC's CPU figure. */
async function calcTest() {
  const runner = main();
  if (runner.view.state !== 'connected' || !runner.worker.base) return { status: 409, body: { error: 'Connect a chat model first (the smallest is quickest), then press Test again.' } };
  if (answeringBusy(runner)) return { status: 409, body: { error: 'The chat model is answering something. Wait for it to finish, then press Test again.' } };
  if (runner.view.device && runner.view.device !== 'cpu') return { status: 409, body: { error: 'This model runs on the graphics card, so it would not measure the CPU. Connect one on the CPU (Run on: CPU), then press Test.' } };
  const entry = chatModels.list().find(m => m.id === runner.view.model);
  if (!entry) return { status: 409, body: { error: 'The connected model could not be read. Connect it again, then press Test.' } };
  const ac = new AbortController();
  takeChat(ac, runner, '', '', 'A speed test of this PC');
  const timer = setTimeout(() => ac.abort(), 150_000);
  try {
    const r = await streamChat(runner.worker.base, runner.view.model ?? '', [{ role: 'user', content: 'Write about 150 words on why people bake their own bread. Plain sentences.' }], () => undefined, ac.signal, 120);
    if (!r.perSecond) return { status: 500, body: { error: 'The model did not report its speed. Try again.' } };
    const t: CalcTest = { speed: calc.testedSpeed(r.perSecond, entry.bytes), perSecond: Math.round(r.perSecond * 10) / 10, model: workerName(runner.view.modelName ?? entry.file), at: new Date().toISOString() };
    await writeAtomic(CALC_FILE(), JSON.stringify(t));
    return { status: 200, body: t };
  } catch (error) {
    return { status: 500, body: { error: `The test stopped part-way: ${(error as Error).message}. Try again.` } };
  } finally {
    clearTimeout(timer);
    endAnswer(ac);
  }
}

/**
 * Every model on this PC (Nodes and memory, and the PC window): its size, the memory it needs loaded (`need`, a chat
 * model's at an 8K context; a picture model's is about its file), whether it fits this PC (`fit`), loaded or not, its
 * speed, Hide, and who works on it.
 */
export function modelsHere() {
  const chats = chatList();
  const pictures = images.list().filter(x => x.installed);
  return [
    ...chats.map(m => ({ id: m.id, name: m.name.replace(/\s*[(+].*$/, ''), kind: 'chat' as const, bytes: m.bytes, need: Math.round(calc.chatNeed(m.bytes)), fit: m.fit.level, loaded: runnerFor(m.id)?.view.state === 'connected', speed: speeds.get(hereKey(m.id)), hidden: hidden.has(m.id), ollama: m.where === 'ollama', usedBy: usersOf(m.id) })),
    ...pictures.map(m => ({ id: m.id, name: m.name, kind: 'image' as const, bytes: m.bytes, need: m.bytes, fit: m.fit.level, loaded: images.pane.view.model === m.id && images.pane.view.state === 'connected', speed: null, hidden: hidden.has(m.id), ollama: false, usedBy: usersOf(m.id) })),
  ];
}

/** This PC's processor, as the PC window's Specifications show it. */
export const cpuHere = () => ({ name: hardware.cpuName, cores: hardware.cores, threads: hardware.threads });

async function nodesView() {
  const s = await store.settings();
  const share = jobRoutes.shareView();
  return {
    name: share.name,
    memory: memoryNow(),
    models: modelsHere(),
    idle: { chat: s.chat.idleMinutes, image: s.image.idleMinutes },
    // This PC as a node: whether it is shared, its setup and the models it lets linked PCs use.
    share,
  };
}

// ---- Hide and Delete (Models on this PC) ----

/** The hires who work on a model of this PC (as their first choice, their backup, or the model they are on now). */
function usersOf(id: string): string[] {
  return staff.list().filter(m => m.model === id || m.fallback === id || nowModel(m) === id).map(m => m.name);
}

/** The files a model of this PC is kept in, or why it cannot be deleted from here. */
function filesOf(kind: unknown, id: string): { name: string; files: string[] } | { error: string; status: number } {
  if (kind === 'image') {
    const m = images.registry.get(id);
    if (!m || m.kind !== 'image' || !images.registry.installed(m)) return { status: 404, error: 'That picture model is not on this PC any more.' };
    if (images.pane.view.model === id && (images.pane.view.state === 'connected' || images.pane.view.state === 'loading')) return { status: 409, error: `${m.name} is loaded now: press Drop in the top bar first, then Delete.` };
    // A file another installed picture model also uses stays.
    const others = new Set(images.registry.models.filter(o => o.id !== id && images.registry.installed(o)).flatMap(o => o.files.map(f => images.registry.filePath(o, f).toLowerCase())));
    return { name: m.name, files: m.files.map(f => images.registry.filePath(m, f)).filter(p => !others.has(p.toLowerCase())) };
  }
  const m = chatModels.list().find(x => x.id === id);
  if (!m) return { status: 404, error: 'That model is not on this PC any more.' };
  const name = basename(m.file).replace(/\.gguf$/i, '');
  if (m.where === 'ollama') return { status: 409, error: `${m.file} is kept by Ollama, so it is removed in Ollama: in a command window, type: ollama rm ${m.file}` };
  const p = runnerFor(id)?.view.state;
  if (p === 'connected' || p === 'loading') return { status: 409, error: `${name} is loaded now: press Drop in the top bar first, then Delete.` };
  const path = chatModels.path(id);
  if (!path) return { status: 404, error: 'That model is not on this PC any more.' };
  let names: string[] = [];
  try {
    names = readdirSync(dirname(path));
  } catch {
    return { status: 404, error: 'That model\'s folder cannot be read now.' };
  }
  return { name, files: modelParts(basename(path), names).map(n => join(dirname(path), n)) };
}

// ---- Routes ----

/** GET requests answered here, by path. */
export const thispcGet: Routes = {
  '/api/nodes': async ({ res }) => json(res, 200, await nodesView()),
  '/api/calc': async ({ res }) => json(res, 200, await calcView()),
  '/api/nodes/others': async ({ res }) => json(res, 200, { pcs: (await jobRoutes.remoteStatus()).map(r => ({ ...r, speed: r.ok && r.model ? speeds.get(pcKey(r.id, r.model)) : null })) }),
  // The meters of the linked PC an open chat's hire works on (the chat head asks every 3 s while it is on screen).
  '/api/node/stats': async ({ res, url }) => json(res, 200, await jobRoutes.nodeStats(String(url.searchParams.get('pc') ?? ''))),
};

/** POST requests answered here, by path (the body is read already). */
export const thispcPost: Routes = {
  '/api/calc': async ({ res, b }) => json(res, 200, await calcRows(b)),
  '/api/calc/test': async ({ res }) => {
    const r = await calcTest();
    return json(res, r.status, r.body);
  },
  // Hide or show one model: a hidden model stays on the disk (and shared, when ticked), out of the lists a model is
  // picked from until "Show hidden" is ticked, and cannot be deleted while it is hidden.
  '/api/models/hide': async ({ res, b }) => {
    const id = typeof b.id === 'string' ? b.id : '';
    const known = b.kind === 'image' ? images.list().some(m => m.id === id) : chatModels.list().some(m => m.id === id);
    if (!known) return json(res, 404, { error: 'That model is not on this PC any more.' });
    await hidden.set(id, b.hidden === true);
    return json(res, 200, { ok: true });
  },
  // Deletes a model's files from this PC (the page asks first, naming the hires who use it).
  '/api/models/delete': async ({ res, b }) => {
    const id = typeof b.id === 'string' ? b.id : '';
    if (hidden.has(id)) return json(res, 409, { error: 'That model is hidden, which keeps it from being deleted. Press Unhide first, then Delete.' });
    const got = filesOf(b.kind, id);
    if ('error' in got) return json(res, got.status, { error: got.error });
    try {
      for (const f of got.files) await rm(f, { force: true });
    } catch (e) {
      chatModels.forget();
      return json(res, 500, { error: `${got.name} could not be deleted: ${(e as Error).message}. Close any program using it, then try again.` });
    }
    chatModels.forget();
    return json(res, 200, { ok: true, said: `${got.name} was deleted from this PC.` });
  },
  // A linked PC's own hires are retired (2.0.31): a page from before asking to switch one is told why.
  '/api/nodes/switch': async ({ res }) => {
    return json(res, 410, { error: nodestaff.RETIRED_NODE_HIRE });
  },
};
