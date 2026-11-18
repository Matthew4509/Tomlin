// Runner faults and the run history: when a chat runner crashes (it stops on its own while a model is loaded) or a model
// will not load, a fault record is made once, on the PC where the runner ran: which PC, which model, which runner build,
// the fault in plain words and the runner's last lines (no prompt or chat text). Every answer that came back whole counts
// as a success for that PC, model and runner. Both are kept in data/run-history.json, so the crash notice, the Report a
// problem window and the runner fallback read the same record, and it survives a restart. A record that crosses the
// link (a linked PC's runner crashed) is checked field by field (cleanFault). Tested in test/faults.test.ts.
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readData, updateData } from './atomic.ts';
import type { Device } from './runtimes.ts';

export type FaultKind = 'crash' | 'load';

/** One fault, as it is kept, shown in the crash notice and sent to the host. */
export interface FaultRecord {
  id: string;
  at: string;
  /** The PC the runner ran on, by the name it goes by on the network ('This PC' when it has none). */
  pc: string;
  model: string;
  modelName: string;
  /** The runner build (runtimes.json id, such as llama-cuda) and its name; '' when it was not known. */
  runner: string;
  runnerName: string;
  device: Device | '';
  kind: FaultKind;
  /** What went wrong, in plain words. */
  fault: string;
  /** The runner's own last lines (lines that mention a prompt left out). */
  detail: string;
  /** Things to try, best first, as the PC that ran it sees them (src/server/faults.ts tryOptions). */
  tries?: TryOption[];
  /** That PC's record of this model on each runner. */
  history?: HistoryRow[];
  /** Automatic fallback is on for this model on that PC (the person agreed in an earlier notice). */
  fallback?: boolean;
  /** What the fallback did after this fault, in plain words ('' or unset: nothing), and the runner it moved to. */
  fallbackSaid?: string;
  fellBack?: string;
  /**
   * The model's file was not there when the runner stopped (its drive unplugged, or the file moved or deleted): the
   * runner is not blamed. No other runner is offered, nothing falls back, and it does not count against the runner.
   */
  gone?: boolean;
}

/** A runner to try after a fault: what it is, whether it is there, and its record with this model. */
export interface TryOption {
  pin: string;
  name: string;
  device: Device;
  build: string;
  /** 'version': another build of the same kind; 'type': the other kind (Vulkan for CUDA); 'cpu': the CPU. */
  kind: 'version' | 'type' | 'cpu';
  installed: boolean;
  /** Download size when it is not installed (bytes). */
  bytes: number;
  /** Why it should not be tried here ('' when it can be): no code for the card, known to crash here, failed its test. */
  why: string;
  /** It answered whole on that PC lately (with this model or another) and did not fail since: it is suggested first. */
  worked?: boolean;
  /** It failed with this model on that PC and has not answered whole with it since: the guided flow skips it. */
  failedHere?: boolean;
}

/** One runner's record with one model on one PC. */
export interface HistoryRow {
  runner: string;
  ok: number;
  failed: number;
  lastOk: string | null;
  lastFailed: string | null;
  lastFault: string;
  /** Writing speed of the last whole answer (tokens a second). */
  write: number | null;
}

interface Entry {
  pc: string;
  model: string;
  runner: string;
  /** When answers came back whole, newest last (at most KEEP_OK). */
  ok: string[];
  /** Faults, newest last (at most KEEP_FAULTS). */
  faults: FaultRecord[];
  write: number | null;
}

/** Recent successes and faults kept for each PC, model and runner. */
export const KEEP_OK = 50;
export const KEEP_FAULTS = 10;
/** Faults kept in all (the newest), across every PC, model and runner. */
export const KEEP_ALL = 400;

const PROMPT_LINE = /prompt|user:|assistant:|<\|im_start\|>|"content"/i;

/** A runner's last lines as kept: lines that carry a prompt or chat text left out, at most `max` characters, newest kept. */
export function cleanDetail(tail: string, max = 1200): string {
  return String(tail ?? '').split(/\r?\n/).filter(l => l.trim() && !PROMPT_LINE.test(l)).map(l => l.slice(0, 300)).join('\n').slice(-max);
}

