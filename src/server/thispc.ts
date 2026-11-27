// This PC and the linked ones: memory now, the Nodes page, reading speeds and the calculator.
import { open, readFile, rm, stat } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { diskOf, modelParts, modelRoom, removeWhy } from '../carry.ts';
import * as cleanup from '../cleanup.ts';
import { assignedTo, staffLines } from '../assigned.ts';
import { nowModel } from '../staff.ts';
import { writeAtomic } from '../atomic.ts';
import { readings, streamChat } from '../engine.ts';
import { workerName } from '../home.ts';
import * as calc from '../calc.ts';
import { memoryBar } from '../nodes.ts';
import * as nodestaff from '../nodestaff.ts';
import { hereKey, pcKey } from '../speed.ts';
import { keepBig, type ReadFigure } from '../layers.ts';
import { DATA_DIR, type Routes, byModel, chatModels, modelsHome, hardware, hidden, json, lastUsed, sampler, shortName, speeds, staff, store } from './core.ts';
import { modelsDone } from '../modelsdone.ts';
import { drawings } from '../images.ts';
import { chatList, images, main, runnerFor, runners, watchedPids } from './panes.ts';
import { answeringBusy, endAnswer, takeChat } from './answering.ts';
import { jobRoutes } from './jobs.ts';
import { hostPinsHere } from './locks.ts';
import { memoryLow } from '../jobrun/maxnode.ts';
import { copiesWords, onShow, sameFiles } from '../models.ts';
import { diskFacts } from './slowdisk.ts';

// ---- Nodes: this PC and the linked ones, their memory, and which models stay loaded ----

/** This PC's memory now, from the sampler: RAM and the graphics card, and what each loaded model holds. */
export function memoryNow() {
  // The sampler measures only the processes it is told to watch (a worker PC may have no page open to tell it).
  sampler.watch(watchedPids());
  // As last read: a linked PC's hello asks for this once a minute, which is no reason to read the card every second (a
  // page open here reads `latest` once a second, which does).
  const snap = sampler.last;
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
  // Every graphics card with memory of its own (the bar above shows one): a model can be spread over two or more.
  const own = hardware.gpus.filter(g => !g.integrated && (g.total ?? 0) > 0);
  return {
    // Lending with free RAM under the aim: told in the hello, for the host's next load (src/maxlend.ts MemoryWatch).
    ...(memoryLow() ? { low: true } : {}),
    // `list`: each card by name, the one TOMLIN uses first (src/hardware.ts strongestFirst), for the PC window.
    cards: { count: own.length, total: own.reduce((n, g) => n + (g.total ?? 0), 0), list: own.map(g => ({ name: g.name, total: g.total ?? 0 })) },
    // The computer's own name (Windows'), sent in the hello: two linked PCs both called "Worker PC" are told apart by it.
    computer: hostname().slice(0, 40),
    ram: { total: snap.ram.total, used: snap.ram.used, bar: memoryBar(snap.ram.total, snap.ram.used, held.map(h => ({ name: h.name, bytes: h.ram }))) },
    gpu: gpu ? { ...gpu, bar: memoryBar(gpu.total, gpu.used, held.map(h => ({ name: h.name, bytes: h.gpu }))) } : null,
    held,
  };
}

// ---- What can this PC run? (src/calc.ts) ----

/** This PC as the calculator reads it: RAM, the graphics card and its own memory, physical cores. */
function thisPcHardware(): calc.Hardware {
  // The strongest card: the list is kept strongest first (src/hardware.ts strongestFirst).
  const card = hardware.gpus.find(g => !g.integrated && (g.vendor === 'nvidia' || g.vendor === 'amd'));
  const builtin = hardware.gpus.some(g => g.integrated);
  return { ram: hardware.ram, vram: card?.total ?? 0, card: card ? (card.vendor as 'nvidia' | 'amd') : builtin ? 'builtin' : 'none', cores: hardware.cores };
}

