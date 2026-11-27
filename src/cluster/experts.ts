// Version 2 of the cluster engine, expert parallel (a PROTOTYPE: it plans and estimates; it cannot load a model yet).
// A mixture-of-experts model chooses a few experts (10 of 512 in Qwen3-Next and Qwen3.8) for every word in every layer.
// Here each PC keeps a run of every layer's experts in its own RAM; the lead (the main loader, number 1 of the cluster) keeps
// everything else on its card (attention, shared expert, router, output) and the lookup tables in its RAM. For each
// layer the lead sends the hidden state to the PCs holding chosen experts, computes its own chosen ones meanwhile, and
// adds the answers: the PCs' memory speeds add up instead of taking turns. Only the hidden state crosses the network
// (10 KB for Qwen3.8), never weights. How each PC's share is picked: the expected time of a word (src/cluster/estimate.ts)
// is made as small as it can be within each PC's RAM, so a slow network gives the far PCs fewer experts, and a model
// that fits the lead alone may stay there. Tested in test/clusterexperts.test.ts.
import { cardRoom, ramRoom, type ClusterEngine, type EnginePlan, type Estimate, type ExpertShare, type LoadContext, type Member, type ModelFacts, type Refusal } from './engine.ts';
import { estimateExperts, expertBytes, expectedLayerMs, layerNetMs, restActive, type NetFacts } from './estimate.ts';

const gb = (n: number) => `${(n / 2 ** 30).toFixed(1)} GB`;

/** The model architectures the prototype knows the expert layout of (expert tensors blk.N.ffn_{gate,up,down}_exps, expert id outermost). */
export const EXPERT_ARCHES = ['qwen3moe', 'qwen3next', 'qwen35moe', 'qwen4exp'];

/** What a member can hold for this engine (bytes): its RAM by the RAM policy; the lead also keeps the tables and what its card cannot hold. */
export function expertRoom(model: ModelFacts, m: Member): number {
  if (!model.moe) return 0;
  if (!m.loader) return ramRoom(m);
  const rest = model.moe.rest;
  const onCard = cardRoom(m) >= restActive(model) + model.kv ? restActive(model) + model.kv : 0;
  // The lead's RAM holds the part of `rest` not on its card (the lookup tables at least) and, with no room on the card, the cache too.
  return Math.max(0, ramRoom(m) - (rest + model.kv - onCard));
}

/** How many experts of each layer a member can hold. */
export const expertCap = (model: ModelFacts, m: Member): number => (model.moe ? Math.min(model.moe.experts, Math.floor(expertRoom(model, m) / (expertBytes(model) * model.layers))) : 0);

/** Expert counts as contiguous id runs, members in the order given (the lead first). */
export function sharesOf(members: Member[], owned: number[]): ExpertShare[] {
  const out: ExpertShare[] = [];
  let at = 0;
  members.forEach((m, i) => {
    if (owned[i] > 0) out.push({ member: m.name, from: at, to: at + owned[i] });
    at += owned[i];
  });
  return out;
}

/**
 * Each member's count of every layer's experts (lead first, same order as `members`): within each one's cap, adding up
 * to the model's experts, and with the expected time of a word as small as it can be (when every member's speeds are
 * known; otherwise by room alone, the lead filled first). Null when the members cannot hold every expert.
 */
export function shareExperts(model: ModelFacts, members: Member[], net: NetFacts): number[] | null {
  if (!model.moe) return null;
  const E = model.moe.experts;
  const caps = members.map(m => expertCap(model, m));
  if (caps.reduce((a, b) => a + b, 0) < E) return null;
  const known = members.every(m => m.speeds && m.speeds.ram > 0);
  // Start: the lead takes what it can, then the others by room (a fair first guess whatever the speeds).
  const owned = members.map(() => 0);
  let left = E;
  const order = members.map((_, i) => i).sort((a, b) => Number(members[b].loader) - Number(members[a].loader) || caps[b] - caps[a]);
  for (const i of order) {
    owned[i] = Math.min(caps[i], left);
    left -= owned[i];
  }
  if (!known) return owned;
  const eb = expertBytes(model);
  const wire = layerNetMs(model.moe.hidden, net);
  return improveShares(owned, caps, model.moe.used, members.map(m => (eb / m.speeds!.ram) * 1000), members.map(m => (m.loader ? 0 : wire)));
}

/**
 * Moves runs of experts from one member to another while the expected time of a layer drops (big steps first), each
 * member within its cap. `owned`: the start (changed in place and returned); `per`: ms for one expert of one layer on
 * each member; `netMs`: each member's network time a layer (0 for the main loader). `known`: the times already worked
 * out for these same `used`, `per` and `netMs` (a split tried again, here or in another call, is not worked out twice).
 */
