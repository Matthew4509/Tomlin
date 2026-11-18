// Max mode's speed test: how fast this PC works through model weights on its graphics card and on its processor, for
// the layer split by speed (src/layersplit.ts). Free RAM is not speed, and neither is the memory's own speed: on 14 Nov
// 2026, on DeepSeek's i-quants, the Z240 (i7-6700K, DDR4) worked through about 4 GB/s and the Z820 (Xeon E5-2640, DDR3)
// about 6.2. The other way round from their memory: unpacking i-quants keeps a 4-core processor busy, not its RAM.
// So the test is model work, per kind of quantisation (src/gguf.ts QuantFamily): llama-bench (shipped beside the runner)
// writes 32 words with a small model of each kind that is here, once on the processor (-ngl 0) and once on the card
// (-ngl 99). Words a second times the bytes read for each word is the speed for that kind. A kind with no small model
// here has no figure, and a model of that kind is placed by room. The timed pass over a buffer is kept only to say what
// the memory does: it is never used to place layers, as it ranks these PCs the wrong way round.
// It runs when this PC is ticked into the cluster, when Max mode could use it and the figures are missing or stale (a
// month old, the processor or card changed, or a small model of a new kind is here), and never while a model is loaded
// or a loan is live. The figures go to the borrowing PC in this PC's hello; an older TOMLIN sends none.
// Pure parts first (tested in test/speedsplit.test.ts), then the glue.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { QuantFamily } from './gguf.ts';
import { log } from './log.ts';

const GB = 2 ** 30;
/** Figures older than this are measured again. */
export const STALE_DAYS = 30;
/** A figure outside this is a misreading, not a speed (bytes a second: 50 MB/s to 5 TB/s). */
const SANE = [5e7, 5e12] as const;
/** The kinds tested, in this order, at most MAX_KINDS of them (each takes a few seconds). */
export const KINDS: QuantFamily[] = ['iq', 'k', 'legacy', 'float'];
const MAX_KINDS = 3;

/** One kind's figures: bytes a second on the card (0: no card, or not measured) and on the processor. */
export interface KindSpeed {
  card: number;
  ram: number;
}

/** What the test found, as saved here. */
export interface Figures {
  at: string;
  /** Model work per kind of quantisation, with the model it ran (its file name). */
  kinds: Partial<Record<QuantFamily, KindSpeed & { model: string }>>;
  /** The memory's own speed (a timed pass over a buffer): told, never used to place layers. */
  pass: number;
  /** What it was measured on: a change of processor or card measures again. */
  cpu: string;
  cardName: string;
}

/** What a hello carries to a borrower (src/jobrun/node.ts): model work per kind (bytes a second). */
export interface HelloSpeed {
  at: string;
  kinds: Partial<Record<QuantFamily, KindSpeed>>;
}

const sane = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) && v >= SANE[0] && v <= SANE[1] ? v : 0;
};

/** A linked PC's speed figures from its hello; null when it sent none or nothing usable (an older TOMLIN). */
export function cleanSpeed(x: unknown): HelloSpeed | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const kinds: HelloSpeed['kinds'] = {};
  const said = o.kinds && typeof o.kinds === 'object' ? (o.kinds as Record<string, unknown>) : {};
  for (const k of KINDS) {
    const v = said[k] as Record<string, unknown> | undefined;
    const ram = sane(v?.ram);
    if (ram) kinds[k] = { ram, card: sane(v?.card) };
  }
  if (!Object.keys(kinds).length) return null;
  return { at: typeof o.at === 'string' ? o.at.slice(0, 40) : '', kinds };
}

/** What a hello sends: model work per kind, without the names of this PC's parts or models. */
export function forHello(f: Figures | null): HelloSpeed | null {
  if (!f) return null;
  const kinds: HelloSpeed['kinds'] = {};
  for (const [k, v] of Object.entries(f.kinds ?? {}) as [QuantFamily, KindSpeed][]) if (v.ram > 0) kinds[k] = { card: v.card, ram: v.ram };
  return Object.keys(kinds).length ? { at: f.at, kinds } : null;
}

