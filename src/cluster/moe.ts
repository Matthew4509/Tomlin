// A mixture-of-experts layer as plain arithmetic, small enough to check by hand: the reference the expert-parallel
// prototype is measured against. A layer's answer for one word is the router's chosen experts' outputs, each times its
// weight, added up (plus the shared expert). Adding is the same in any order, so the experts can be computed on
// different PCs and their sums added on the lead: that is the whole idea of expert parallel, and test/clustermoe.test.ts
// checks the split answer against this one. The shapes follow Qwen3-Next and Qwen3.8 (SwiGLU experts, softmax router,
// the chosen weights scaled to add up to 1, a shared expert behind a sigmoid gate). Not used to answer chats.

/** One expert: gate and up are ff x hidden, down is hidden x ff, row by row. */
export interface Expert {
  gate: Float32Array;
  up: Float32Array;
  down: Float32Array;
}

export interface MoeLayer {
  hidden: number;
  ff: number;
  /** Experts chosen for each word. */
  used: number;
  /** experts x hidden. */
  router: Float32Array;
  experts: Expert[];
  shared?: Expert;
  /** hidden: the shared expert's gate (its output is scaled by sigmoid(sharedGate . x)). */
  sharedGate?: Float32Array;
}

/** A seeded random source (mulberry32), so a test model is the same on every PC and every run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fill = (n: number, rnd: () => number, scale: number) => Float32Array.from({ length: n }, () => (rnd() * 2 - 1) * scale);
const expert = (hidden: number, ff: number, rnd: () => number): Expert => ({ gate: fill(ff * hidden, rnd, 1 / Math.sqrt(hidden)), up: fill(ff * hidden, rnd, 1 / Math.sqrt(hidden)), down: fill(hidden * ff, rnd, 1 / Math.sqrt(ff)) });

/** A small random layer (the same for the same seed). */
export function testLayer(seed: number, o: { hidden: number; ff: number; experts: number; used: number; shared?: boolean }): MoeLayer {
  const rnd = seeded(seed);
  const experts = Array.from({ length: o.experts }, () => expert(o.hidden, o.ff, rnd));
  return { hidden: o.hidden, ff: o.ff, used: o.used, router: fill(o.experts * o.hidden, rnd, 1), experts, ...(o.shared ? { shared: expert(o.hidden, o.ff, rnd), sharedGate: fill(o.hidden, rnd, 1 / Math.sqrt(o.hidden)) } : {}) };
}

const dot = (w: Float32Array, row: number, x: Float32Array) => {
  let s = 0;
  const at = row * x.length;
  for (let i = 0; i < x.length; i++) s += w[at + i] * x[i];
  return s;
};
const silu = (v: number) => v / (1 + Math.exp(-v));

/** The router's choice for one word: the `used` best experts, their softmax weights scaled to add up to 1. */
export function route(layer: MoeLayer, x: Float32Array): { id: number; weight: number }[] {
  const n = layer.experts.length;
  const logits = Array.from({ length: n }, (_, e) => dot(layer.router, e, x));
  const top = logits.map((v, id) => ({ id, v })).sort((a, b) => b.v - a.v || a.id - b.id).slice(0, layer.used);
  const most = top[0].v;
  const exps = top.map(t => Math.exp(t.v - most));
  const sum = exps.reduce((a, b) => a + b, 0);
  return top.map((t, i) => ({ id: t.id, weight: exps[i] / sum }));
}

/** One expert's output for one word (SwiGLU: down(silu(gate x) * up x)). */
export function expertOut(e: Expert, x: Float32Array, hidden: number, ff: number): Float64Array {
  const mid = new Float64Array(ff);
  for (let r = 0; r < ff; r++) mid[r] = silu(dot(e.gate, r, x)) * dot(e.up, r, x);
  const out = new Float64Array(hidden);
  for (let r = 0; r < hidden; r++) {
    let s = 0;
    const at = r * ff;
    for (let i = 0; i < ff; i++) s += e.down[at + i] * mid[i];
    out[r] = s;
  }
  return out;
}

/** The weighted sum of the chosen experts a PC holds (`has(id)`): its part of the layer's answer. */
export function partial(layer: MoeLayer, x: Float32Array, picks: { id: number; weight: number }[], has: (id: number) => boolean = () => true): Float64Array {
  const sum = new Float64Array(layer.hidden);
  for (const p of picks) {
    if (!has(p.id)) continue;
    const o = expertOut(layer.experts[p.id], x, layer.hidden, layer.ff);
    for (let i = 0; i < sum.length; i++) sum[i] += p.weight * o[i];
  }
  return sum;
}

/** The shared expert's part (zero when the layer has none). */
export function sharedPart(layer: MoeLayer, x: Float32Array): Float64Array {
  if (!layer.shared || !layer.sharedGate) return new Float64Array(layer.hidden);
  let g = 0;
  for (let i = 0; i < x.length; i++) g += layer.sharedGate[i] * x[i];
  const scale = 1 / (1 + Math.exp(-g));
  return expertOut(layer.shared, x, layer.hidden, layer.ff).map(v => v * scale);
}

/** The whole layer on one PC: the reference. */
export function forward(layer: MoeLayer, x: Float32Array): Float64Array {
  const out = partial(layer, x, route(layer, x));
  const sh = sharedPart(layer, x);
  for (let i = 0; i < out.length; i++) out[i] += sh[i];
  return out;
}

/** The next layer's input in the test model: the word's state plus the layer's answer, scaled to unit size (a stand-in for attention and norms). */
export function nextInput(x: Float32Array, out: ArrayLike<number>): Float32Array {
  const y = new Float32Array(x.length);
  let ss = 0;
  for (let i = 0; i < x.length; i++) {
    y[i] = x[i] + out[i];
    ss += y[i] * y[i];
  }
  const r = 1 / Math.sqrt(ss / x.length + 1e-6);
  for (let i = 0; i < y.length; i++) y[i] *= r;
  return y;
}
