// How fast a cluster engine would write, as arithmetic: an ESTIMATE from measured inputs (each PC's speed through
// weights, the network's round trip), never a run. Used by the plan (docs/PLAN-2026-11-14-CLUSTER-PARALLEL-ENGINE.md),
// by the engines' estimate(), and by the expert planner (src/cluster/experts.ts) to pick each PC's share. One word
// (batch 1, writing, not reading a prompt). Pure functions; tested in test/clusterestimate.test.ts.
import type { Estimate, Member, ModelFacts } from './engine.ts';

/** How fast a PC works through weights while writing (bytes a second, effective: what a measured run gives, not the RAM's rated speed). */
export interface Speeds {
  /** On its graphics card (0: no card). */
  card: number;
  /** On its processor, weights in its RAM. */
  ram: number;
  /** Time each word costs whatever the weights (sampling, the card-to-RAM hop of every layer, the runner's own work). */
  fixedMs?: number;
}

/** The network between the PCs: one small message there and back (measured with the probe in src/cluster/harness.ts), and its speed. */
export interface NetFacts {
  rttMs: number;
  bytesPerSec: number;
}

/** 1 Gbit/s Ethernet as data: about 117 MB/s after the packet overhead. */
export const GIGABIT = 117e6;

const ms = (bytes: number, perSec: number) => (perSec > 0 ? (bytes / perSec) * 1000 : Infinity);
const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : 'n/a');
const gb = (n: number) => `${(n / 1e9).toFixed(2)} GB`;

/** The bytes outside the experts read for each word. */
export const restActive = (m: ModelFacts): number => (m.moe ? (m.moe.restActive ?? m.moe.rest) : m.bytes);
/** The expert bytes read for each word: the chosen experts of every layer. */
export const expertActive = (m: ModelFacts): number => (m.moe ? m.layers * m.moe.expertLayer * (m.moe.used / m.moe.experts) : 0);
/** One expert's bytes in one layer. */
export const expertBytes = (m: ModelFacts): number => (m.moe ? m.moe.expertLayer / m.moe.experts : 0);

/**
 * A PC's effective speed through RAM from a run measured on it alone: `tokPerSec` writing, `bytes` the weights its
 * processor read each word, `otherMs` the time each word spent elsewhere (its card's part and the fixed cost).
 */
export function rateFromRun(tokPerSec: number, bytes: number, otherMs = 0): number {
  const left = 1000 / tokPerSec - otherMs;
  return left > 0 ? (bytes / left) * 1000 : 0;
}

/** n choose r as a float (fine for the sizes here: n up to a few thousand, r up to about 16). */
export function choose(n: number, r: number): number {
  if (r < 0 || r > n) return 0;
  let out = 1;
  for (let i = 1; i <= Math.min(r, n - r); i++) out = (out * (n - Math.min(r, n - r) + i)) / i;
  return out;
}

/** Every way to share `k` picks among `parts` holders (each a list of counts that adds up to k). */
export function compositions(k: number, parts: number): number[][] {
  if (parts === 1) return [[k]];
  const out: number[][] = [];
  for (let first = 0; first <= k; first++) for (const rest of compositions(k - first, parts - 1)) out.push([first, ...rest]);
  return out;
}

/**
 * The expected time of one layer's experts in expert parallel, in ms. `owned[i]`: how many of the layer's `experts`
 * member i holds (they add up to `experts`); `k` are chosen for each word, all different, every expert equally likely
 * (a real router is skewed, which is why hot experts may be copied: see the plan). Member i takes `perExpertMs[i]` for
 * each chosen expert it holds, plus `netMs[i]` when it has any (0 for the PC that does the attention: its own experts
 * run while it waits for the others). The layer is done when the slowest member is done.
 */
export function expectedLayerMs(owned: number[], k: number, perExpertMs: number[], netMs: number[]): number {
  const experts = owned.reduce((a, b) => a + b, 0);
  const all = choose(experts, k);
  if (!(all > 0)) return 0;
  let sum = 0;
  for (const n of compositions(k, owned.length)) {
    let p = 1;
    for (let i = 0; i < n.length; i++) p *= choose(owned[i], n[i]);
    if (!p) continue;
    let worst = 0;
    for (let i = 0; i < n.length; i++) if (n[i] > 0) worst = Math.max(worst, n[i] * perExpertMs[i] + netMs[i]);
    sum += (p / all) * worst;
  }
  return sum;
}

/** What one layer's message costs on the wire for a remote member: the hidden state out, its share of the answer back. */
export function layerNetMs(hidden: number, net: NetFacts, valueBytes = 4): number {
  return net.rttMs + ms(2 * hidden * valueBytes, net.bytesPerSec);
}

const done = (lines: string[], msPerToken: number): Estimate => ({ label: 'estimate', msPerToken, tokPerSec: msPerToken > 0 && Number.isFinite(msPerToken) ? 1000 / msPerToken : 0, lines: [...lines, `= ${f1(msPerToken)} ms a word, about ${f1(1000 / msPerToken)} words (tokens) a second (estimate)`] });

/**
 * The PC alone (no cluster): the non-expert weights on its card when they fit it, the experts in its RAM (the
 * single-PC arrangement TOMLIN uses for a big mixture-of-experts model). Null when its speeds are not known.
 */