/** The figures for a model of kind `kind`: null when this PC has none for it (the split goes by room). */
export const speedFor = (s: HelloSpeed | null | undefined, kind: QuantFamily | null | undefined): KindSpeed | null => (s && kind ? (s.kinds[kind] ?? null) : null);

/**
 * Why the figures should be measured ('' when they are fresh): none yet, a month old, the processor or card changed, or
 * a small model of a kind not measured yet is here now (`kinds`: the kinds this PC has a test model for).
 */
export function staleWhy(f: Figures | null, hw: { cpu: string; cardName: string; kinds?: QuantFamily[] }, now = Date.now()): string {
  if (!f || !f.kinds) return 'no speed figures yet';
  const age = now - Date.parse(f.at);
  if (!Number.isFinite(age) || age > STALE_DAYS * 864e5) return `the speed figures are over ${STALE_DAYS} days old`;
  if (f.cpu !== hw.cpu) return 'the processor changed';
  if (f.cardName !== hw.cardName) return 'the graphics card changed';
  const measured = Object.keys(f.kinds).length;
  const fresh = (hw.kinds ?? []).filter(k => !f.kinds[k]);
  if (fresh.length && measured < MAX_KINDS) return `a small ${fresh[0]} model is here now, not measured yet`;
  return '';
}

/** A chat model here, as the test needs it. */
export interface BenchModel {
  path: string;
  bytes: number;
  /** Its kind of quantisation (null: not read). */
  kind: QuantFamily | null;
  /** Bytes it reads for each word: the file for a dense model, its non-expert weights and chosen experts for a mixture-of-experts one; 0 when not known. */
  read: number;
}

/**
 * The model llama-bench runs for one kind: one whose bytes read a word are known, between 0.2 and 4 GB, in a file of 16 GB
 * at most (read quickly enough for a test of seconds); the smallest that reads 1 GB or more a word (a smaller one is
 * mostly the runner's own overhead on a card), else the one that reads the most.
 */
export function pickBenchModel(models: BenchModel[], kind?: QuantFamily): BenchModel | null {
  const ok = models.filter(m => (!kind || m.kind === kind) && m.read >= 0.2 * GB && m.read <= 4 * GB && m.bytes <= 16 * GB && /\.gguf$/i.test(m.path));
  const big = ok.filter(m => m.read >= GB).sort((a, b) => a.read - b.read || a.bytes - b.bytes);
  if (big.length) return big[0];
  return ok.sort((a, b) => b.read - a.read)[0] ?? null;
}

/** The kinds this PC can test, in KINDS order (at most MAX_KINDS). */
export const kindsHere = (models: BenchModel[]): QuantFamily[] => KINDS.filter(k => pickBenchModel(models, k)).slice(0, MAX_KINDS);

/** llama-bench's arguments: 32 words, no prompt, twice; `ngl` 0 on the processor, 99 on the card. */
export const benchArgs = (model: string, ngl: number): string[] => ['-m', model, '-p', '0', '-n', '32', '-r', '2', '-ngl', String(ngl), '-o', 'json'];

/** Words a second from llama-bench -o json (the writing test's avg_ts); 0 when it is not there. */
export function parseBench(out: string): number {
  const start = out.indexOf('[');
  const end = out.lastIndexOf(']');
  if (start < 0 || end <= start) return 0;
  try {
    const rows = JSON.parse(out.slice(start, end + 1)) as { n_gen?: unknown; avg_ts?: unknown }[];
    const row = rows.find(r => Number(r.n_gen) > 0);
    const ts = Number(row?.avg_ts);
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
  } catch {
    return 0;
  }
}