const DEVICE_WORDS: Record<Device, string> = { cuda: 'the NVIDIA card (CUDA)', vulkan: 'the graphics chip (Vulkan)', cpu: 'the CPU' };

/**
 * The fault in plain words, from the runner's last lines: what happened and where, never a guess dressed as a fact.
 * `runnerName`: the build ("llama.cpp b11284, CUDA 12.4 ..."), `kind`: a crash while loaded or a load that failed.
 */
export function faultWords(tail: string, o: { device: Device | ''; runnerName: string; kind: FaultKind; modelName: string }): string {
  const t = String(tail ?? '').toLowerCase();
  const build = /\bb\d{3,6}\b/.exec(o.runnerName)?.[0];
  const runner = o.device ? `the ${o.device === 'cuda' ? 'CUDA' : o.device === 'vulkan' ? 'Vulkan' : 'CPU'} runner${build ? ` (llama.cpp ${build})` : ''}` : 'the model runner';
  const when = o.kind === 'crash' ? `while ${o.modelName || 'the model'} was loaded` : `while loading ${o.modelName || 'the model'}`;
  if (/illegal memory access|illegal address|cudaerrorillegaladdress/.test(t)) return `${runner} crashed ${when}: the NVIDIA card reported an illegal memory access. This is a fault in that runner build on this card, not in your chat; another runner version, or Vulkan, usually avoids it.`;
  if (/cuda error|cublas_status|ggml_cuda|cudamalloc/.test(t) && /out of memory|cudaerrormemoryallocation/.test(t)) return `${runner} ran out of memory on the NVIDIA card ${when}. A smaller context, or putting part of the model in RAM, frees room on the card.`;
  if (/vk::|vulkan|vk_error|errordevicelost/.test(t) && /device ?lost/.test(t)) return `${runner} lost the graphics chip ${when} (Vulkan "device lost"): the card driver reset. A newer driver, or another runner, may help.`;
  if (/out of memory|failed to allocate|unable to allocate|bad_alloc|not enough memory/.test(t)) return `${runner} ran out of memory ${when}. Close other programs, choose a smaller context, or a smaller model.`;
  if (/cuda error/.test(t)) return `${runner} crashed ${when} with a CUDA error. Another runner version, or Vulkan, may avoid it.`;
  if (/ggml_abort|assert|segmentation|access violation|0xc0000005/.test(t)) return `${runner} crashed ${when} (it stopped on an internal error). Another runner version may avoid it.`;
  if (o.kind === 'load') return `${runner} could not load ${o.modelName || 'the model'} on ${o.device ? DEVICE_WORDS[o.device] : 'this PC'}.`;
  return `${runner} stopped on its own ${when}, without saying why (often: the PC ran out of memory, or the card driver reset).`;
}

/**
 * Whether chat model `id`'s file is gone (its drive unplugged, or the file moved or deleted), by `models` (the server's
 * chat models list: a path only for a model it lists, and null for a folder that is not there). A runner that stops then
 * is not at fault. A check that throws says "not gone": the runner's own fault words are kept.
 */
export function modelFileGone(id: string, models: { path(id: string): string | null }, exists: (p: string) => boolean): boolean {
  if (!id) return false;
  try {
    const at = models.path(id);
    return !at || !exists(at);
  } catch {
    return false;
  }
}

/** The fault when the model's file was gone as the runner stopped: the drive or the file, not the runner. */
export function goneWords(o: { device: Device | ''; runnerName: string; kind: FaultKind; modelName: string }): string {
  const name = o.modelName || 'the model';
  const build = /\bb\d{3,6}\b/.exec(o.runnerName)?.[0];
  const runner = o.device ? `the ${o.device === 'cuda' ? 'CUDA' : o.device === 'vulkan' ? 'Vulkan' : 'CPU'} runner${build ? ` (llama.cpp ${build})` : ''}` : 'the model runner';
  return `The file of ${name} is not there any more, so ${runner} stopped ${o.kind === 'crash' ? 'while it was loaded' : 'while loading it'}: the drive it is on may have been unplugged, or the file moved or deleted. This is not a fault in the runner. Plug the drive in again (or put the file back), then load the model again.`;
}