export function improveShares(owned: number[], caps: number[], used: number, per: number[], netMs: number[], known = new Map<string, number>()): number[] {
  const cost = (o: number[]) => {
    const key = o.join(',');
    let c = known.get(key);
    if (c === undefined) known.set(key, (c = expectedLayerMs(o, used, per, netMs)));
    return c;
  };
  let best = cost(owned);
  for (const step of [64, 32, 16, 8, 4, 2, 1]) {
    for (let moved = true, guard = 0; moved && guard < 10_000; guard++) {
      moved = false;
      for (let from = 0; from < owned.length; from++) {
        for (let to = 0; to < owned.length; to++) {
          if (from === to || owned[from] < step || owned[to] + step > caps[to]) continue;
          owned[from] -= step;
          owned[to] += step;
          const c = cost(owned);
          if (c < best - 1e-9) {
            best = c;
            moved = true;
          } else {
            owned[from] += step;
            owned[to] -= step;
          }
        }
      }
    }
  }
  return owned;
}

export class ExpertParallelEngine implements ClusterEngine {
  readonly id = 'experts' as const;
  readonly title = 'Expert parallel (the PCs work at the same time)';
  readonly parallel = true;
  /** The network this engine plans for (measured, or the figure the plan assumes until it is). */
  net: NetFacts;
  /** False in this version: the runner side (the expert workers, the lead's dispatch inside llama.cpp) is not built. */
  built: boolean;

  constructor(net: NetFacts, built = false) {
    this.net = net;
    this.built = built;
  }

  cannot(model: ModelFacts, members: Member[]): string {
    if (!model.moe) return `${model.name} is not a mixture-of-experts model (this engine shares out experts)`;
    if (!members.some(m => m.loader)) return 'the cluster has no main loader';
    if (members.length < 2) return 'the cluster needs at least two PCs';
    if (!shareExperts(model, members, this.net)) return `the PCs cannot hold all of ${model.name}'s experts while each keeps its RAM free`;
    if (!this.built) return 'it is a prototype in this TOMLIN: it plans and estimates, but cannot load a model yet';
    return '';
  }

  pool(members: Member[]): number {
    return members.reduce((n, m) => n + ramRoom(m) + (m.loader ? cardRoom(m) : 0), 0);
  }

  plan(model: ModelFacts, members: Member[], _ctx?: LoadContext): EnginePlan | Refusal {
    if (!model.moe) return { why: `${model.name} is not a mixture-of-experts model` };
    const owned = shareExperts(model, members, this.net);
    if (!owned) {
      const room = members.reduce((n, m) => n + expertRoom(model, m), 0);
      const need = model.layers * model.moe.expertLayer;
      return { why: `${model.name}'s experts need ${gb(need)} and the PCs have ${gb(room)} free for them (each keeps 4 GB free)`, refuse: true };
    }
    const shares = sharesOf(members, owned);
    const lead = members.find(m => m.loader)!;
    const notes: string[] = [];
    if (shares.length === 1) notes.push(`The other PCs would slow ${model.name} down on this network, so it runs on "${lead.name}" alone.`);
    if (!this.built) notes.push('Prototype: this plan cannot be loaded yet; the layer split is used.');
    const words = shares.map(s => `"${s.member}" holds experts ${s.from} to ${s.to - 1} of every layer`).join(', ');
    return { engine: this.id, members: shares.map(s => s.member), words: `${words}; "${lead.name}" does the attention on its card`, notes, experts: shares };
  }

  estimate(model: ModelFacts, members: Member[], net: NetFacts = this.net): Estimate | null {
    const owned = shareExperts(model, members, net);
    return owned ? estimateExperts(model, members, owned, net) : null;
  }
}

/**
 * The speed rule: the cluster is never slower than its main loader alone. Before a load, shareExperts only moves experts
 * off the main loader when the expected word gets faster, so a model the main loader can hold starts there and stays
 * there unless sharing wins on paper. After a load, the words are timed both ways and this rule decides on the real
 * figures: the split is kept only when it is at least as fast as the main loader alone. `aloneMs` null: the model does
 * not fit the main loader alone, so the split is the only way to run it (and beats the layer split, which is checked
 * by the plan's figures, not here).
 */
export function speedRule(t: { aloneMs: number | null; splitMs: number }, loader = 'the main loader'): { split: boolean; words: string } {
  const f = (ms: number) => `${ms.toFixed(1)} ms`;
  if (t.aloneMs === null) return { split: true, words: `the model does not fit ${loader} alone, so it is shared out (${f(t.splitMs)} a word)` };
  if (t.splitMs <= t.aloneMs) return { split: true, words: `shared out it takes ${f(t.splitMs)} a word, ${loader} alone ${f(t.aloneMs)}: shared it stays` };
  return { split: false, words: `shared out it took ${f(t.splitMs)} a word, ${loader} alone ${f(t.aloneMs)}: it runs on ${loader} alone, so it is never slower than one PC` };
}
