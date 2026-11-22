// Max mode "all" with a mixture-of-experts model: where each tensor goes. llama.cpp's own split hands out WHOLE layers by
// free memory, so a lender's slow processor got most of the layers (attention included): Qwen3-Next-80B Q3 ran at 3.7
// tokens a second through the Z820 that does 8.67 alone, with the experts in RAM and the attention on its card.
// Here the model's layers are dealt out to the PCs by how much RAM each can hold, and inside each PC the experts go to
// its RAM and everything else (attention, shared experts, norms, the cache) to its card, which is what a single PC does.
// Pure functions first (tested in test/maxplace.test.ts), then the glue that reads the lenders' devices.
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';

const MIB = 2 ** 20;
const GB = 2 ** 30;

/**
 * The RAM policy (a design rule; a 24 GB PC lending about 17 GB went unresponsive): the experts are spread so
 * every PC, this one and each lender, keeps about LEND_AIM_KEEP free after the model is placed; a PC with less room is
 * given fewer experts. If that cannot be done, the spread may go down to LEND_REFUSE_KEEP free on a PC; if even that
 * cannot hold the model, the load is refused before anything loads. Nothing ends a loan because memory runs low.
 */
export const LEND_AIM_KEEP = 4 * GB;
export const LEND_REFUSE_KEEP = 2 * GB;
/** What a PC takes beyond the weights (compute buffers, the connection), per PC in use. */
export const LEND_OVERHEAD = 0.5 * GB;
/** A lender under this much free RAM is named in the load note ("holds less this time"). */
export const LEND_SHORT = LEND_AIM_KEEP + 4 * GB;

/** The RAM a PC can be given for weights while keeping `keep` free (bytes; never below 0). */
export function lendRamCap(free: number, keep = LEND_AIM_KEEP): number {
  return Math.max(0, free - keep - LEND_OVERHEAD);
}

/**
 * A lending PC with this much RAM or less lends at most SMALL_PC_SHARE of its free RAM. 14 Nov 2026, the HP 800 (24 GB,
 * about 20.5 GB free): 7 of DeepSeek's layers (about 14.4 GB) worked once and stalled it the next time, 8 (about 17 GB)
 * stalled it, and its TOMLIN stopped answering. Keeping 4 GB free is not enough on a PC that small.
 */
export const SMALL_PC_RAM = 32 * GB;
export const SMALL_PC_SHARE = 0.55;
export const smallPc = (total: number): boolean => total > 0 && total <= SMALL_PC_RAM;

/**
 * The RAM a lending PC can be given for weights: lendRamCap, no more than SMALL_PC_SHARE of its free RAM on a small PC
 * (`total`: its RAM), and no more than `learned` (a lower cap remembered after it stopped answering; src/jobrun/lendcaps.ts).
 */
export function lenderRamCap(free: number, total: number, keep = LEND_AIM_KEEP, learned?: number | null): number {
  let cap = lendRamCap(free, keep);
  if (smallPc(total)) cap = Math.min(cap, free * SMALL_PC_SHARE);
  if (learned && learned > 0) cap = Math.min(cap, learned);
  return Math.max(0, cap);
}

/** One line of `llama-server --rpc ... --list-devices`: "  RPC1: 127.0.0.1:50871 (49072 MiB, 36099 MiB free)". */
/**
 * The buffer type llama.cpp gives RPC device `dev` for -ot: its number among its own server's devices, then that
 * server's address ("RPC1[127.0.0.1:50073]"). The device names that -dev and LLAMA_EXPERT_SPLIT take count up over the
 * whole --rpc list instead, so with two lenders the second one's RAM is device RPC3 but buffer type RPC1[its address].
 */
export function rpcBuffer(listed: Listed[], dev: Pick<Listed, 'name' | 'what'>): string {
  const own = listed.filter(x => /^RPC\d+$/.test(x.name) && x.what === dev.what);
  return `RPC${Math.max(0, own.findIndex(x => x.name === dev.name))}[${dev.what}]`;
}

