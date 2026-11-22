// Expert parallel, the layout TOMLIN works out by itself for a load (cluster part 2, phase 6). The rules come from the
// real runs on the Z240 + Z820 (docs/cluster-native/expert-parallel-real-2026-11-15.md: DeepSeek-V4-Flash 1.84 tok/s
// against 1.16 for the layer split, Qwen3.8 2.45 against 1.69), so a cluster of any PCs gets them with no tuning:
//   - the non-expert part of as many layers as fit goes on this PC's card, never past its free memory (the P2000 spilling
//     into shared memory was the biggest single loss), with output.weight pinned there; the rest stays on this PC's
//     processor, never on a lender's card (0.38 tok/s: every hop crossed the network twice);
//   - small batch buffers (-b 128 -ub 128), which keep the card's compute buffer small;
//   - each PC's run of every layer's experts by its measured speed for this model's kind of weights and its free RAM;
//   - a big lookup table (Qwen3.8's per_layer_token_embd, 26.8 GiB) on the PC where the experts then split fastest.
// The patched runner reads the split from LLAMA_EXPERT_SPLIT (docs/cluster-native/patches 0002, 0003). Pure; tested in
// test/eplayout.test.ts.
import type { Listed } from '../maxplace.ts';
import { lendRamCap, lenderRamCap, LEND_AIM_KEEP } from '../maxplace.ts';
import type { TensorParts } from '../gguf.ts';
import { expectedLayerMs, layerNetMs, GIGABIT, type NetFacts } from './estimate.ts';
import { improveShares } from './experts.ts';

const GB = 2 ** 30;
const gb = (n: number) => `${(n / GB).toFixed(1)} GB`;

/** What this PC's card keeps free beside the layers with -b 32 -ub 32 (compute buffers and the runner's own use). */
export const EP_CARD_KEEP = 0.5 * GB;
/**
 * The batch buffers of an expert-parallel load. 128 words a batch (2.0.95; it was 32): in the app, reading a prompt ran at
 * 2.3 words a second at 32, since every batch is one trip through the 43 layers to the lenders, and a longer batch makes
 * fewer trips. The real runs found a small batch costs generation little (-b 64 gave 1.81 against 1.84 at 32), and the card
 * keeps 0.15 GB more for it.
 */
export const EP_BATCH = 128;
/** The network until a round trip is measured: 1 ms there and back on gigabit (the sealed relay on the Z240 + Z820 link). */
export const EP_NET: NetFacts = { rttMs: 1, bytesPerSec: GIGABIT };

export interface EpModel {
  name: string;
  parts: TensorParts;
  experts: number;
  used: number;
  /** The width of the hidden state that crosses the network for each layer. */
  hidden: number;
  /** The context cache for the whole model (shared over the layers). */
  kv: number;
}

export interface EpPc {
  name: string;
  /** Free and total RAM (bytes). */
  ramFree: number;
  ramTotal: number;
  /** Bytes a second it reads this model's kind of weights on its processor (0: not measured). */
  ramSpeed: number;
}

export interface EpHost extends EpPc {
  /** Its card as the runner lists it ("CUDA0"); null with none. */
  card: Listed | null;
  /** Bytes a second its card reads weights (0: not measured). */
  cardSpeed: number;
}

export interface EpLender extends EpPc {
  /** Its --rpc address, and the runner's device that is its RAM ("RPC1", its "what" the address). */
  endpoint: string;
  ram: Listed;
  /** Its RAM's buffer type for -ot ("RPC1[address]": numbered within its own server, src/maxplace.ts rpcBuffer). */
  buffer?: string;
  /** A lower RAM cap learned when it stopped answering before (src/jobrun/lendcaps.ts). */
  capRam?: number | null;
  /** Its runner has the expert-skip patch (0001): it takes ":skip"; a stock lender gets the zero expert. */
  patched?: boolean;
}

export interface EpLayout {
  /** -dev, -ts, -ngl and -ot for the runner. */
  dev: string[];
  split: number[];
  ngl: number;
  override: string[];
  /** The environment the runner is started with (LLAMA_EXPERT_SPLIT and the rest). */
  env: Record<string, string>;
  batch: number;
  /** The lenders' --rpc addresses (each once, in the order given). */
  rpc: string[];
  /** Each member's run of expert ids (from..to-1), this PC first. */
  shares: { member: string; from: number; to: number }[];
  /** Where each big table goes, by member name. */
  tables: Record<string, string>;
  /** The time of a word by the speed tests (ms; an estimate), or null when a speed is not known. */
  msPerWord: number | null;
  words: string;
  notes: string[];
}