/** The notice's first line: names the PC and the fault. */
export const noticeTitle = (f: Pick<FaultRecord, 'pc'>): string => `An error has occurred with "${f.pc}"`;

const text = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
const stamp = (v: unknown) => (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);
const count = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);
const PIN = /^(llama|sd)-[a-z0-9]{2,16}$/;
const DEVICES: Device[] = ['cuda', 'vulkan', 'cpu'];

/** A fault record that came over the link (or from a file), each field checked and cut short; null when it is not one. */
export function cleanFault(raw: unknown): FaultRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const at = stamp(o.at);
  const fault = text(o.fault, 600);
  if (!at || !fault) return null;
  const tries = Array.isArray(o.tries) ? o.tries.slice(0, 12).map(cleanTry).filter((x): x is TryOption => !!x) : undefined;
  const history = Array.isArray(o.history) ? o.history.slice(0, 12).map(cleanRow).filter((x): x is HistoryRow => !!x) : undefined;
  return {
    id: /^[0-9a-f]{8,32}$/.test(String(o.id)) ? String(o.id) : randomBytes(6).toString('hex'),
    at,
    pc: text(o.pc, 80) || 'A linked PC',
    model: text(o.model, 300),
    modelName: text(o.modelName, 200),
    runner: typeof o.runner === 'string' && PIN.test(o.runner) ? o.runner : '',
    runnerName: text(o.runnerName, 160),
    device: DEVICES.includes(o.device as Device) ? (o.device as Device) : '',
    kind: o.kind === 'load' ? 'load' : 'crash',
    fault,
    detail: cleanDetail(text(o.detail, 4000)),
    ...(tries ? { tries } : {}),
    ...(history ? { history } : {}),
    ...(o.fallback === true ? { fallback: true } : {}),
    ...(typeof o.fallbackSaid === 'string' && o.fallbackSaid ? { fallbackSaid: o.fallbackSaid.slice(0, 400) } : {}),
    ...(typeof o.fellBack === 'string' && PIN.test(o.fellBack) ? { fellBack: o.fellBack } : {}),
    ...(o.gone === true ? { gone: true } : {}),
  };
}

function cleanTry(raw: unknown): TryOption | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (typeof o.pin !== 'string' || !PIN.test(o.pin) || !DEVICES.includes(o.device as Device)) return null;
  return {
    pin: o.pin,
    name: text(o.name, 160),
    device: o.device as Device,
    build: typeof o.build === 'string' && /^b\d{3,6}$/.test(o.build) ? o.build : '',
    kind: o.kind === 'type' || o.kind === 'cpu' ? o.kind : 'version',
    installed: o.installed === true,
    bytes: count(o.bytes),
    why: text(o.why, 300),
    ...(o.worked === true ? { worked: true } : {}),
    ...(o.failedHere === true ? { failedHere: true } : {}),
  };
}

function cleanRow(raw: unknown): HistoryRow | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (typeof o.runner !== 'string' || !PIN.test(o.runner)) return null;
  const w = typeof o.write === 'number' && Number.isFinite(o.write) && o.write >= 0 ? Math.round(o.write * 10) / 10 : null;
  return { runner: o.runner, ok: count(o.ok), failed: count(o.failed), lastOk: stamp(o.lastOk), lastFailed: stamp(o.lastFailed), lastFault: text(o.lastFault, 600), write: w };
}

const keyOf = (pc: string, model: string, runner: string) => `${pc}|${model}|${runner}`;

