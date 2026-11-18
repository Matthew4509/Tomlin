// The Mini cluster's engine: the swappable part that runs one chat model over the cluster's PCs. The cluster page (one
// "PC" whose size is the pool) asks an engine three things: can it run this model on these PCs, how much can the PCs
// hold, and where does everything go. Version 1 is today's llama.cpp RPC layer split (src/layersplit.ts): it adds
// memory, not speed, because the PCs take turns on every word. Version 2 is expert parallel (src/cluster/experts.ts):
// each PC keeps its own share of a mixture-of-experts model's experts and computes the chosen ones at the same time.
// Version 2's real path is not this interface: a Max mode load of a mixture-of-experts model plans its layout in
// src/cluster/eplayout.ts and starts the patched runner in src/jobrun/epload.ts (phase 6). The engine below is the older
// prototype: it plans and estimates, it cannot load a model, and it is off unless TOMLIN_CLUSTER_ENGINE=experts is set
// (even then the cluster falls back to version 1 with a plain line).
// docs/PLAN-2026-11-14-CLUSTER-PARALLEL-ENGINE.md says why and what it would take. Tested in test/clusterengine.test.ts.
import type { ChatRun } from '../llama.ts';
import { lendRamCap, lenderRamCap, type Lender, type Listed } from '../maxplace.ts';
import { planLayers } from '../layersplit.ts';
import { estimateLayers, type Speeds, type NetFacts } from './estimate.ts';

const GB = 2 ** 30;

/**
 * The lenders as a load sees them, from what the cluster's loader hands llama-server (clusterLoad() in
 * src/jobrun/clusterload.ts, or Max mode's maxLoad: the --rpc endpoints and the members' names, same order), with
 * whether each member has a card (from its hello; null when not known).
 */
export function lendersFrom(load: { endpoints: string[]; lent: string[] }, hasCard: (name: string) => boolean | null): Lender[] {
  return load.endpoints.map((endpoint, i) => ({ name: load.lent[i] ?? '', endpoint, hasCard: hasCard(load.lent[i] ?? '') }));
}
/** What a lent card keeps free beyond the weights (the same 0.5 GB src/jobrun/maxhost.ts lentBytes takes off). */
export const CARD_LEND_KEEP = 0.5 * GB;
/** What the main loader's own card keeps free (compute buffers; src/layersplit.ts uses the same). */
export const CARD_LOADER_KEEP = 1.5 * GB;

export type EngineId = 'layers' | 'experts';

/**
 * A PC in the cluster, as the engine needs it. The main loader (number 1: the most RAM, then the most card memory) is
 * the PC that starts the model and talks to every other member directly; the cluster's host (the PC its owner works on,
 * where the project files are) only feeds it and is a member like the others.
 */
export interface Member {
  id: string;
  name: string;
  loader: boolean;
  /** Free and total RAM now (bytes). */
  ramFree: number;
  ramTotal: number;
  /** Its graphics card's free and total memory (bytes); null with no card (or one it does not lend). */
  card: { free: number; total: number } | null;
  /** The llama.cpp builds it can run ("b11284"); empty when it does not say (an older TOMLIN). */
  builds: string[];
  /** How fast it works through weights, measured or worked out from a measured run (src/cluster/estimate.ts). */
  speeds?: Speeds;
}

/** The model, as the engines need it (bytes). */
export interface ModelFacts {
  name: string;
  /** The file's bytes (all parts). */
  bytes: number;
  /** Block count (llama.cpp counts the output as one more layer). */
  layers: number;
  /** The context cache for the whole model. */
  kv: number;
  /** A mixture-of-experts model (unset: dense). */
  moe?: {
    /** Experts in each layer, and how many are chosen for each word. */
    experts: number;
    used: number;
    /** All the experts' weights in one layer (src/gguf.ts expertWeights perLayer). */
    expertLayer: number;
    /** Everything outside the experts (attention, shared experts, norms, embeddings, output). */
    rest: number;
    /** Of `rest`, what is read for every word (the embedding table and a lookup table are read a row at a time). Unset: all of it. */
    restActive?: number;
    /** The width of the hidden state that crosses the network for each layer (the model's embedding length). */
    hidden: number;
  };
}

/** What the engine decided: plain words for the load note, and what the main loader's runner is started with. */
export interface EnginePlan {
  engine: EngineId;
  /** The members that hold part of the model, by name. */
  members: string[];
  words: string;
  notes: string[];
  /** The llama-server run fields this plan sets (version 1: maxPlace). Unset for an engine that is not llama-server. */
  run?: Partial<ChatRun>;
  /** Version 2: which experts of every layer each member holds (ids from..to-1, the same range in every layer). */
  experts?: ExpertShare[];
}

/** A member's share of every layer's experts: a run of expert ids, so its part of each expert tensor is one stretch of the file. */
export interface ExpertShare {
  member: string;
  from: number;
  to: number;
}