/** Layers whose non-expert part fits this PC's card (the last layers: llama.cpp's -ngl takes them from the end). */
export function cardLayers(parts: TensorParts, kvPerLayer: number, cardFree: number, keep = EP_CARD_KEEP): { ngl: number; output: boolean; bytes: number } {
  let room = Math.max(0, cardFree - keep);
  const output = parts.output > 0 && parts.output <= room;
  if (output) room -= parts.output;
  let ngl = 0;
  let bytes = output ? parts.output : 0;
  for (let i = parts.layerRest.length - 1; i >= 0; i--) {
    const need = parts.layerRest[i] + kvPerLayer;
    if (need > room) break;
    room -= need;
    bytes += need;
    ngl++;
  }
  return { ngl, output, bytes };
}

const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The layout, or why expert parallel does not apply here. `host`: this PC (the main loader) with its card;
 * `lenders`: the lending PCs whose RAM the runner lists, in --rpc order.
 */
export function planEp(m: EpModel, host: EpHost, lenders: EpLender[], net: NetFacts = EP_NET): EpLayout | { why: string } {
  const p = m.parts;
  const L = p.layerRest.length;
  if (!(m.experts > 1) || !(m.used > 0) || !(p.expertLayer > 0) || !L) return { why: `${m.name} is not a mixture-of-experts model` };
  if (!host.card) return { why: 'this PC has no graphics card for the attention' };
  if (!lenders.length) return { why: 'no lending PC lends its RAM' };
  const kvPer = m.kv / L;
  const card = cardLayers(p, kvPer, host.card.free);
  // This PC's RAM holds the layers not on the card, the token table and the small tensors (and output if the card has no room).
  const cpuRest = p.layerRest.slice(0, L - card.ngl).reduce((a, b) => a + b, 0) + kvPer * (L - card.ngl) + p.tokenTable + p.other + (card.output ? 0 : p.output);
  const each = p.expertLayer / m.experts;
  const perExpert = each * L;
  const pcs: EpPc[] = [host, ...lenders];
  const room = (i: number, tablesOn: number) => {
    const cap = i === 0 ? lendRamCap(host.ramFree) - cpuRest : lenderRamCap(lenders[i - 1].ramFree, lenders[i - 1].ramTotal, LEND_AIM_KEEP, lenders[i - 1].capRam ?? null);
    return Math.max(0, cap - tablesOn);
  };
  const known = pcs.every(x => x.ramSpeed > 0);
  const per = pcs.map(x => (x.ramSpeed > 0 ? (each / x.ramSpeed) * 1000 : 0));
  const wire = layerNetMs(m.hidden, net);
  const netMs = pcs.map((_, i) => (i === 0 ? 0 : wire));

  // Each way of placing the big tables (one PC each), the experts split for it; the fastest (or the most room) wins.
  const tables = p.tables;
  let best: { owned: number[]; at: number[]; cost: number } | null = null;
  const ways = tables.length ? Math.pow(pcs.length, Math.min(tables.length, 3)) : 1;
  for (let w = 0; w < ways; w++) {
    const at = tables.map((_, t) => (t < 3 ? Math.floor(w / Math.pow(pcs.length, t)) % pcs.length : 0));
    const on = pcs.map((_, i) => at.reduce((n, a, t) => n + (a === i ? tables[t].bytes : 0), 0));
    const caps = pcs.map((_, i) => Math.min(m.experts, Math.floor(room(i, on[i]) / perExpert)));
    if (caps.reduce((a, b) => a + b, 0) < m.experts) continue;
    const owned = startShares(caps, m.experts, known ? per : null);
    const done = known ? improveShares(owned, caps, m.used, per, netMs) : owned;
    // Unknown speeds: the way with the most room left over.
    const cost = known ? expectedLayerMs(done, m.used, per, netMs) : -caps.reduce((a, b) => a + b, 0);
    if (!best || cost < best.cost - 1e-9) best = { owned: done, at, cost };
  }
  if (!best) {
    const need = perExpert * m.experts + tables.reduce((n, t) => n + t.bytes, 0);
    return { why: `the PCs cannot hold ${m.name}'s experts (${gb(need)} with its tables) while each keeps its RAM free` };
  }

  // The runner's devices: this PC's card, then the lenders' RAM in use. Every layer's non-expert part on the card
  // (-ts 1/0/..) up to -ngl; the rest on this PC's processor. The lenders' cards are never named.
  const shares: EpLayout['shares'] = [];
  const spec: string[] = [];
  let from = 0;
  best.owned.forEach((n, i) => {
    if (n <= 0) return;
    const name = i === 0 ? 'CPU' : lenders[i - 1].ram.name;
    shares.push({ member: pcs[i].name, from, to: from + n });
    spec.push(`${name}=${from}-${from + n - 1}${i > 0 && lenders[i - 1].patched ? ':skip' : ''}`);
    from += n;
  });
  const override: string[] = [];
  if (card.output) override.push(`^output\\.weight=${host.card.name}`);
  const tableAt: Record<string, string> = {};
  tables.forEach((t, k) => {
    const i = best!.at[k];
    tableAt[t.name] = pcs[i].name;
    if (i > 0) override.push(`${escape(t.name)}=${lenders[i - 1].buffer ?? `${lenders[i - 1].ram.name}[${lenders[i - 1].ram.what}]`}`);
  });
  // Every lender stays named: the runner's RPC device names follow the whole --rpc list, as it was listed.
  const usedLenders = lenders;
  const msPerWord = known && host.cardSpeed > 0 ? wordMs(p, card, kvPer, host, best.cost) : null;
  const notes: string[] = [];
  if (card.ngl < L) notes.push(`This PC's card holds the attention of ${card.ngl} of ${L} layers (${gb(card.bytes)} of its ${gb(host.card.free)} free); the other ${L - card.ngl} run on its processor.`);
  if (!known) notes.push('A PC has no speed test figures for this kind of model yet, so the experts are shared by free RAM.');
  const words = `expert parallel: ${shares.map(s => `"${s.member}" holds experts ${s.from} to ${s.to - 1} of every layer`).join(', ')}; "${host.name}" does the attention on its card${Object.entries(tableAt).filter(([, w]) => w !== host.name).map(([t, w]) => `; ${t} in "${w}"'s RAM`).join('')}`;
  return {
    dev: [host.card.name, ...usedLenders.map(l => l.ram.name)],
    split: [1, ...usedLenders.map(() => 0)],
    ngl: card.ngl,
    override,
    env: { LLAMA_EXPERT_SPLIT: spec.join(';'), GGML_CUDA_NO_PINNED: '1' },
    batch: EP_BATCH,
    rpc: [...new Set(usedLenders.map(l => l.endpoint))],
    shares,
    tables: tableAt,
    msPerWord,
    words,
    notes,
  };
}

