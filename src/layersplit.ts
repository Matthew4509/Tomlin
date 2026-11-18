// Max mode, the layer split of any model (dense or mixture-of-experts) over this PC and the PCs lending to it.
// llama.cpp's own fit kept only 1 GB free on each device and filled the lenders in the order it found them: on 13 Nov
// 2026 the HP 800 (24 GB) was given about 17 GB, its runner crashed ("Remote RPC server crashed") and the PC fell off the
// network, while the Z820 (59 GB free) sat unused for minutes. Here every device holds only what leaves its PC the RAM
// policy of src/maxplace.ts (aim 4 GB free, floor 2 GB, refuse below). The devices come from the host runner's
// --list-devices with every lender connected.
// Within that room the layers go BY SPEED when every PC has sent its speed figures (src/speedtest.ts): in a layer split
// the PCs take turns, so a word costs the SUM over the devices of (bytes each reads / its speed), plus a hop for each
// device in use. That sum is smallest with the fastest devices filled first, each up to its room, and a device the model
// does not need left out (14 Nov 2026: by room the Z820's slow processor got 19 of DeepSeek's 43 layers, 1.31 tok/s).
// Without the figures (an older TOMLIN, or a speed test not run yet) they go BY ROOM, as before: this PC's cards first,
// then the lenders in proportion to what each can hold, then this PC's RAM.
// A lender with 32 GB of RAM or less gives at most about half its free RAM, and none when the model fits without it
// (14 Nov 2026: the 24 GB HP 800 stalled with 14 to 17 GB of layers); one that stalled is given less (src/jobrun/lendcaps.ts).
// Pure functions (tested in test/layersplit.test.ts and test/speedsplit.test.ts); the glue that lists the devices is src/jobrun/maxplaced.ts.
import { LEND_AIM_KEEP, LEND_REFUSE_KEEP, lendRamCap, lenderRamCap, smallPc, SMALL_PC_SHARE, type Lender, type Listed } from './maxplace.ts';
import type { Speeds } from './cluster/estimate.ts';

const GB = 2 ** 30;
/** llama.cpp's own fit, when it stays with lenders: MiB it leaves free on every device (its default is 1024, which crashed a 24 GB lender). */
export const FIT_KEEP_WITH_LENDERS = 4096;
/** What a card keeps free beyond the weights it holds (compute buffers; the same figure src/maxplace.ts uses). */
const CARD_KEEP = 1.5 * GB;
/** What each device in use adds to a word beyond its reading (seconds): a lender's device is a round trip through Max mode (1 to 2 ms measured), one of this PC's a hand-over. */
export const HOP_LENDER = 0.002;
export const HOP_HERE = 0.0005;
/** Above this many devices the split by speed fills fastest-first over all of them instead of trying every set (2^n sets). */
const MAX_SET_DEVICES = 12;

/** The model as the split needs it. */
export interface WholeModel {
  /** The block count; llama.cpp counts the output as one more layer. */
  layers: number;
  /** The file's bytes. */
  bytes: number;
  /** The context cache for the whole model. */
  kv: number;
  /** Bytes one layer reads for each word (a mixture-of-experts model reads only its chosen experts); unset: its share of the file. */
  read?: number;
  /** Its kind of quantisation (src/gguf.ts QuantFamily), for the words when a PC has no figure for it. */
  kind?: string;
}

export interface SplitPlan {
  /** -dev names (this PC's cards, then the lenders' devices), -ts layers for each, -ngl the layers off this PC's CPU. */
  dev: string[];
  split: number[];
  ngl: number;
  /** Plain words for the load note and the log. */
  words: string;
  notes: string[];
  /** 'speed': dealt by the PCs' measured speeds; 'room': by room (`byRoom` says why, in plain words). */
  how: 'speed' | 'room';
  byRoom?: string;
  /** With 'speed': the seconds a word should take by the speed tests (an estimate). */
  perWord?: number;
  /** Bytes of layers each lender holds in its RAM, by its name (what a stall teaches from: src/jobrun/lendcaps.ts). */
  ramHeld: Record<string, number>;
}

interface Holder {
  who: string;
  /** The -dev name, or '' for this PC's own processor and RAM (no name: it holds what the devices do not). */
  name: string;
  /** Layers it can hold at a RAM policy of `keep`. */
  at: (keep: number) => number;
  max: number;
  count: number;
  free: number;
  /** A lender's RAM or this PC's RAM (not a card): the RAM policy applies and the free figure is told. */
  ram: boolean;
  host: boolean;
  /** Bytes a second it reads model weights at (its PC's speed test); 0: not known. */
  speed: number;
  /** A lender's RAM on a PC with 32 GB or less: left out when the model fits without it. */
  small?: boolean;
  /** Why its room is lower than the RAM policy alone (plain words), for the note. */
  capped?: string;
}