export interface Listed {
  /** The device name, "CUDA0", "RPC1", "CPU". */
  name: string;
  /** What follows the name: a card's or processor's name, or an RPC device's address. */
  what: string;
  total: number;
  free: number;
}

export function parseListed(out: string): Listed[] {
  const found: Listed[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]+\d*):\s*(.+?)\s*\((\d+) MiB, (\d+) MiB free\)\s*$/.exec(line);
    if (m) found.push({ name: m[1], what: m[2], total: Number(m[3]) * MIB, free: Number(m[4]) * MIB });
  }
  return found;
}

/** The model, as the planner needs it (bytes). */
export interface ModelBytes {
  /** The block count; llama.cpp counts the output as one more layer. */
  layers: number;
  /** Expert weights of one layer. */
  expertLayer: number;
  /** Everything else in the file (attention, shared experts, norms, embeddings, output). */
  rest: number;
  /** The context cache for the whole model. */
  kv: number;
}

/** A lender as rpcFor gives it (same order as its endpoints), with whether its hello said it has a card. */
export interface Lender {
  name: string;
  endpoint: string;
  hasCard: boolean | null;
  /** How fast it works through this model's kind of weights on its card and in its RAM (bytes a second), from its hello; undefined: it sends none (an older TOMLIN); null: none for this kind yet. */
  speed?: { card: number; ram: number } | null;
  /** A lower cap on its RAM (bytes), remembered after it stopped answering during a loan (src/jobrun/lendcaps.ts); unset: none. */
  capRam?: number | null;
}

export interface Plan {
  /** The --rpc endpoints in use (a lender the model does not need is left out). */
  rpc: string[];
  /** -dev, -ts and -ot values. */
  dev: string[];
  split: number[];
  override: string[];
  /** Plain words for the load note and the log. */
  words: string;
  /** Lenders that are short of RAM now, in plain words (they hold less this time). */
  notes: string[];
}

interface Holder {
  who: string;
  /** The device that holds the layers' attention and cache. */
  layerDev: string;
  /** Where its experts go: the buffer type name, or '' when they stay with the layer (a PC with no card). */
  experts: string;
  /** Devices to name in -dev beside the layer device (the PC's RAM device, kept at a split of 0). */
  extraDev: string[];
  /** Free RAM now (bytes). */
  free: number;
  /** Layers it can hold while keeping `keep` free: by RAM, and by its card for the attention and cache. */
  ramAt: (keep: number) => number;
  cardAt: number;
  at: (keep: number) => number;
  /** The most layers it is given. */
  max: number;
  host: boolean;
  endpoint?: string;
  count: number;
}

const GIB = (n: number) => `${(n / GB).toFixed(1)} GB`;

/** The fewest PCs that can hold `layers`, the most room first; this PC (the weakest link) only after the lenders. */
function pick(lenders: Holder[], host: Holder, layers: number, keep: number): { chosen: Holder[]; room: number } {
  const chosen: Holder[] = [];
  let room = 0;
  for (const h of [...lenders].sort((a, b) => b.at(keep) - a.at(keep))) {
    if (room >= layers) break;
    if (h.at(keep) <= 0) continue;
    chosen.push(h);
    room += h.at(keep);
  }
  if (room < layers && host.at(keep) > 0) {
    chosen.push(host);
    room += host.at(keep);
  }
  for (const h of chosen) h.max = h.at(keep);
  return { chosen, room };
}

/**
 * Deals the model's layers out. `listed`: the devices the host's runner sees with every lender connected, in order, with
 * their free memory as it is now; `host`: this PC's free RAM now. Returns the plan, `{ why }` when the usual layer split
 * stays (nothing to place, or the devices could not be read), or `{ why, refuse: true }`: the model cannot be placed
 * without leaving a PC under LEND_REFUSE_KEEP free, so the load must not start.
 */