// ---- Reading speed (PLAN F10 G1b): how fast each chat model reads its prompt on this PC ----
// llama.cpp reports it with every answer; the latest real figure (128 word-pieces read or more, so the start-up cost
// does not swamp it) is kept per model in data/reading.json. The context picker turns it into "about N min to read a
// full context here". A smaller sample does not replace a figure from one over 4x its size.
// `big`: the latest read of 1,000 tokens or more (src/layers.ts keepBig), the figure a long chat's layers size from.
const READ_FILE = () => join(DATA_DIR, 'reading.json');
type Reading = { perSecond: number; tokens: number; at: string; big?: ReadFigure };
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
drawings.drawn = model => lastUsed.touch(model);
readings.seen = (model, tokens, perSecond) => {
  if (tokens < 128 || !(perSecond > 0) || !chatModels.list().some(m => m.id === model)) return;
  const all = readSpeedsNow();
  const was = all[model];
  const at = new Date().toISOString();
  const big = keepBig(was?.big, tokens, perSecond, at);
  if (was && tokens * 4 < was.tokens && Date.now() - Date.parse(was.at) < 7 * 86_400_000) {
    if (big === was.big) return;
    all[model] = { ...was, ...(big ? { big } : {}) };
  } else all[model] = { perSecond: Math.round(perSecond * 10) / 10, tokens, at, ...(big ? { big } : {}) };
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
 * Every model on this PC (This PC: models and updates, and the PC window): its size, the memory it needs loaded (`need`, a chat
 * model's at an 8K context; a picture model's is about its file), whether it fits this PC (`fit`), loaded or not, its
 * speed, Hide, and who works on it.
 */
export function modelsHere() {
  const loadedNow = (id: string) => runnerFor(id)?.view.state === 'connected';
  // The same file found twice (TOMLIN's folder and the other folder): one row, the one loaded or worked on if either is.
  const twins = sameFiles(chatModels.list(), ids => ids.find(loadedNow) ?? ids.find(id => usersOf(id).length > 0));
  const chats = chatList().filter(m => onShow(m.id, twins));
  const pictures = images.list().filter(x => x.installed);
  // Every id of a model shown once: its hires are counted over all of them.
  const idsOf = (id: string) => twins.get(id)?.ids ?? [id];
  return [
    ...chats.map(m => ({ id: m.id, name: m.name.replace(/\s*[(+].*$/, ''), kind: 'chat' as const, bytes: m.bytes, need: Math.round(calc.chatNeed(m.bytes)), fit: m.fit.level, loaded: idsOf(m.id).some(loadedNow), speed: speeds.get(hereKey(m.id)), hidden: hidden.has(m.id), ollama: m.where === 'ollama', usedBy: [...new Set(idsOf(m.id).flatMap(usersOf))], staffNote: staffLines({ mine: idsOf(m.id).flatMap(id => assignedTo(staff.list(), id)) }).note, copiesNote: copiesWords(twins.get(m.id)?.ids ?? [], m.id, chatModels.other()), incomplete: m.incomplete, disk: diskFacts('chat', m.id, m.bytes) })),
    ...pictures.map(m => ({ id: m.id, name: m.name, kind: 'image' as const, bytes: m.bytes, need: m.bytes, fit: m.fit.level, loaded: images.pane.view.model === m.id && images.pane.view.state === 'connected', speed: null, hidden: hidden.has(m.id), ollama: false, usedBy: usersOf(m.id), staffNote: staffLines({ mine: assignedTo(staff.list(), m.id) }).note, disk: diskFacts('image', m.id, m.bytes) })),
  ];
}

/** This PC's processor, as the PC window's Specifications show it. */
export const cpuHere = () => ({ name: hardware.cpuName, cores: hardware.cores, threads: hardware.threads, ...(hardware.sockets ? { sockets: hardware.sockets } : {}) });

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
    // The linked hosts that gave this PC a host PIN (src/hostpin.ts), by the ids of the links shown: its owner can take one away.
    hostPins: hostPinsHere(share.paired.map(x => x.id)),
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
  return { name, files: partsHere(basename(path), names).map(n => join(dirname(path), n)) };
}

/**
 * The files of a chat model on this PC to delete: every part of a split model that is on the disk, also when one is
 * missing (a download cut off, a part deleted by hand), so no part is left behind to list the model again; else the file.
 */
function partsHere(first: string, names: string[]): string[] {
  const whole = modelParts(first, names);
  const m = /^(.*)-00001-of-(\d{5})\.gguf$/i.exec(first);
  if (whole.length > 1 || !m) return whole;
  const byLower = new Map(names.map(n => [n.toLowerCase(), n]));
  const found = Array.from({ length: Number(m[2]) }, (_, k) => byLower.get(`${m[1]}-${String(k + 1).padStart(5, '0')}-of-${m[2]}.gguf`.toLowerCase())).filter((n): n is string => !!n);
  return found.length ? found : [first];
}

/** True when another program holds the file open (Windows then refuses to open it for writing). */
async function heldOpen(path: string): Promise<boolean> {
  try {
    await (await open(path, 'r+')).close();
    return false;
  } catch (e) {
    return ['EBUSY', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '');
  }
}

/** Why a model of this PC cannot be deleted now (hidden, loaded, kept by Ollama, not here); '' when it can. Changes nothing. */
export function removeBlock(kind: unknown, id: string): string {
  if (hidden.has(id)) return 'That model is hidden, which keeps it from being removed. Press Unhide first.';
  const got = filesOf(kind, id);
  return 'error' in got ? got.error : '';
}

/**
 * Deletes a model's files from this PC: for its own Models page and for a linked PC that asks over the link (src/jobrun/node.ts,
 * after the owner's "Accept models from linked PCs" tick). A hidden model, a loaded one and one Ollama keeps are refused,
 * with the reason; nothing but ids crosses, and the files come from this PC's own model list.
 */
export async function deleteModelHere(kind: unknown, id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  if (hidden.has(id)) return { status: 409, body: { error: 'That model is hidden, which keeps it from being deleted. Press Unhide first, then Delete.' } };
  const got = filesOf(kind, id);
  if ('error' in got) return { status: got.status, body: { error: got.error } };
  const parts = got.files.length > 1;
  // A file another program holds open is found before anything goes, so a split model is never left with some parts deleted.
  const held: string[] = [];
  for (const f of got.files) if (await heldOpen(f)) held.push(basename(f));
  if (held.length) return { status: 409, body: { error: `${got.name} was not deleted: ${parts ? `the part${held.length === 1 ? '' : 's'} ${held.join(', ')} ${held.length === 1 ? 'is' : 'are'}` : `${held[0]} is`} open in another program. Close that program, then try again. Nothing was deleted.` } };
  const gone: string[] = [];
  for (const f of got.files) {
    try {
      await rm(f, { force: true });
      gone.push(basename(f));
    } catch (e) {
      chatModels.forget();
      const left = got.files.map(x => basename(x)).filter(n => !gone.includes(n));
      const said = (e as Error).message.split('\n')[0].slice(0, 160);
      return { status: 500, body: { error: parts && gone.length
        ? `${got.name} was only partly deleted: the part${gone.length === 1 ? '' : 's'} ${gone.join(', ')} ${gone.length === 1 ? 'was' : 'were'} deleted, and ${left.join(', ')} could not be (${said}). The model cannot be loaded now: close any program using it, then press Delete again to remove the rest.`
        : `${got.name} could not be deleted: ${said}. Nothing was deleted. Close any program using it, then try again.` } };
    }
  }
  chatModels.forget();
  lastUsed.forget(id);
  return { status: 200, body: { ok: true, said: `${got.name} was deleted from this PC.` } };
}

// ---- Free up space (src/cleanup.ts, public/cleanup.js) ----

/**
 * The models of this PC (or a linked PC) as Free up space lists them: ranked least used first, by category, with what
 * would be offered for a model `wanted` that does not fit. Deleting goes through /api/models/delete, one model at a time.
 */
async function cleanupView(pcId: unknown, wanted: { name: string; bytes: number } | null) {
  const here = !pcId || pcId === 'here';
  let inputs: cleanup.CleanInput[];
  let disk: { total: number; free: number } | null;
  let name = 'This PC';
  let canDelete = true;
  let why = '';
  let drive = '';
  const drives: { drive: string; total: number; free: number }[] = [];
  if (here) {
    const entries = chatModels.list();
    inputs = await Promise.all(modelsHere().map(async m => {
      const got = filesOf(m.kind, m.id);
      const files = 'files' in got ? got.files : [];
      let size = 0;
      let at: number | null = null;
      for (const f of files) {
        try {
          const s = await stat(f);
          size += s.size;
          at = Math.max(at ?? 0, s.mtimeMs);
        } catch {
          // A part gone from the disk: the size counts what is there.
        }
      }
      return { id: m.id, name: m.name, kind: m.kind, file: m.kind === 'chat' ? entries.find(e => e.id === m.id)?.file : undefined, bytes: size || m.bytes, usedAt: lastUsed.get(m.id), installedAt: at, loaded: m.loaded, hidden: m.hidden, ollama: m.ollama, usedBy: m.usedBy, files: files.map(f => basename(f)), ...(cleanup.driveOf(files[0] ?? '') ? { drive: cleanup.driveOf(files[0]) } : {}) };
    }));
    // The drive new models go to (Where models are kept), and each drive that holds models: a model on D: frees
    // nothing on C:, so each is told with its own free space (it showed C: only, beside models all on D:).
    const target = modelsHome.dir();
    disk = await diskOf(target);
    drive = cleanup.driveOf(target);
    for (const d of [...new Set([drive, ...inputs.map(x => x.drive ?? '')])].filter(Boolean).sort()) {
      const got = d === drive ? disk : await diskOf(`${d}\\`);
      if (got) drives.push({ drive: d, ...got });
    }
  } else {
    const r = (await store.settings()).remotes.find(x => x.id === pcId);
    if (!r) return { status: 404, body: { error: 'That PC is no longer linked to this one. Close this window: the list on the left has the PCs linked now.' } };
    name = r.name;
    const h = await jobRoutes.hello(r, 3000).catch(() => null);
    const list = (h?.models ?? r.models ?? []) as { id: string; name: string; kind: 'chat' | 'image'; bytes: number; loaded?: boolean; busy?: boolean; hidden?: boolean; usedAt?: number }[];
    inputs = list.map(m => ({ id: m.id, name: shortName(m.name) || m.name, kind: m.kind === 'image' ? 'image' : 'chat', file: m.name, bytes: m.bytes || 0, usedAt: m.usedAt ?? null, installedAt: null, loaded: !!h && !!m.loaded, busy: !!h && !!m.busy, hidden: m.hidden === true, usedBy: [...assignedTo(staff.list(), `remote:${r.id}:${m.id}`), ...((m as { assigned?: { name: string }[] }).assigned ?? [])].map(a => a.name) }));
    // The free space of the drive that PC keeps its models on (its hello names it), not its backups drive: `disk` is
    // that one, and is used only from a PC too old to say its drives.
    const room = h ? modelRoom(h) : null;
    disk = room ? { total: room.total, free: room.free } : null;
    // Removed over the link (POST /api/network/model-remove), with that PC's own tick and its app lock PIN, asked when Remove
    // is pressed. Only a real block is said, in one line: off, busy with its owner, too old, or the tick not set there.
    why = !h ? `"${r.name}" is off or not answering: its list is as last seen.`
      : h.allow && h.can.includes('model-remove') && !h.allow.receive ? `Tick "Accept models from linked PCs" on "${r.name}" (This PC) to remove models there.`
        : removeWhy({ id: r.id, name: r.name, ok: true, away: h.away, can: h.can, allow: h.allow, models: [] });
    if (why) why = `${why.charAt(0).toUpperCase()}${why.slice(1).replace(/.$/, '')}.`;
    canDelete = !why;
  }
  const rows = cleanup.prepare(inputs);
  const short = wanted && disk ? cleanup.shortBy(wanted.bytes, disk.free) : 0;
  // A model to install needs room on its drive: only models there are offered for it.
  return { status: 200, body: { pc: here ? 'here' : pcId, name, rows, disk, drive, drives, spare: cleanup.SPARE, now: Date.now(), canDelete, why, wanted, short, ...cleanup.suggest(rows, short, wanted ? drive : '') } };
}

// ---- Routes ----

/** GET requests answered here, by path. */
export const thispcGet: Routes = {
  // What the models have done in the last 7 days (W2-23): chat answers and time by model and PC, pictures and their
  // seconds by size, clips and their minutes for 5 s. Read from what is kept already; nothing is measured for it.
  '/api/models/done': async ({ res }) => {
    const { clipShelf } = await import('./clips.ts');
    const { VIDEO_MODELS, shortVideoName } = await import('../videomodels.ts');
    const remotes = (await store.settings()).remotes;
    const chat = [{ key: 'here', name: 'This PC' }, ...remotes.map(r => ({ key: r.id, name: r.name }))]
      .flatMap(p => byModel.top(p.key, 7).map(x => ({ pc: p.name, model: x.model, ms: x.ms, answers: x.answers })));
    const [pictures, clips] = await Promise.all([images.gallery.all().catch(() => []), clipShelf.all().catch(() => [])]);
    const videoNames = Object.fromEntries(VIDEO_MODELS.map(m => [m.id, shortVideoName(m)]));
    return json(res, 200, modelsDone({ pictures, clips, chat, videoNames }));
  },
  '/api/nodes': async ({ res }) => json(res, 200, await nodesView()),
  '/api/calc': async ({ res }) => json(res, 200, await calcView()),
  '/api/nodes/others': async ({ res }) => json(res, 200, { cluster: jobRoutes.clusterView(), pcs: (await jobRoutes.remoteStatus()).map(r => ({ ...r, speed: r.ok && r.model ? speeds.get(pcKey(r.id, r.model)) : null, updating: jobRoutes.updatingTo(r.id) })) }),
  // The meters of the linked PC an open chat's hire works on (the chat head asks every 3 s while it is on screen). The
  // hire's model there is named, so that PC keeps only it loaded, not every model it loaded for this PC. `loaded` is
  // what that PC says is loaded (null: not known); `chosen` is the hire's model there and `hire` the hire's name.
  '/api/node/stats': async ({ res, url }) => {
    const pc = String(url.searchParams.get('pc') ?? '');
    const who = String(url.searchParams.get('who') ?? '');
    const m = who.startsWith('staff:') ? staff.get(who.slice(6)) : undefined;
    return json(res, 200, { ...(await jobRoutes.nodeStats(pc, nodestaff.statsModel(m ? nowModel(m) ?? m.model : null, pc))), hire: m?.name ?? null });
  },
  // A linked PC's log, its last lines (?pc= its id or name, &lines= up to 1000, &day= one of the 7 days it keeps written
  // 2026-11-17, &find= a word): for tests across PCs and the Log part of its window. A day not in that form is refused.
  '/api/node/log': async ({ res, url }) => {
    const day = String(url.searchParams.get('day') ?? '');
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(res, 400, { error: 'Write the day as 2026-11-17.' });
    const got = await jobRoutes.nodeLog(String(url.searchParams.get('pc') ?? ''), Number(url.searchParams.get('lines')) || 300, { day, find: String(url.searchParams.get('find') ?? '') });
    return json(res, got.state === 'gone' ? 404 : 200, got.state === 'gone' ? { ...got, error: 'There is no linked PC by that id or name.' } : got);
  },
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
  '/api/cleanup': async ({ res, b }) => {
    const w = b.wanted && typeof b.wanted === 'object' ? (b.wanted as Record<string, unknown>) : null;
    const bytes = Number(w?.bytes);
    const r = await cleanupView(b.pc, w && Number.isFinite(bytes) && bytes > 0 ? { name: String(w.name ?? 'the new model').slice(0, 120), bytes: Math.round(bytes) } : null);
    return json(res, r.status, r.body);
  },
  '/api/models/hide': async ({ res, b }) => {
    const id = typeof b.id === 'string' ? b.id : '';
    const known = b.kind === 'image' ? images.list().some(m => m.id === id) : chatModels.list().some(m => m.id === id);
    if (!known) return json(res, 404, { error: 'That model is not on this PC any more.' });
    try {
      await hidden.set(id, b.hidden === true);
    } catch (e) {
      return json(res, 500, { error: `That could not be saved, so the model is ${hidden.has(id) ? 'still hidden' : 'still shown'}: ${(e as Error).message.split('\n')[0].slice(0, 160)}. Try again in a moment.` });
    }
    return json(res, 200, { ok: true });
  },
  // Deletes a model's files from this PC (the page asks first, naming the hires who use it).
  '/api/models/delete': async ({ res, b }) => {
    const r = await deleteModelHere(b.kind, typeof b.id === 'string' ? b.id : '');
    return json(res, r.status, r.body);
  },
  // A linked PC's own hires are retired (2.0.31): a page from before asking to switch one is told why.
  '/api/nodes/switch': async ({ res }) => {
    return json(res, 410, { error: nodestaff.RETIRED_NODE_HIRE });
  },
};