const gb = (n: number) => `${(n / GB).toFixed(1)} GB`;
/** A speed in plain words: "6.7 GB/s" (decimal, as memory speeds are said). */
export const rateWords = (bytesPerSec: number) => `${(bytesPerSec / 1e9).toFixed(1)} GB/s`;
const place = (h: Holder) => `${h.host ? 'this PC' : `"${h.who}"`}'s ${h.ram ? 'RAM' : 'card'}`;

/** Why the layers go by room this time ('' when every device in play has a speed figure). */
function roomWhy(holders: Holder[], lenders: Lender[], hostSpeed: Speeds | null | undefined, kind?: string): string {
  const old = lenders.filter(l => l.speed === undefined && holders.some(h => !h.host && h.who === l.name)).map(l => `"${l.name}"`);
  const missing: string[] = [];
  if (!hostSpeed || holders.some(h => h.host && !(h.speed > 0))) missing.push('this PC');
  for (const l of lenders) if (!old.includes(`"${l.name}"`) && holders.some(h => !h.host && h.who === l.name && !(h.speed > 0)) && !missing.includes(`"${l.name}"`)) missing.push(`"${l.name}"`);
  const why: string[] = [];
  if (old.length) why.push(`${old.join(' and ')} sends no speed figures (an older TOMLIN)`);
  if (missing.length) why.push(`no speed figure${kind ? ` for ${kindWords(kind)}` : ''} yet from ${missing.join(' and ')} (each PC measures it with a small model of that kind it has)`);
  return why.join('; ');
}

/** A kind of quantisation in plain words. */
const kindWords = (kind: string) => ({ iq: 'i-quant models (IQ2, IQ3 and the like)', k: 'K-quant models (Q4_K and the like)', legacy: 'Q4_0 and Q8_0 models', float: 'unquantised models' } as Record<string, string>)[kind] ?? `${kind} models`;

/**
 * The layers by speed: of every set of devices that can hold `total` layers, the one whose fastest-first fill costs a word
 * the least (each layer `read` bytes at its device's speed, plus a hop for each device in use). Sets the counts; returns
 * the seconds a word should take.
 */
function bySpeed(all: Holder[], total: number, read: number): number {
  const sec = (h: Holder) => read / h.speed;
  const hop = (h: Holder) => (h.host ? HOP_HERE : HOP_LENDER);
  // Fastest first; on a tie this PC first (no network), then the device with the most room.
  const order = all.filter(h => h.max > 0 && h.speed > 0).sort((a, b) => sec(a) - sec(b) || Number(b.host) - Number(a.host) || b.max - a.max);
  const fill = (set: Holder[]): { counts: number[]; cost: number; used: number } | null => {
    let left = total;
    let cost = 0;
    let used = 0;
    const counts = set.map(h => {
      const c = Math.min(h.max, left);
      left -= c;
      if (c > 0) {
        cost += c * sec(h) + hop(h);
        used++;
      }
      return c;
    });
    return left > 0 ? null : { counts, cost, used };
  };
  let best: { set: Holder[]; counts: number[]; cost: number; used: number } | null = null;
  if (order.length <= MAX_SET_DEVICES) {
    for (let mask = 1; mask < 1 << order.length; mask++) {
      const set = order.filter((_, i) => mask & (1 << i));
      const got = fill(set);
      if (got && (!best || got.cost < best.cost - 1e-9 || (Math.abs(got.cost - best.cost) <= 1e-9 && got.used < best.used))) best = { set, ...got };
    }
  } else {
    const got = fill(order);
    if (got) best = { set: order, ...got };
  }
  for (const h of all) h.count = 0;
  if (!best) return Infinity;
  best.set.forEach((h, i) => (h.count = best!.counts[i]));
  return best.cost;
}

/**
 * `listed`: the host runner's devices with every lender connected; `lenders`: as maxLoad gave them (same order as --rpc),
 * with each one's speed figures when its hello sent them; `host`: this PC's free RAM now, the cards it is set to use and
 * its own speed figures. A plan, or `{ why }` (the usual fit stays: the devices could not be read, or this PC has no
 * card), or `{ why, refuse: true }` (the model does not fit the PCs' free memory without leaving one under the 2 GB
 * floor: the load must not start).
 */