/** The engine will not run this load: `why` in plain words; `refuse` when the load must not start at all. */
export interface Refusal {
  why: string;
  refuse?: true;
}

export const refused = (p: EnginePlan | Refusal): p is Refusal => 'why' in p;

/** What a layer split needs to know at load time: the devices the main loader's runner lists with every member connected. */
export interface LoadContext {
  device: 'cuda' | 'vulkan';
  listed: Listed[];
  /** The lenders as maxLoad gave them (same order as --rpc). */
  lenders: Lender[];
  /** This PC's cards it is set to use (src/devices.ts names); unset: the first. */
  cards?: string[];
}

export interface Estimate {
  /** Always 'estimate': arithmetic from the inputs, not a run. */
  label: 'estimate';
  msPerToken: number;
  tokPerSec: number;
  /** The arithmetic, one line a step, for the plan and the load note. */
  lines: string[];
}

export interface ClusterEngine {
  readonly id: EngineId;
  /** Its name on screen. */
  readonly title: string;
  /** Whether the PCs work at the same time (true) or take turns (false). */
  readonly parallel: boolean;
  /** Why this engine cannot run `model` on `members` now ('' when it can). */
  cannot(model: ModelFacts, members: Member[]): string;
  /** The bytes of model the members can hold together with this engine, every PC keeping the RAM policy. */
  pool(members: Member[]): number;
  /** Where everything goes for this load. */
  plan(model: ModelFacts, members: Member[], ctx: LoadContext): EnginePlan | Refusal;
  /** How fast it would write (an estimate; null when a member's speeds are not known). */
  estimate(model: ModelFacts, members: Member[], net: NetFacts): Estimate | null;
}

/** RAM a member can give to weights (src/maxplace.ts policy: keep 4 GB free, 0.5 GB for the runner). */
/** RAM a member can give to weights: the main loader keeps the RAM policy; another member also the small-PC cap (src/maxplace.ts lenderRamCap). */
export const ramRoom = (m: Member): number => (m.loader ? lendRamCap(m.ramFree) : lenderRamCap(m.ramFree, m.ramTotal));
/** Card memory a member can give to weights. */
export const cardRoom = (m: Member): number => (m.card ? Math.max(0, m.card.free - (m.loader ? CARD_LOADER_KEEP : CARD_LEND_KEEP)) : 0);

/** The llama.cpp build every member can run, or '' (the RPC handshake fails on a mix: b11284 with b12250, 12 Nov 2026). */
export function commonBuild(members: Member[]): string {
  const said = members.filter(m => m.builds.length);
  if (!said.length) return '';
  return said[0].builds.find(b => said.every(m => m.builds.includes(b))) ?? '';
}

/**
 * Version 1: llama.cpp's RPC layer split, whole layers dealt out by each device's room (src/layersplit.ts), the main
 * loader's card first. Capacity only: one PC works at a time, so a model that fits the main loader alone is slower through it.
 */
export class LayerSplitEngine implements ClusterEngine {
  readonly id = 'layers' as const;
  readonly title = 'Layer split (adds memory; the PCs take turns)';
  readonly parallel = false;

  cannot(model: ModelFacts, members: Member[]): string {
    if (!members.some(m => m.loader)) return 'the cluster has no main loader';
    if (members.length < 2) return 'the cluster needs at least two PCs';
    if (!(model.layers > 0)) return `the layer count of ${model.name} could not be read`;
    const said = members.filter(m => m.builds.length);
    if (said.length >= 2 && !commonBuild(members)) return 'the PCs run different llama.cpp builds (a mix crashes the layer split): give them all the same runner';
    return '';
  }

  pool(members: Member[]): number {
    return members.reduce((n, m) => n + ramRoom(m) + cardRoom(m), 0);
  }

  plan(model: ModelFacts, members: Member[], ctx: LoadContext): EnginePlan | Refusal {
    const why = this.cannot(model, members);
    if (why) return { why };
    const loader = members.find(m => m.loader)!;
    const got = planLayers({ layers: model.layers, bytes: model.bytes, kv: model.kv }, ctx.listed, ctx.lenders, { free: loader.ramFree, ...(ctx.cards?.length ? { cards: ctx.cards } : {}) });
    if ('why' in got) return got.refuse ? { why: got.why, refuse: true } : { why: got.why };
    return {
      engine: this.id,
      members: members.filter(m => m.loader || ctx.lenders.some(l => l.name === m.name)).map(m => m.name),
      words: got.words,
      notes: got.notes,
      run: { rpc: ctx.lenders.map(l => l.endpoint), maxPlace: { device: ctx.device, dev: got.dev, split: got.split, override: [], ngl: got.ngl } },
    };
  }

  estimate(model: ModelFacts, members: Member[], net: NetFacts): Estimate | null {
    return estimateLayers(model, members, net);
  }
}