/** llama-bench beside a runner program (the RPC server or llama-server), or null when that runner has none. */
export function benchBeside(exe: string | null | undefined): string | null {
  if (!exe) return null;
  const b = join(dirname(exe), process.platform === 'win32' ? 'llama-bench.exe' : 'llama-bench');
  return existsSync(b) ? b : null;
}

/** What the test needs from the app, so tests can stand in for it. */
export interface MeasureDeps {
  /** llama-bench, or null when the runner here has none. */
  bench: string | null;
  models: BenchModel[];
  /** Whether the runner lends a card here, and the card's free memory now (bytes; 0 with none). */
  card: boolean;
  cardFree: number;
  cpu: string;
  cardName: string;
  /** Runs a program and gives its output ('' when it failed). */
  run: (exe: string, args: string[]) => Promise<string>;
  /** Bytes a second from a timed pass over a buffer on every core. */
  pass: () => Promise<number>;
  now?: () => Date;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const rateWords = (n: number) => `${(n / 1e9).toFixed(1)} GB/s`;

/** Runs the test. The figures, with a line for the log that says how each was found. */
export async function measure(d: MeasureDeps): Promise<{ figures: Figures; words: string }> {
  const kinds: Figures['kinds'] = {};
  const said: string[] = [];
  if (!d.bench) said.push('no llama-bench beside the runner');
  else {
    const here = kindsHere(d.models);
    if (!here.length) said.push('no small model here to test with');
    for (const k of here) {
      const model = pickBenchModel(d.models, k)!;
      const ts = parseBench(await d.run(d.bench, benchArgs(model.path, 0)));
      const ram = sane(ts * model.read);
      let card = 0;
      let cardWord = '';
      if (d.card) {
        // The whole file goes on the card.
        if (d.cardFree > model.bytes + 1.5 * GB) {
          const cts = parseBench(await d.run(d.bench, benchArgs(model.path, 99)));
          card = sane(cts * model.read);
          cardWord = card ? `, card ${rateWords(card)}` : ', the card gave no figure';
        } else cardWord = ', the card had too little free memory for it';
      }
      if (ram) kinds[k] = { ram, card, model: baseName(model.path) };
      said.push(ram ? `${k}: processor ${rateWords(ram)}${cardWord} (${baseName(model.path)}, ${ts.toFixed(1)} words a second)` : `${k}: llama-bench gave no figure on ${baseName(model.path)}`);
    }
  }
  const pass = sane(await d.pass());
  said.push(`the memory itself reads ${pass ? rateWords(pass) : 'no figure'} (told only, not used to place layers)`);
  const figures: Figures = { at: (d.now?.() ?? new Date()).toISOString(), kinds, pass, cpu: d.cpu, cardName: d.cardName };
  return { figures, words: said.join('; ') };
}

/** Runs `exe` for at most 3 minutes; its output, or '' when it failed. */
export function runFor(exe: string, args: string[], ms = 180_000): Promise<string> {
  return new Promise(resolve => {
    execFile(exe, args, { windowsHide: true, timeout: ms, cwd: dirname(exe), maxBuffer: 4 * 2 ** 20 }, (e, stdout) => resolve(e ? '' : String(stdout)));
  });
}

/** A timed read of a 256 MB buffer on every core for about two seconds: bytes a second, all cores together. */
export async function ramPass(ms = 2000): Promise<number> {
  const size = 256 * 2 ** 20;
  const shared = new SharedArrayBuffer(size);
  new Int32Array(shared).fill(1);
  const n = Math.max(1, Math.min(16, cpus().length));
  const code = `const { parentPort, workerData } = require('node:worker_threads');
const a = new Int32Array(workerData.buf, workerData.from, workerData.len);
let read = 0, sum = 0; const until = Date.now() + workerData.ms; const t0 = process.hrtime.bigint();
while (Date.now() < until) { for (let i = 0; i < a.length; i += 4) sum += a[i] + a[i + 1] + a[i + 2] + a[i + 3]; read += a.length * 4; }
parentPort.postMessage({ read, ns: Number(process.hrtime.bigint() - t0), sum });`;
  const slice = Math.floor(size / 4 / n / 4) * 4;
  const got = await Promise.all(Array.from({ length: n }, (_, i) => new Promise<{ read: number; ns: number }>(resolve => {
    const w = new Worker(code, { eval: true, workerData: { buf: shared, from: i * slice * 4, len: slice, ms } });
    w.once('message', m => resolve(m as { read: number; ns: number }));
    w.once('error', () => resolve({ read: 0, ns: 1 }));
  })));
  return got.reduce((s, g) => s + (g.ns > 0 ? g.read / (g.ns / 1e9) : 0), 0);
}

// ---- The glue: one test at a time, saved in the data folder ----

export const SPEED_FILE = 'speed-test.json';

export interface SpeedGlue {
  read: () => Promise<Figures | null>;
  write: (f: Figures) => Promise<void>;
  /** Why the test must wait now ('' when it may run): a model loaded, a loan live, a test of runners going. */
  busy: () => string;
  /** Whether Max mode could use this PC's figures: it is allowed to lend, or it borrows from a PC that lends. */
  wanted: () => boolean;
  /** Its processor and card names now. */
  hw: () => { cpu: string; cardName: string };
  /** The chat models here, with their kind and bytes read a word. */
  models: () => Promise<BenchModel[]>;
  deps: (models: BenchModel[]) => MeasureDeps;
}

let glue: SpeedGlue | null = null;
let saved: Figures | null = null;
let running: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;

/** This PC's figures as saved (null: none yet, or saved by an earlier form of the test). */
export const speedNow = (): Figures | null => saved;

/** A saved file as Figures: null when it is not this form (the first form had no kinds: measured again). */
export function cleanFigures(x: unknown): Figures | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Partial<Figures>;
  if (!o.kinds || typeof o.kinds !== 'object' || typeof o.at !== 'string') return null;
  return { at: o.at, kinds: o.kinds, pass: Number(o.pass) || 0, cpu: String(o.cpu ?? ''), cardName: String(o.cardName ?? '') };
}