export function planExperts(m: ModelBytes, listed: Listed[], lenders: Lender[], host: { free: number; cards?: string[] }): Plan | { why: string; refuse?: true } {
  if (!(m.layers > 0) || !(m.expertLayer > 0)) return { why: 'the model has no expert weights to place' };
  // This PC's card: the first it is set to use, else the first card its runner lists.
  const cards = listed.filter(x => !/^(RPC\d+|CPU)$/.test(x.name));
  const hostCard = cards.find(x => host.cards?.includes(x.name)) ?? (host.cards?.length ? undefined : cards[0]);
  if (!hostCard) return { why: 'this PC has no graphics card for the attention' };
  const other = (m.rest + m.kv) / m.layers;
  const e = m.expertLayer;
  const rpcDevs = listed.filter(x => /^RPC\d+$/.test(x.name));
  const skipped: string[] = [];
  const pool: Holder[] = [];
  const holder = (who: string, free: number, ramAt: (keep: number) => number, cardAt: number, extra: Partial<Holder>): Holder => ({ who, layerDev: '', experts: '', extraDev: [], free, ramAt, cardAt, at: keep => Math.min(ramAt(keep), cardAt), max: 0, host: false, count: 0, ...extra });
  for (const l of lenders) {
    const devs = rpcDevs.filter(x => x.what === l.endpoint);
    if (devs.length >= 2) {
      const card = devs[0];
      const ram = devs[devs.length - 1];
      const byCard = Math.floor(Math.max(0, card.free - 1.5 * GB) / other);
      pool.push(holder(l.name, ram.free, keep => Math.floor(lendRamCap(ram.free, keep) / e), byCard, { endpoint: l.endpoint }));
    } else if (devs.length === 1 && l.hasCard === false) {
      // A PC with no card lends its processor and RAM only: the whole layer, experts and attention, stays there.
      const ram = devs[0];
      pool.push(holder(l.name, ram.free, keep => Math.floor(lendRamCap(ram.free, keep) / (e + other)), Infinity, { endpoint: l.endpoint }));
    } else skipped.push(l.name);
  }
  const byHostCard = Math.floor(Math.max(0, hostCard.free - 1.5 * GB) / other);
  const here = holder('this PC', host.free, keep => Math.floor(lendRamCap(host.free, keep) / e), byHostCard, { layerDev: hostCard.name, experts: 'CPU', host: true });
  // The aim first: every PC in use keeps 4 GB free. Short of that, the floor: none left under 2 GB.
  let keep = LEND_AIM_KEEP;
  let { chosen, room } = pick(pool, here, m.layers, keep);
  if (room < m.layers) {
    keep = LEND_REFUSE_KEEP;
    ({ chosen, room } = pick(pool, here, m.layers, keep));
  }
  if (room < m.layers) {
    // Who is left with least when the experts are shared out over every PC in proportion to its free RAM.
    const all = [...pool, here];
    const needed = m.layers * e;
    const totalFree = all.reduce((n, h) => n + h.free, 0) || 1;
    const worst = all.map(h => ({ h, left: h.free - (needed * h.free) / totalFree })).sort((a, b) => a.left - b.left)[0];
    const ramRoom = all.reduce((n, h) => n + h.ramAt(LEND_REFUSE_KEEP), 0);
    const why = ramRoom >= m.layers
      ? `the graphics cards of the PCs cannot hold the attention and cache of its ${m.layers} layers`
      : `${worst.h.host ? 'this PC' : `"${worst.h.who}"`} would be left with ${GIB(Math.max(0, worst.left))} free; this model needs ${GIB(Math.max(0, needed - ramRoom * e))} more room across your PCs than is free now`;
    return { why: `${why}${skipped.length ? ` (${skipped.map(n => `"${n}"`).join(' and ')} lends its card only and is left out)` : ''}`, refuse: true };
  }
  // Layers in proportion to what each can hold, never above it.
  const cap = chosen.reduce((s, h) => s + h.max, 0);
  let left = m.layers;
  for (const h of chosen) {
    h.count = Math.min(h.max, Math.floor((m.layers * h.max) / cap));
    left -= h.count;
  }
  for (let guard = 0; left > 0 && guard < 10_000; guard++) {
    const h = chosen.filter(x => x.count < x.max).sort((a, b) => b.max - b.count - (a.max - a.count))[0];
    if (!h) break;
    h.count++;
    left--;
  }
  const used = chosen.filter(h => h.count > 0);
  // Names: RPC devices count up over the endpoints in use, in --rpc order, each endpoint's devices together.
  const rpc: string[] = [];
  let next = 0;
  const dev: string[] = [];
  const split: number[] = [];
  const override: string[] = [];
  let first = 0;
  const lastUsed = used[used.length - 1];
  for (const h of used) {
    if (!h.host) {
      const l = lenders.find(x => x.endpoint === h.endpoint)!;
      rpc.push(l.endpoint);
      const n = rpcDevs.filter(x => x.what === l.endpoint).length;
      h.layerDev = `RPC${next}`;
      if (n >= 2) {
        // The buffer type counts within this lender's own devices (rpcBuffer); -dev counts over all of them.
        h.experts = `RPC${n - 1}[${l.endpoint}]`;
        h.extraDev = [`RPC${next + n - 1}`];
      }
      next += n;
    }
    dev.push(h.layerDev, ...h.extraDev);
    // The output counts as one more layer to llama.cpp and goes with the last block.
    split.push(h.count + (h === lastUsed ? 1 : 0), ...h.extraDev.map(() => 0));
    if (h.experts) {
      const ids = Array.from({ length: h.count }, (_, i) => first + i);
      override.push(`blk\\.(${ids.join('|')})\\.ffn_.*_exps\\.=${h.experts}`);
    }
    first += h.count;
  }
  const words = used.map(h => `${h.count} layers on ${h.host ? 'this PC' : `"${h.who}"`}`).join(', ');
  const notes = pool.filter(h => h.free < LEND_SHORT).map(h => `"${h.who}" has only ${GIB(h.free)} free: it holds less this time.`);
  if (keep < LEND_AIM_KEEP) notes.push(`Memory is tight: the PCs in use are left with about ${GIB(LEND_REFUSE_KEEP)} free, not ${GIB(LEND_AIM_KEEP)}.`);
  return { rpc, dev, split, override, words, notes };
}