/** The engine the cluster uses: version 1 unless TOMLIN_CLUSTER_ENGINE asks for another (hidden; nothing on screen sets it). */
export function engineWanted(said = process.env.TOMLIN_CLUSTER_ENGINE ?? ''): EngineId {
  return /^(experts?|expert-parallel|2|v2)$/i.test(said.trim()) ? 'experts' : 'layers';
}

/**
 * The engine for this load and the line that says why: the one wanted when it can run the model, else version 1 with a
 * note (the expert-parallel prototype always says why it cannot, so this keeps every load on the layer split today).
 */
export function chooseEngine(engines: ClusterEngine[], model: ModelFacts, members: Member[], said = process.env.TOMLIN_CLUSTER_ENGINE ?? ''): { engine: ClusterEngine; note: string } {
  const want = engineWanted(said);
  const fallback = engines.find(e => e.id === 'layers') ?? engines[0];
  if (want === 'layers') return { engine: fallback, note: '' };
  const it = engines.find(e => e.id === want);
  if (!it) return { engine: fallback, note: `Cluster: the ${want} engine is not in this TOMLIN, so the layer split is used.` };
  const why = it.cannot(model, members);
  if (why) return { engine: fallback, note: `Cluster: ${it.title} cannot run ${model.name} (${why}), so the layer split is used.` };
  return { engine: it, note: '' };
}

/** How a chat model fits this PC by itself, before any PC is borrowed (bytes; src/server/panes.ts works them out). */
export interface AloneFacts {
  /** What the model needs: its file and context cache, a tenth more, and 0.8 GB for the runner (panes.ts chatNeed). */
  need: number;
  /** This PC's graphics card memory the model may use now (less 1 GB a card and what other loaded models hold); 0 with no card or on the CPU. */
  card: number;
  /** Free RAM here now, with what a swapped-out model would free (the lending PCs not counted). */
  ram: number;
  /** A mixture-of-experts model (only its chosen experts are read for each word, so RAM holds them well). */
  moe: boolean;
}

/**
 * True when the model fits this PC alone (its card and its RAM, the lending PCs not counted): which of the two a model
 * is. Max mode (the chat's switch) is only for a model that fits (it borrows to try to raise the tokens a second);
 * Cluster is for one that does not (it borrows so the model can run at all). It does not decide all the borrowing:
 * borrowRule below also lends a card to a dense model that fits this PC but spills its card, switch or not.
 * Used by borrowRule and by src/maxmode.ts.
 */
export function fitsOnePc(f: Pick<AloneFacts, 'need' | 'card' | 'ram'>): boolean {
  return f.need <= f.card + f.ram;
}

/**
 * Before a load with the Max switch off (the automatic borrowing that Cluster uses; unchanged by the chat's Max switch):
 * borrow the other PCs or run on this PC alone, and why in plain words. The rule is "never slower
 * than one machine". The layer split adds memory, not speed (the PCs take turns), and the network costs on every word:
 * measured 3 and 14 Nov 2026, a model that fits one PC was slower split (Qwen3.5-35B 7.0 tok/s split, 11.2 alone;
 * Qwen3-Next-80B 4.6 against 10.9), while a dense 24B too big for one card was about 3 times faster with a lent card
 * (12.2 against 4.2). So: borrow only when the model does not fit this PC well alone, or when it is dense, spills off
 * this PC's card, and a lending PC brings a card for the spill.
 */
export function borrowRule(f: AloneFacts, lenderCard: boolean): { borrow: boolean; words: string } {
  const gb = (n: number) => `${(Math.max(0, n) / GB).toFixed(1)} GB`;
  if (f.card > 0 && f.need <= f.card) return { borrow: false, words: `it fits this PC's graphics card (needs ${gb(f.need)}, ${gb(f.card)} free on the card), and one PC alone is faster than a split` };
  const here = f.card + f.ram;
  if (!fitsOnePc(f)) return { borrow: true, words: `it does not fit this PC alone (needs ${gb(f.need)}, ${gb(here)} free here on the card and in RAM)` };
  if (f.moe) return { borrow: false, words: `it fits this PC's card and RAM (needs ${gb(f.need)} of ${gb(here)} free), and a mixture-of-experts model that fits one PC runs faster there than split` };
  if (lenderCard && f.card > 0) return { borrow: true, words: `it is too big for this PC's graphics card (needs ${gb(f.need)}, ${gb(f.card)} free on the card), and a lent card holds the rest faster than this PC's RAM` };
  if (lenderCard) return { borrow: true, words: `this PC has no graphics card free for it, and a lent card runs a dense model faster than this PC's RAM` };
  return { borrow: false, words: `it fits this PC's RAM (needs ${gb(f.need)} of ${gb(here)} free) and no lending PC has a graphics card, so a split would only add the network` };
}