export function estimateAlone(model: ModelFacts, m: Member): Estimate | null {
  const s = m.speeds;
  if (!s) return null;
  const rest = restActive(model);
  const onCard = !!m.card && s.card > 0 && m.card.free > rest + model.kv;
  const restMs = ms(rest, onCard ? s.card : s.ram);
  const expMs = ms(expertActive(model), s.ram);
  const fixed = s.fixedMs ?? 0;
  return done([
    `${m.name} alone: ${gb(rest)} outside the experts on its ${onCard ? 'card' : 'processor'} = ${f1(restMs)} ms`,
    `+ ${gb(expertActive(model))} of chosen experts on its processor = ${f1(expMs)} ms`,
    `+ ${f1(fixed)} ms fixed`,
  ], restMs + expMs + fixed);
}

/**
 * Version 1, the layer split: whole layers dealt out (the main loader's card first, then the others by the room each has),
 * and the PCs take turns, so the times ADD. Each PC used costs at least one round trip a word (more through RPC: the
 * measured hop through Max mode was 1 to 2 ms). Approximate: it assumes a PC's layers sit in its RAM except what its
 * card holds. Null when a member's speeds are not known.
 */
export function estimateLayers(model: ModelFacts, members: Member[], net: NetFacts): Estimate | null {
  if (members.some(m => !m.speeds) || !(model.bytes > 0)) return null;
  const perByte = (restActive(model) + expertActive(model)) / model.bytes;
  const host = members.find(m => m.loader) ?? members[0];
  const GB = 2 ** 30;
  const ramRoom = (m: Member) => Math.max(0, m.ramFree - 4.5 * GB);
  const cardRoom = (m: Member) => (m.card ? Math.max(0, m.card.free - (m.loader ? 1.5 : 0.5) * GB) : 0);
  let left = model.bytes + model.kv;
  const parts: { m: Member; where: 'card' | 'ram'; bytes: number }[] = [];
  const take = (m: Member, where: 'card' | 'ram', room: number) => {
    const b = Math.min(left, room);
    if (b > 0) parts.push({ m, where, bytes: b });
    left -= b;
  };
  take(host, 'card', cardRoom(host));
  const others = members.filter(m => m !== host);
  for (const m of others) take(m, 'card', cardRoom(m));
  const ramTotal = others.reduce((n, m) => n + ramRoom(m), 0);
  const want = left;
  for (const m of others) take(m, 'ram', ramTotal > 0 ? Math.min(ramRoom(m), (want * ramRoom(m)) / ramTotal) : 0);
  take(host, 'ram', ramRoom(host));
  const lines: string[] = [];
  let total = 0;
  for (const p of parts) {
    const s = p.m.speeds!;
    const t = ms(p.bytes * perByte, p.where === 'card' && s.card > 0 ? s.card : s.ram);
    lines.push(`${lines.length ? '+ ' : ''}${p.m.name} ${p.where === 'card' ? 'card' : 'RAM'}: ${gb(p.bytes)} of layers, ${gb(p.bytes * perByte)} read a word = ${f1(t)} ms`);
    total += t;
  }
  if (left > 1) lines.push(`(${gb(left)} does not fit: the model cannot load)`);
  const hops = parts.length;
  const fixed = host.speeds!.fixedMs ?? 0;
  lines.push(`+ ${hops} device hops x ${f1(net.rttMs)} ms = ${f1(hops * net.rttMs)} ms, + ${f1(fixed)} ms fixed (the PCs take turns, so all of this adds)`);
  return done(lines, left > 1 ? Infinity : total + hops * net.rttMs + fixed);
}

/**
 * Version 2, expert parallel: the lead (the main loader: attention, shared experts, router and output on its card) and every
 * member computing its own share of each layer's chosen experts at the same time. `owned[i]`: the experts of each
 * layer member i holds. Null when a member's speeds are not known or the model is dense.
 */
export function estimateExperts(model: ModelFacts, members: Member[], owned: number[], net: NetFacts): Estimate | null {
  if (!model.moe || members.some(m => !m.speeds)) return null;
  const lead = members.find(m => m.loader) ?? members[0];
  const s = lead.speeds!;
  const rest = restActive(model);
  const onCard = !!lead.card && s.card > 0 && lead.card.free > rest + model.kv;
  const restMs = ms(rest, onCard ? s.card : s.ram);
  const eb = expertBytes(model);
  const per = members.map(m => ms(eb, m.speeds!.ram));
  const wire = layerNetMs(model.moe.hidden, net);
  const netMs = members.map(m => (m === lead ? 0 : wire));
  const layer = expectedLayerMs(owned, model.moe.used, per, netMs);
  const fixed = s.fixedMs ?? 0;
  return done([
    `${lead.name} leads: ${gb(rest)} outside the experts on its ${onCard ? 'card' : 'processor'} = ${f1(restMs)} ms`,
    `+ ${model.layers} layers x ${f1(layer)} ms (the slowest PC of each layer: ${members.map((m, i) => `${m.name} holds ${owned[i]} of ${model.moe!.experts} experts, ${per[i].toFixed(3)} ms each${netMs[i] ? ` + ${netMs[i].toFixed(2)} ms on the wire` : ''}`).join('; ')}) = ${f1(model.layers * layer)} ms`,
    `+ ${f1(fixed)} ms fixed`,
  ], restMs + model.layers * layer + fixed);
}