/** Runs the host's runner to list its devices with the lenders connected ('' when it fails). */
export function listWith(exe: string, endpoints: string[], ms = 40_000): Promise<string> {
  return new Promise(resolve => {
    execFile(exe, ['--rpc', endpoints.join(','), '--list-devices'], { windowsHide: true, timeout: ms, cwd: dirname(exe) }, (_e, stdout, stderr) => resolve(`${stdout}\n${stderr}`));
  });
}

/** What the placement needs from the app, so tests can stand in for it. */
export interface Deps {
  list: (exe: string, endpoints: string[]) => Promise<string>;
  model: () => Promise<ModelBytes | null>;
  host: { free: number; cards?: string[] };
}

/**
 * The placement for a load: `exe` is the host's runner for the card device that will start, `lenders` the PCs lending.
 * A plan, or `why` it keeps llama.cpp's layer split (`refuse`: the load must not start).
 */
export async function placement(exe: string, lenders: Lender[], deps: Deps): Promise<Plan | { why: string; refuse?: true }> {
  const m = await deps.model();
  if (!m) return { why: 'the model\'s tensors could not be read' };
  const out = await deps.list(exe, lenders.map(l => l.endpoint));
  const listed = parseListed(out);
  if (!listed.some(x => /^RPC\d+$/.test(x.name))) return { why: 'the lending PCs\' devices could not be listed' };
  return planExperts(m, listed, lenders, deps.host);
}