/** data/run-history.json: for each PC, model and runner, recent whole answers and faults. */
export class RunHistory {
  private data: Record<string, Entry> = {};
  private readonly file: string;
  private flushing: ReturnType<typeof setTimeout> | null = null;
  /** How long successes wait to be written together (ms): an answer is not held up by a write. */
  wait = 3000;

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<this> {
    return this.take(await readData<{ entries?: Record<string, Entry> }>(this.file, {}));
  }

  /** The same, read at once (the server reads it as it starts, with no wait in its imports). */
  loadSync(): this {
    let j: unknown = {};
    try {
      j = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      // not there yet, or damaged: starts empty (the next save writes it whole)
    }
    return this.take(j as { entries?: Record<string, Entry> });
  }

  private take(j: { entries?: Record<string, Entry> } | null): this {
    const e = j && typeof j === 'object' && j.entries && typeof j.entries === 'object' ? j.entries : {};
    // Each entry checked as it is read: a hand-edited or damaged file never breaks the notice.
    for (const [k, v] of Object.entries(e)) {
      if (!v || typeof v !== 'object' || typeof v.pc !== 'string' || typeof v.model !== 'string' || typeof v.runner !== 'string') continue;
      this.data[k] = {
        pc: v.pc,
        model: v.model,
        runner: v.runner,
        ok: (Array.isArray(v.ok) ? v.ok : []).filter(x => !!stamp(x)).slice(-KEEP_OK),
        faults: (Array.isArray(v.faults) ? v.faults : []).map(cleanFault).filter((x): x is FaultRecord => !!x).slice(-KEEP_FAULTS),
        write: typeof v.write === 'number' && Number.isFinite(v.write) ? v.write : null,
      };
    }
    return this;
  }

  private entry(pc: string, model: string, runner: string): Entry {
    const k = keyOf(pc, model, runner);
    return (this.data[k] ??= { pc, model, runner, ok: [], faults: [], write: null });
  }

  /** An answer came back whole on that runner. Written a few seconds later, with any others. */
  success(pc: string, model: string, runner: string, write: number | null = null, at = new Date().toISOString()): void {
    if (!model || !runner) return;
    const e = this.entry(pc, model, runner);
    e.ok = [...e.ok, at].slice(-KEEP_OK);
    if (write && write > 0) e.write = Math.round(write * 10) / 10;
    this.later();
  }

  /** A fault, kept at once (the PC may go down next). Gives the record as kept. */
  async failure(f: FaultRecord): Promise<FaultRecord> {
    const e = this.entry(f.pc, f.model, f.runner);
    // The same fault told twice (the runner's exit, then the chat that saw it) is kept once.
    if (!e.faults.some(x => x.id === f.id)) e.faults = [...e.faults, { ...f, tries: undefined, history: undefined }].slice(-KEEP_FAULTS);
    this.trim();
    await this.save();
    return f;
  }

  /**
   * The record of `model` on `pc`, one row per runner it ran on, the most used first. A fault with the model's file gone
   * (an unplugged drive) is not the runner's: it is not counted here.
   */
  rows(pc: string, model: string): HistoryRow[] {
    return Object.values(this.data)
      .filter(e => e.pc === pc && e.model === model)
      .map(e => {
        const faults = e.faults.filter(f => !f.gone);
        const last = faults.at(-1);
        return { runner: e.runner, ok: e.ok.length, failed: faults.length, lastOk: e.ok.at(-1) ?? null, lastFailed: last?.at ?? null, lastFault: last?.fault ?? '', write: e.write };
      })
      .sort((a, b) => b.ok + b.failed - (a.ok + a.failed));
  }

  /** The record of one runner with one model on one PC. */
  row(pc: string, model: string, runner: string): HistoryRow | null {
    return this.rows(pc, model).find(r => r.runner === runner) ?? null;
  }