/** A first split: by speed when known (faster PCs more), else by room; within each cap, adding up to `total`. */
function startShares(caps: number[], total: number, per: number[] | null): number[] {
  const weight = caps.map((c, i) => (per && per[i] > 0 ? Math.min(c, total) / per[i] : c) || 0);
  const sum = weight.reduce((a, b) => a + b, 0) || 1;
  const owned = caps.map((c, i) => Math.min(c, Math.floor((total * weight[i]) / sum)));
  let left = total - owned.reduce((a, b) => a + b, 0);
  for (let pass = 0; left > 0 && pass < 2; pass++)
    for (let i = 0; i < owned.length && left > 0; i++) {
      const add = Math.min(left, caps[i] - owned[i]);
      owned[i] += add;
      left -= add;
    }
  return owned;
}

/** ms a word: the card's layers, the processor's layers, every layer's expert part (expected), and the output. */
function wordMs(p: TensorParts, card: { ngl: number; output: boolean }, kvPer: number, host: EpHost, expertLayerMs: number): number {
  const L = p.layerRest.length;
  let ms = 0;
  p.layerRest.forEach((b, i) => {
    const onCard = i >= L - card.ngl;
    ms += ((b + kvPer) / (onCard ? host.cardSpeed : host.ramSpeed)) * 1000;
  });
  ms += (p.output / (card.output ? host.cardSpeed : host.ramSpeed)) * 1000;
  return ms + expertLayerMs * L;
}