/** Starts the glue: reads the saved figures, checks 3 minutes after start, then every half hour. */
export async function useSpeedTest(g: SpeedGlue, firstMs = 180_000, everyMs = 1_800_000): Promise<void> {
  glue = g;
  saved = cleanFigures(await g.read().catch(() => null));
  if (timer) clearInterval(timer);
  setTimeout(() => void checkSpeed('start'), firstMs).unref();
  timer = setInterval(() => void checkSpeed('check'), everyMs);
  timer.unref();
}

/**
 * Runs the test when the figures are missing or stale and Max mode could use them (`why` 'ticked': this PC was just
 * ticked into the cluster, which counts as wanted). Waits for the next check while busy. One test at a time.
 */
export function checkSpeed(why: 'start' | 'check' | 'ticked'): Promise<void> {
  if (running || !glue) return running ?? Promise.resolve();
  const g = glue;
  if (why !== 'ticked' && !g.wanted()) return Promise.resolve();
  running = (async () => {
    try {
      const models = await g.models();
      const stale = staleWhy(saved, { ...g.hw(), kinds: kindsHere(models) });
      if (!stale) return;
      const busy = g.busy();
      if (busy) {
        log.info('max', `Speed test waits (${stale}): ${busy}.`);
        return;
      }
      log.info('max', `Speed test for Max mode starts (${stale}).`);
      const { figures, words } = await measure(g.deps(models));
      // A model loaded meanwhile shared the card or the cores: that reading does not count.
      const after = g.busy();
      if (after) {
        log.info('max', `Speed test set aside (${after} meanwhile): ${words}.`);
        return;
      }
      saved = figures;
      await g.write(figures);
      log.info('max', `Speed test done: ${words}.`);
    } catch (e) {
      log.warn('max', `Speed test failed: ${(e as Error).message}`);
    } finally {
      running = null;
    }
  })();
  return running;
}