  /** Faults since `since` (ms), newest first, on any PC; `model` limits them to one model. */
  recent(o: { since?: number; model?: string; pc?: string; limit?: number } = {}): FaultRecord[] {
    const all = Object.values(this.data).flatMap(e => e.faults);
    return all
      .filter(f => (!o.model || f.model === o.model) && (!o.pc || f.pc === o.pc) && (!o.since || Date.parse(f.at) >= o.since))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, o.limit ?? 20);
  }

  /** One fault by its id. */
  find(id: string): FaultRecord | null {
    for (const e of Object.values(this.data)) for (const f of e.faults) if (f.id === id) return f;
    return null;
  }

  /** Runners that crashed with this model on this PC more often than they answered lately: the fallback leaves them last. */
  shaky(pc: string, model: string): Set<string> {
    return new Set(this.rows(pc, model).filter(r => r.failed > 0 && r.lastFailed && (!r.lastOk || Date.parse(r.lastFailed) >= Date.parse(r.lastOk))).map(r => r.runner));
  }

  /**
   * Runners that worked on this PC lately, with any model: each one that answered whole with a model and has not failed
   * with that model since. The guided flow suggests these first (a runner that runs other models here likely suits the card).
   */
  workedOn(pc: string): Set<string> {
    const out = new Set<string>();
    for (const e of Object.values(this.data)) {
      if (e.pc !== pc || !e.ok.length) continue;
      const lastFault = e.faults.filter(f => !f.gone).at(-1)?.at;
      if (!lastFault || Date.parse(e.ok.at(-1)!) >= Date.parse(lastFault)) out.add(e.runner);
    }
    return out;
  }

  /** Keeps the newest KEEP_ALL faults in all. */
  private trim(): void {
    const all = Object.values(this.data).flatMap(e => e.faults.map(f => ({ e, f })));
    if (all.length <= KEEP_ALL) return;
    const cut = new Set(all.sort((a, b) => Date.parse(a.f.at) - Date.parse(b.f.at)).slice(0, all.length - KEEP_ALL).map(x => x.f));
    for (const e of Object.values(this.data)) e.faults = e.faults.filter(f => !cut.has(f));
  }

  private later(): void {
    if (this.flushing) return;
    this.flushing = setTimeout(() => {
      this.flushing = null;
      void this.save().catch(e => console.error('Could not save the run history:', e));
    }, this.wait);
    this.flushing.unref?.();
  }

  /**
   * Writes successes still waiting for their timer, at once and without waiting (for process 'exit', where nothing
   * async runs): a copy first, then swapped in, as writeAtomic does. Nothing to write: nothing is done.
   */
  saveNow(): void {
    if (!this.flushing) return;
    clearTimeout(this.flushing);
    this.flushing = null;
    const tmp = `${this.file}.${process.pid}-exit.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ entries: this.data }, null, 1), { flush: true });
      renameSync(tmp, this.file);
    } catch {
      // A history that cannot be written as TOMLIN closes loses only these few seconds of successes.
      try {
        rmSync(tmp, { force: true });
      } catch {
        // as above
      }
    }
  }

  /** Writes what is held now (also called once before TOMLIN closes, by the caller). */
  async save(): Promise<void> {
    if (this.flushing) {
      clearTimeout(this.flushing);
      this.flushing = null;
    }
    const now = this.data;
    await updateData<{ entries: Record<string, Entry> }>(this.file, { entries: {} }, () => ({ entries: now }), 1);
  }
}

/** A new fault record (its id made here). */
export function makeFault(o: Omit<FaultRecord, 'id' | 'at' | 'fault' | 'detail'> & { tail: string; at?: string }): FaultRecord {
  const words = { device: o.device, runnerName: o.runnerName, kind: o.kind, modelName: o.modelName };
  return {
    id: randomBytes(6).toString('hex'),
    at: o.at ?? new Date().toISOString(),
    pc: o.pc,
    model: o.model,
    modelName: o.modelName,
    runner: o.runner,
    runnerName: o.runnerName,
    device: o.device,
    kind: o.kind,
    fault: o.gone ? goneWords(words) : faultWords(o.tail, words),
    detail: cleanDetail(o.tail),
    ...(o.gone ? { gone: true } : {}),
  };
}

/**
 * The runners to offer after a fault, best first: other builds of the same kind (another runner version), then the other
 * kind (Vulkan after CUDA, CUDA after Vulkan), then the CPU. The runner that failed is not offered; one that cannot run
 * here stays in the list with its reason (so the person sees why it is not offered), after the ones that can.
 * `pins`: this PC's chat runners (id, device, name, build, installed, bytes, why).
 */
export function tryOptions(failed: { runner: string; device: Device | '' }, pins: Omit<TryOption, 'kind'>[], shaky: Set<string> = new Set()): TryOption[] {
  const kindOf = (p: Omit<TryOption, 'kind'>): TryOption['kind'] => (p.device === 'cpu' ? 'cpu' : failed.device && p.device === failed.device ? 'version' : 'type');
  const order = { version: 0, type: 1, cpu: 2 };
  return pins
    .filter(p => p.pin !== failed.runner)
    .map((p, i) => ({ ...p, kind: kindOf(p), i }))
    .sort((a, b) => Number(!!a.why) - Number(!!b.why) || Number(shaky.has(a.pin)) - Number(shaky.has(b.pin)) || order[a.kind] - order[b.kind] || Number(b.installed) - Number(a.installed) || a.i - b.i)
    .map(({ i: _i, ...p }) => p);
}

/**
 * The guided flow's order (bug 13: "if a runner failed, suggest the next one, test it, and if that fails suggest the
 * next"): the list from tryOptions, each marked from that PC's run history, then put in the order they are suggested.
 * First the card runners that can run there and have not failed with this model there, those that worked there lately
 * (with any model) before the rest; then the CPU; then those that failed with this model there (still listed, never
 * suggested); last the ones that cannot run there, with their reason. Within each, tryOptions' order stays (another
 * version, then the other type; installed before not). `shaky`: failed with this model on that PC lately
 * (RunHistory.shaky); `worked`: worked on that PC lately (RunHistory.workedOn).
 */
export function orderTries(tries: TryOption[], o: { shaky: Set<string>; worked: Set<string> }): TryOption[] {
  const rank = (t: TryOption) => (t.why ? 3 : t.failedHere ? 2 : t.kind === 'cpu' ? 1 : 0);
  return tries
    .map((t, i) => {
      const { worked: _w, failedHere: _f, ...rest } = t;
      return { ...rest, ...(o.worked.has(t.pin) && !o.shaky.has(t.pin) ? { worked: true } : {}), ...(o.shaky.has(t.pin) ? { failedHere: true } : {}), i };
    })
    .sort((a, b) => rank(a) - rank(b) || Number(!!b.worked) - Number(!!a.worked) || a.i - b.i)
    .map(({ i: _i, ...t }) => t);
}

/**
 * The next runner the guided flow suggests: the first in the ordered list that can run there, has not failed with this
 * model there, and was not tried (and failed) in this round (`tried`). Null when the list is used up: the notice says so
 * plainly and offers Report a problem. An older PC's list has no marks, so only `why` and `tried` count there.
 */
export function nextTry(tries: TryOption[], tried: ReadonlySet<string> = new Set()): TryOption | null {
  return tries.find(t => !t.why && !t.failedHere && !tried.has(t.pin)) ?? null;
}

/**
 * The runner an automatic fallback moves a model to after a crash: the first thing to try that can run here, is
 * installed, is a card runner (the CPU is offered, never moved to on its own), and has not crashed with this model lately
 * (so it never goes round in a circle). Null when none is left: the model stays as it is, and the notice says so.
 */
export function fallbackPick(tries: TryOption[], shaky: Set<string>): TryOption | null {
  return tries.find(t => !t.why && t.installed && t.kind !== 'cpu' && !shaky.has(t.pin)) ?? null;
}

/** What a Test now running here says it is doing ('' when none runs): linked PCs' work waits for it, as for the speed finder. */
export const runnerTesting: { busy: () => string } = { busy: () => '' };

export const faultHook: { find: ((model: string | null | undefined, since: number) => Promise<FaultRecord | null>) | null } = { find: null };