export function planLayers(m: WholeModel, listed: Listed[], lenders: Lender[], host: { free: number; cards?: string[]; speed?: Speeds | null }): SplitPlan | { why: string; refuse?: true } {
  if (!(m.layers > 0) || !(m.bytes > 0)) return { why: 'the model\'s size could not be read' };
  const total = m.layers + 1;
  const per = (m.bytes + m.kv) / total;
  const rpcDevs = listed.filter(x => /^RPC\d+$/.test(x.name));
  if (!rpcDevs.length) return { why: 'the lending PCs\' devices could not be listed' };
  const cards = listed.filter(x => !/^(RPC\d+|CPU)$/.test(x.name));
  const hostCards = host.cards?.length ? cards.filter(x => host.cards!.includes(x.name)) : cards.slice(0, 1);
  if (!hostCards.length) return { why: 'this PC has no graphics card to start from' };

  const rate = (s: Speeds | null | undefined, ram: boolean) => (s ? Math.max(0, Number(ram ? s.ram : s.card) || 0) : 0);
  const holders: Holder[] = [];
  const add = (h: Omit<Holder, 'max' | 'count'>) => holders.push({ ...h, max: 0, count: 0 });
  for (const c of hostCards) add({ who: 'this PC', name: c.name, free: c.free, ram: false, host: true, speed: rate(host.speed, false), at: () => Math.floor(Math.max(0, c.free - CARD_KEEP) / per) });
  const skipped: string[] = [];
  for (const l of lenders) {
    const devs = rpcDevs.filter(x => x.what === l.endpoint);
    if (!devs.length) {
      skipped.push(l.name);
      continue;
    }
    devs.forEach((dv, i) => {
      // A lender with a card and its RAM lists the card first and the RAM last; a lender without a card lists RAM only.
      // One device from a lender not known to have a card (its hello not seen yet, or an older PC) counts as its RAM:
      // the RAM policy keeps it 4 GB free, where a card's 1.5 GB filled a 24 GB PC with no card until it fell over.
      const isRam = (devs.length >= 2 && i === devs.length - 1) || (devs.length === 1 && l.hasCard !== true);
      const small = isRam && smallPc(dv.total);
      const learned = isRam && l.capRam && l.capRam > 0 ? l.capRam : null;
      const capped = learned && learned < lenderRamCap(dv.free, dv.total) ? `it is given at most ${gb(learned)}, as it stopped answering with more before`
        : small ? `a PC with ${gb(dv.total)} of RAM lends at most ${Math.round(SMALL_PC_SHARE * 100)}% of its free RAM` : '';
      add({ who: l.name, name: dv.name, free: dv.free, ram: isRam, host: false, speed: rate(l.speed, isRam), ...(small ? { small } : {}), ...(capped ? { capped } : {}), at: keep => Math.floor((isRam ? lenderRamCap(dv.free, dv.total, keep, learned) : Math.max(0, dv.free - CARD_KEEP)) / per) });
    });
  }
  // This PC's processor and RAM: no name in -dev (llama.cpp keeps the layers not offloaded there).
  const here: Holder = { who: 'this PC', name: '', free: host.free, ram: true, host: true, speed: rate(host.speed, true), at: keep => Math.floor(lendRamCap(host.free, keep) / per), max: 0, count: 0 };

  let keep = LEND_AIM_KEEP;
  const room = (k: number) => holders.reduce((n, h) => n + h.at(k), 0);
  if (room(keep) + here.at(keep) < total) keep = LEND_REFUSE_KEEP;
  for (const h of [...holders, here]) h.max = h.at(keep);
  // A small lender's RAM is left out when the model fits the rest with every PC keeping the aimed-for free RAM.
  const smallOut: Holder[] = [];
  if (keep === LEND_AIM_KEEP && holders.some(h => h.small && h.max > 0)) {
    const without = holders.reduce((n, h) => n + (h.small ? 0 : h.max), 0) + here.max;
    if (without >= total) for (const h of holders.filter(x => x.small && x.max > 0)) {
      h.max = 0;
      smallOut.push(h);
    }
  }
  const devices = holders.reduce((n, h) => n + h.max, 0);
  if (devices + here.max < total) {
    const need = Math.max(0, m.bytes + m.kv - (devices + here.max) * per);
    return { why: `this model needs ${gb(need)} more room than the PCs have free (each is kept at least ${gb(LEND_REFUSE_KEEP)} free)${skipped.length ? `; ${skipped.map(n => `"${n}"`).join(' and ')} could not be listed and is left out` : ''}`, refuse: true };
  }

  const notes: string[] = [];
  for (const h of smallOut) notes.push(`${place(h).replace(/^./, c => c.toUpperCase())} is left out: a PC with this little RAM is not a safe lender, and the model fits without it.`);
  // Only the devices that can take layers count: a lender left out anyway needs no figures.
  const byRoom = roomWhy([...holders, here].filter(h => h.max > 0 || h === here), lenders, host.speed, m.kind);
  let perWord: number | undefined;
  if (!byRoom) perWord = bySpeed([...holders, here], total, m.read && m.read > 0 ? m.read : m.bytes / total);
  if (byRoom || !Number.isFinite(perWord!)) {
    perWord = undefined;
    dealByRoom(holders, here, total);
  }

  const used = holders.filter(h => h.count > 0);
  const lastLayers = used.reduce((n, h) => n + h.count, 0);
  let words: string;
  if (perWord !== undefined) {
    // Fastest first, as they were filled; then what was left out, and why.
    const inUse = [...holders, here].filter(h => h.count > 0).sort((a, b) => b.speed - a.speed);
    const slowest = Math.min(...inUse.map(h => h.speed));
    words = `layers by speed: ${inUse.map(h => `${h.count} on ${place(h)} (${rateWords(h.speed)}${h.count >= h.max && h.speed > slowest ? ', as many as it holds' : ''})`).join(', ')}`;
    const out = [...holders, here].filter(h => h.count === 0 && h.max > 0 && h.speed > 0);
    for (const h of out) notes.push(`${place(h).replace(/^./, c => c.toUpperCase())} is left out (${rateWords(h.speed)}): ${h.speed > slowest ? `it holds only ${h.max} layer${h.max === 1 ? '' : 's'}, not worth the hop` : 'slower, and the model does not need its room'}.`);
    notes.push(`About ${(1 / perWord).toFixed(1)} words a second by the speed tests (an estimate).`);
  } else {
    words = [...used, ...(here.count > 0 ? [here] : [])].map(h => `${h.count} layers on ${h.host ? 'this PC' : `"${h.who}"`}${h.ram ? ' (its RAM)' : ''}`).join(', ');
    if (byRoom) notes.push(`Layers dealt by room, not speed: ${byRoom}.`);
  }
  notes.push(...holders.filter(h => h.count > 0 && h.capped).map(h => `${place(h).replace(/^./, c => c.toUpperCase())} holds ${h.count} layer${h.count === 1 ? '' : 's'} at most: ${h.capped}.`));
  notes.push(...holders.filter(h => !h.host && h.ram && h.free < LEND_AIM_KEEP + 4 * GB).map(h => `"${h.who}" has only ${gb(h.free)} free: it holds less this time.`));
  if (keep < LEND_AIM_KEEP) notes.push(`Memory is tight: the PCs in use are left with about ${gb(LEND_REFUSE_KEEP)} free, not ${gb(LEND_AIM_KEEP)}.`);
  const ramHeld: Record<string, number> = {};
  for (const h of holders) if (!h.host && h.ram && h.count > 0) ramHeld[h.who] = (ramHeld[h.who] ?? 0) + h.count * per;
  return { dev: used.map(h => h.name), split: used.map(h => h.count), ngl: lastLayers, words, notes, ramHeld, how: perWord !== undefined ? 'speed' : 'room', ...(byRoom ? { byRoom } : {}), ...(perWord !== undefined ? { perWord } : {}) };
}

/**
 * The layers by room: this PC's cards first (a layer here costs no network hop), then the lenders' devices in proportion
 * to what each can hold, never above it, then this PC's processor and RAM for what is left over.
 */
function dealByRoom(holders: Holder[], here: Holder, total: number): void {
  let left = total;
  for (const h of holders.filter(x => x.host)) {
    h.count = Math.min(h.max, left);
    left -= h.count;
  }
  const lent = holders.filter(x => !x.host);
  const lentRoom = lent.reduce((n, h) => n + h.max, 0);
  const onLent = Math.min(left, lentRoom);
  let toDeal = onLent;
  for (const h of lent) {
    h.count = lentRoom ? Math.min(h.max, Math.floor((onLent * h.max) / lentRoom)) : 0;
    toDeal -= h.count;
  }
  for (let guard = 0; toDeal > 0 && guard < 100_000; guard++) {
    const h = lent.filter(x => x.count < x.max).sort((a, b) => b.max - b.count - (a.max - a.count))[0];
    if (!h) break;
    h.count++;
    toDeal--;
  }
  here.count = left - onLent;
}
