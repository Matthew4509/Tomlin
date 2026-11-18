// How each engine behaves with many PCs (10 to 40), as arithmetic: ESTIMATES, not runs. The main loader talks to every
// member directly (a star: no member relays another's traffic), so everything a word needs crosses the main loader's
// own network port. Three engines:
//  - Version 1, layer split: the PCs take turns, so their times add, and every member costs a hop each word.
//  - Version 2, expert parallel: each layer's experts sit on a GROUP of g members (a run of ids each); the main
//    loader sends the hidden state to the members holding chosen experts, one frame after another out of its port,
//    and their answers come back one after another into it. Only k experts are chosen a layer (10 for Qwen3.8), so at
//    most k members work on a layer, whatever the cluster's size: more members than that add room, not speed.
//    Layers are dealt to groups, so the room per PC is the same for any g; g is picked for speed.
//  - Tensor parallel (llama.cpp -sm tensor, for comparison): every layer split over every PC, two syncs a layer
//    through the main loader.
// The layer's time is simulated over many random choices of experts (seeded, so the same every run). Tested in
// test/clusterscale.test.ts; the tables in docs/PLAN-2026-11-14-CLUSTER-PARALLEL-ENGINE.md come from scaleTable().
import type { ModelFacts } from './engine.ts';
import { expertActive, expertBytes, restActive } from './estimate.ts';
import { seeded } from './moe.ts';

/** A network for the many-PC arithmetic. */
export interface ScaleNet {
  name: string;
  /** One small message there and back, between the main loader and a member (no queueing). */
  rttMs: number;
  /** The main loader's port and a member's port, bytes a second. */
  loaderBps: number;
  memberBps: number;
  /** What each member costs the layer split per word through llama.cpp's RPC (several messages, each a round trip). */
  rpcHopMs: number;
}

/** 1 GbE everywhere: about 117 MB/s; 0.5 ms round trip (assumed: Windows TCP, to be measured with the probe). */
export const NET_1G: ScaleNet = { name: '1 GbE', rttMs: 0.5, loaderBps: 117e6, memberBps: 117e6, rpcHopMs: 2.5 };
/** 10 GbE everywhere: about 1.17 GB/s; 0.1 ms round trip (assumed). */
export const NET_10G: ScaleNet = { name: '10 GbE', rttMs: 0.1, loaderBps: 1.17e9, memberBps: 1.17e9, rpcHopMs: 1.0 };
/** The main loader on a 10 GbE port of the switch, every other PC on 1 GbE (assumed 0.3 ms round trip). */
export const NET_MIXED: ScaleNet = { name: 'main loader on 10 GbE, the others on 1 GbE', rttMs: 0.3, loaderBps: 1.17e9, memberBps: 117e6, rpcHopMs: 2.0 };

/** Bytes of one layer frame: the hidden state as 4-byte values, the head and picks, and about 50 bytes of packet headers per 1460. */
export const frameBytes = (hidden: number): number => {
  const payload = hidden * 4 + 4 + 18 + 1 + 6 * 10;
  return payload + Math.ceil(payload / 1460) * 54;
};

/** k different numbers below n (seeded). */
function pick(n: number, k: number, rnd: () => number): number[] {
  const got = new Set<number>();
  while (got.size < k) got.add(Math.floor(rnd() * n));
  return [...got];
}

/**
 * One layer, expected ms, with the layer's `experts` in equal runs over `holders` members and the main loader holding
 * none: frames go out of the main loader's port one after another (the members with the most chosen experts first),
 * each member computes its chosen experts, and the answers come back one after another into the port.
 */
export function layerMs(o: { experts: number; k: number; holders: number; perExpertMs: number; latencyMs: number; frameMs: number }, samples = 4000, seed = 1): number {
  const rnd = seeded(seed);
  let sum = 0;
  const count = new Array<number>(o.holders);
  for (let s = 0; s < samples; s++) {
    count.fill(0);
    for (const id of pick(o.experts, o.k, rnd)) count[Math.floor((id * o.holders) / o.experts)]++;
    const busy = count.filter(n => n > 0).sort((a, b) => b - a);
    const ready = busy.map((n, j) => (j + 1) * o.frameMs + o.latencyMs + n * o.perExpertMs).sort((a, b) => a - b);
    let done = 0;
    for (const r of ready) done = Math.max(done, r) + o.frameMs;
    sum += done;
  }
  return sum / samples;
}

export interface ScaleInput {
  pcs: number;
  net: ScaleNet;
  /** Each member's speed through experts in RAM (bytes a second) and the RAM it can give them (bytes). */
  ramRate: number;
  roomPerPc: number;
  /** The main loader's card speed through the weights outside the experts, and the fixed time of a word. */
  cardRate: number;
  fixedMs: number;
  /** Random choices of experts simulated for each layer time (default 4000; fewer is rougher and quicker). */
  samples?: number;
}

export interface ScaleResult {
  pcs: number;
  net: string;
  /** Whether the members' RAM holds the model's experts. */
  fits: boolean;
  layersMs: number;
  /** Version 2 at its best group size, and every group size tried. */
  experts: { group: number; ms: number; byGroup: { group: number; ms: number }[] };
  tensorMs: number;
}

/** Words a second from ms a word (0 when it does not fit or cannot be worked out). */
export const perSec = (ms: number): number => (ms > 0 && Number.isFinite(ms) ? 1000 / ms : 0);

/** The three engines for one model on `pcs` members (the main loader not counted among them for the experts). */
export function scale(model: ModelFacts, o: ScaleInput): ScaleResult {
  const fits = !!model.moe && (model.layers * model.moe.expertLayer) / o.pcs <= o.roomPerPc;
  const all = restActive(model) + expertActive(model);
  // Version 1: every byte read by a processor in turn, and every member a hop.
  const layersMs = o.fixedMs + (all / o.ramRate) * 1000 + o.pcs * o.net.rpcHopMs;
  // Version 2: the main loader's card part once, then each layer's group.
  const cardMs = (restActive(model) / o.cardRate) * 1000;
  const fb = frameBytes(model.moe?.hidden ?? 0);
  const frameMs = (fb / o.net.loaderBps) * 1000;
  const latencyMs = o.net.rttMs + 2 * (fb / o.net.memberBps) * 1000;
  const perExpertMs = (expertBytes(model) / o.ramRate) * 1000;
  const byGroup: { group: number; ms: number }[] = [];
  if (model.moe) {
    for (let g = 1; g <= Math.min(o.pcs, 4 * model.moe.used); g++) {
      const layer = layerMs({ experts: model.moe.experts, k: model.moe.used, holders: g, perExpertMs, latencyMs, frameMs }, o.samples ?? 4000);
      byGroup.push({ group: g, ms: o.fixedMs + cardMs + model.layers * layer });
    }
  }
  const best = byGroup.reduce((a, b) => (b.ms < a.ms - 1e-9 ? b : a), byGroup[0] ?? { group: 0, ms: Infinity });
  // Tensor parallel: the work split over every PC, two syncs a layer, each gathering and sending back a frame per PC through the main loader.
  const syncMs = o.net.rttMs + 2 * o.pcs * frameMs + 2 * (fb / o.net.memberBps) * 1000;
  const tensorMs = o.fixedMs + (all / (o.ramRate * o.pcs)) * 1000 + 2 * model.layers * syncMs;
  return { pcs: o.pcs, net: o.net.name, fits, layersMs, experts: { group: best.group, ms: best.ms, byGroup }, tensorMs };
}
