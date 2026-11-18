// Reads the few numbers TOMLIN needs from a .gguf model's header (no tensors are read): layers, attention
// heads, head size, trained context, and whether it is a mixture-of-experts model. From those, how much memory a
// context of N tokens costs. The header is read in small pieces; the long token lists are skipped, never kept.
// The plain functions are tested in test/gguf.test.ts.
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

export interface ModelShape {
  arch: string;
  layers: number;
  /** Layers that keep a per-token cache (all of them, except in hybrid models such as Qwen3-Next / Qwen3.5). */
  attentionLayers: number;
  kvHeads: number;
  keyLength: number;
  valueLength: number;
  trainedContext: number;
  experts: number;
  /** Experts chosen for each word (a mixture-of-experts model; unset when the file does not say). */
  expertsUsed?: number;
  /** Sliding-window models: the window in tokens, and one full layer in every `swaEvery` (the others keep only the window). 0 = none. */
  swaWindow: number;
  swaEvery: number;
  /**
   * Layers of the model's own guesser (an MTP head, `<arch>.nextn_predict_layers`): it guesses the next few words from
   * inside the model, with no second model. 0 or unset: none, and the runner refuses to start such a file with one.
   */
  mtp?: number;
  /**
   * Its words list, as llama.cpp compares two models for guessing (src/runset.ts sameWordsList): the tokenizer kind,
   * how many words, the start and end words, and a hash of the words from the 6th to the 32,005th. Unset: not known.
   */
  vocab?: string;
}

/** The window of a words list that is hashed: llama.cpp skips the first five words when it compares two lists. */
const WORDS_FROM = 5;
const WORDS_TO = 32_005;

/** One full-context layer in every N, for sliding-window families whose header does not say (llama.cpp's own values). */
const SWA_EVERY: Record<string, number> = { gemma2: 2, gemma3: 6, gemma3n: 5, cohere2: 4 };

type Value = number | bigint | string | boolean | Value[] | null;

/** A reader over a file that pulls 64 KB at a time. */
class Reader {
  private buf = Buffer.alloc(0);
  private at = 0;
  private filePos = 0;
  private fh: import('node:fs/promises').FileHandle;
  private size: number;
  constructor(fh: import('node:fs/promises').FileHandle, size: number) {
    this.fh = fh;
    this.size = size;
  }
  async need(n: number): Promise<void> {
    if (this.buf.length - this.at >= n) return;
    const keep = this.buf.subarray(this.at);
    const want = Math.max(n - keep.length, 1 << 16);
    const chunk = Buffer.alloc(Math.min(want, this.size - this.filePos));
    const { bytesRead } = await this.fh.read(chunk, 0, chunk.length, this.filePos);
    this.filePos += bytesRead;
    this.buf = Buffer.concat([keep, chunk.subarray(0, bytesRead)]);
    this.at = 0;
    if (this.buf.length < n) throw new Error('The model file ends inside its header.');
  }
  /** The next `n` bytes (need(n) first). */
  take(n: number): Buffer { const b = this.buf.subarray(this.at, this.at + n); this.at += n; return b; }
  async u32() { await this.need(4); const v = this.buf.readUInt32LE(this.at); this.at += 4; return v; }
  async u64() { await this.need(8); const v = this.buf.readBigUInt64LE(this.at); this.at += 8; return v; }
  async skip(n: number) { while (n > 0) { const step = Math.min(n, 1 << 20); await this.need(step); this.at += step; n -= step; } }
  async str(): Promise<string> {
    const n = Number(await this.u64());
    if (n > 1 << 20) throw new Error('A header text is too long.');
    await this.need(n);
    const s = this.buf.toString('utf8', this.at, this.at + n);
    this.at += n;
    return s;
  }
  async scalar(type: number): Promise<Value> {
    const sizes: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
    if (type === 8) return this.str();
    const n = sizes[type];
    if (!n) throw new Error(`Unknown header value type ${type}.`);
    await this.need(n);
    const b = this.buf;
    const i = this.at;
    this.at += n;
    switch (type) {
      case 0: return b.readUInt8(i);
      case 1: return b.readInt8(i);
      case 2: return b.readUInt16LE(i);
      case 3: return b.readInt16LE(i);
      case 4: return b.readUInt32LE(i);
      case 5: return b.readInt32LE(i);
      case 6: return b.readFloatLE(i);
      case 7: return b.readUInt8(i) !== 0;
      case 10: return b.readBigUInt64LE(i);
      case 11: return b.readBigInt64LE(i);
      default: return b.readDoubleLE(i);
    }
  }
}

/** Every header value whose key is wanted (arrays of numbers kept when short; long lists skipped). */
export async function readHeader(path: string, wanted: (key: string) => boolean): Promise<Map<string, Value>> {
  return (await readFile(path, wanted, false)).values;
}

interface Tensor {
  name: string;
  dims: number[];
  type: number;
}

/** The header values wanted and, when asked, the tensor list after them (names, sizes and quant types; no weights). */
async function readFile(path: string, wanted: (key: string) => boolean, withTensors: boolean): Promise<{ values: Map<string, Value>; tensors: Tensor[] }> {
  const size = (await stat(path)).size;
  const fh = await open(path, 'r');
  try {
    const r = new Reader(fh, size);
    if ((await r.u32()) !== 0x46554747) throw new Error('This is not a GGUF model file.');
    const version = await r.u32();
    if (version < 2) throw new Error('This GGUF file is too old to read.');
    const tensorCount = Number(await r.u64());
    const count = Number(await r.u64());
    const out = new Map<string, Value>();
    for (let k = 0; k < count && k < 10_000; k++) {
      const key = await r.str();
      const type = await r.u32();
      if (type === 9) {
        const itemType = await r.u32();
        const n = Number(await r.u64());
        const keep = wanted(key) && itemType !== 8 && n <= 4096;
        const items: Value[] = [];
        if (itemType === 8 && wanted(key)) {
          // A list of words wanted (the tokenizer's): kept as its length and a hash of a fixed window of it, not whole.
          const hash = createHash('sha1');
          for (let i = 0; i < n; i++) {
            const len = Number(await r.u64());
            if (i >= WORDS_FROM && i < WORDS_TO) {
              if (len > 1 << 20) throw new Error('A header text is too long.');
              await r.need(len);
              hash.update(r.take(len));
              hash.update('\u0000');
            } else await r.skip(len);
          }
          out.set(key, `${n}:${hash.digest('hex').slice(0, 20)}`);
        } else if (itemType === 8) for (let i = 0; i < n; i++) await r.skip(Number(await r.u64()));
        else if (keep) for (let i = 0; i < n; i++) items.push(await r.scalar(itemType));
        else {
          const sizes: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
          if (!sizes[itemType]) throw new Error(`Unknown header list type ${itemType}.`);
          await r.skip(n * sizes[itemType]);
        }
        if (keep) out.set(key, items);
      } else {
        const v = await r.scalar(type);
        if (wanted(key)) out.set(key, v);
      }
    }
    const tensors: Tensor[] = [];
    for (let k = 0; withTensors && k < tensorCount && k < 100_000; k++) {
      const name = await r.str();
      const n = await r.u32();
      if (n > 8) throw new Error('A tensor has too many dimensions.');
      const dims: number[] = [];
      for (let i = 0; i < n; i++) dims.push(Number(await r.u64()));
      const type = await r.u32();
      await r.u64();
      tensors.push({ name, dims, type });
    }
    return { values: out, tensors };
  } finally {
    await fh.close();
  }
}

/** ggml's quant types: bytes a block and values a block (llama.cpp's ggml.c type traits). */
const TYPE_SIZE: Record<number, [number, number]> = {
  0: [4, 1], 1: [2, 1], 2: [18, 32], 3: [20, 32], 6: [22, 32], 7: [24, 32], 8: [34, 32], 9: [36, 32],
  10: [84, 256], 11: [110, 256], 12: [144, 256], 13: [176, 256], 14: [210, 256], 15: [292, 256],
  16: [66, 256], 17: [74, 256], 18: [98, 256], 19: [50, 256], 20: [18, 32], 21: [110, 256], 22: [82, 256], 23: [136, 256],
  24: [1, 1], 25: [2, 1], 26: [4, 1], 27: [8, 1], 28: [8, 1], 29: [56, 256], 30: [2, 1], 34: [54, 256], 35: [66, 256], 39: [17, 32],
};

/**
 * A mixture-of-experts file's expert weights: bytes a layer (the average over the layers that have experts; 0 for a
 * dense model) and the bytes of everything else. Read from the tensor list, not the weights. Null when it cannot be read
 * or a quant type is not known.
 */
export async function expertWeights(path: string): Promise<{ layers: number; perLayer: number; rest: number } | null> {
  try {
    const { tensors } = await readFile(path, () => false, true);
    let experts = 0;
    let rest = 0;
    const layers = new Set<string>();
    for (const t of tensors) {
      const size = TYPE_SIZE[t.type];
      if (!size) return null;
      const bytes = (t.dims.reduce((a, b) => a * b, 1) / size[1]) * size[0];
      const m = /^blk\.(\d+)\.ffn_\w*_exps\./.exec(t.name);
      if (m) {
        experts += bytes;
        layers.add(m[1]);
      } else rest += bytes;
    }
    return { layers: layers.size, perLayer: layers.size ? Math.round(experts / layers.size) : 0, rest: Math.round(rest) };
  } catch {
    return null;
  }
}

/**
 * The kind of quantisation a model's weights mostly use, by bytes: 'iq' (the i-quants, IQ1 to IQ4: slow to unpack on a
 * processor), 'k' (Q2_K to Q8_K), 'legacy' (Q4_0, Q5_0, Q8_0 and the like), 'float' (F16, BF16, F32), 'other'. A
 * processor's speed through weights depends on it: 14 Nov 2026 on DeepSeek's i-quants the Z240 (i7-6700K, DDR4) read
 * about 4 GB/s and the Z820 (Xeon E5-2640, DDR3) about 6.2, the other way round from their memory speeds.
 */
export type QuantFamily = 'iq' | 'k' | 'legacy' | 'float' | 'other';
export const QUANT_FAMILIES: QuantFamily[] = ['iq', 'k', 'legacy', 'float', 'other'];
export function familyOfType(type: number): QuantFamily {
  if ((type >= 16 && type <= 23) || type === 29) return 'iq';
  if (type >= 10 && type <= 15) return 'k';
  if ([2, 3, 6, 7, 8, 9].includes(type)) return 'legacy';
  if (type === 0 || type === 1 || type === 30) return 'float';
  return 'other';
}

/** The parts of a split file ("-00001-of-00003.gguf": all three, in order), or the file alone. */
export function partsOf(path: string): string[] {
  const m = /^(.*-)(\d{5})-of-(\d{5})(\.gguf)$/i.exec(path);
  if (!m) return [path];
  const n = Number(m[3]);
  return Array.from({ length: n }, (_, i) => `${m[1]}${String(i + 1).padStart(5, '0')}-of-${m[3]}${m[4]}`);
}

/** The tensor list of a model over all its parts (the first part of a split file may hold only the header: DeepSeek-V4-Flash's does). */
async function tensorsOf(path: string): Promise<Tensor[]> {
  const out: Tensor[] = [];
  for (const part of partsOf(path)) out.push(...(await readFile(part, () => false, true)).tensors);
  return out;
}

/**
 * The bytes a model reads for each word it writes, from its tensor list: every tensor, except that the token embedding
 * table gives one row a word (unless the output reuses it: no output.weight), and a mixture-of-experts layer reads only
 * its chosen experts (`used` of `experts`). Null when the file cannot be read.
 */
export async function wordBytes(path: string, moe?: { experts: number; used: number } | null): Promise<number | null> {
  try {
    const tensors = await tensorsOf(path);
    if (!tensors.length) return null;
    const tied = !tensors.some(t => t.name === 'output.weight');
    const share = moe && moe.experts > 0 && moe.used > 0 ? Math.min(1, moe.used / moe.experts) : 1;
    let sum = 0;
    for (const t of tensors) {
      const size = TYPE_SIZE[t.type];
      if (!size) return null;
      const bytes = (t.dims.reduce((a, b) => a * b, 1) / size[1]) * size[0];
      if (t.name === 'token_embd.weight' && !tied) sum += bytes / Math.max(1, t.dims[1] ?? 1);
      else if (/^blk\.\d+\.ffn_\w*_exps\./.test(t.name)) sum += bytes * share;
      else sum += bytes;
    }
    return Math.round(sum);
  } catch {
    return null;
  }
}

/** A mixture-of-experts model's parts as expert parallel places them (bytes; src/cluster/eplayout.ts). */
export interface TensorParts {
  /** Each block layer's weights outside its experts (attention, shared expert, router, norms), in layer order. */
  layerRest: number[];
  /** All the experts of one layer (the average over the layers that have experts). */
  expertLayer: number;
  /** `output.weight` (0 when the output reuses the token table). */
  output: number;
  /** The token table (read a row a word, so it stays in this PC's RAM). */
  tokenTable: number;
  /** Other tensors outside the layers of 1 GiB or more (Qwen3.8's `per_layer_token_embd`, 26.8 GiB): they may go to another PC. */
  tables: { name: string; bytes: number }[];
  /** Everything else outside the layers (norms and small tables). */
  other: number;
}

/** A model's parts from its tensor list over all its parts; null when it cannot be read or has no expert tensors. */
export async function tensorParts(path: string): Promise<TensorParts | null> {
  try {
    return partsFrom(await tensorsOf(path));
  } catch {
    return null;
  }
}

/** The arithmetic of tensorParts, on a tensor list (tested on its own). */
export function partsFrom(tensors: { name: string; dims: number[]; type: number }[]): TensorParts | null {
  const rest = new Map<number, number>();
  const expertLayers = new Set<number>();
  let experts = 0;
  const out: TensorParts = { layerRest: [], expertLayer: 0, output: 0, tokenTable: 0, tables: [], other: 0 };
  for (const t of tensors) {
    const size = TYPE_SIZE[t.type];
    if (!size) return null;
    const bytes = (t.dims.reduce((a, b) => a * b, 1) / size[1]) * size[0];
    const m = /^blk\.(\d+)\./.exec(t.name);
    if (m) {
      const layer = Number(m[1]);
      if (/^blk\.\d+\.ffn_\w*_exps\./.test(t.name)) {
        experts += bytes;
        expertLayers.add(layer);
        rest.set(layer, rest.get(layer) ?? 0);
      } else rest.set(layer, (rest.get(layer) ?? 0) + bytes);
    } else if (t.name === 'output.weight') out.output += bytes;
    else if (t.name === 'token_embd.weight') out.tokenTable += bytes;
    else if (bytes >= 2 ** 30) out.tables.push({ name: t.name, bytes });
    else out.other += bytes;
  }
  if (!expertLayers.size) return null;
  const top = Math.max(...rest.keys());
  out.layerRest = Array.from({ length: top + 1 }, (_, i) => Math.round(rest.get(i) ?? 0));
  out.expertLayer = Math.round(experts / expertLayers.size);
  return out;
}

/** The family most of a file's weight bytes are in (the 1-D tensors, norms and biases, left out); null when it cannot be read. */
export async function quantFamily(path: string): Promise<QuantFamily | null> {
  try {
    const tensors = await tensorsOf(path);
    const bytes = new Map<QuantFamily, number>();
    for (const t of tensors) {
      const size = TYPE_SIZE[t.type];
      if (!size || t.dims.length < 2) continue;
      const f = familyOfType(t.type);
      bytes.set(f, (bytes.get(f) ?? 0) + (t.dims.reduce((a, b) => a * b, 1) / size[1]) * size[0]);
    }
    return [...bytes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  } catch {
    return null;
  }
}

const num = (v: Value | undefined): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0);

/** The model's shape from its header values. Null when the numbers needed are missing. */
export function shapeOf(h: Map<string, Value>): ModelShape | null {
  const arch = String(h.get('general.architecture') ?? '');
  if (!arch) return null;
  const g = (k: string) => h.get(`${arch}.${k}`);
  const layers = num(g('block_count'));
  const heads = g('attention.head_count');
  const kvRaw = g('attention.head_count_kv') ?? heads;
  const headsN = Array.isArray(heads) ? Math.max(...heads.map(num)) : num(heads);
  const embed = num(g('embedding_length'));
  let attentionLayers = layers;
  let kvHeads: number;
  if (Array.isArray(kvRaw)) {
    // Per-layer list: a 0 marks a layer with no per-token cache (a recurrent / linear-attention layer).
    const per = kvRaw.map(num);
    attentionLayers = per.filter(n => n > 0).length;
    kvHeads = Math.max(0, ...per);
  } else {
    kvHeads = num(kvRaw);
    // Hybrid models that mark it with an interval: one full-attention layer in every N.
    const every = num(g('full_attention_interval'));
    if (every > 1) attentionLayers = Math.ceil(layers / every);
  }
  const keyLength = num(g('attention.key_length')) || (headsN ? Math.round(embed / headsN) : 0);
  const valueLength = num(g('attention.value_length')) || keyLength;
  if (!layers || !kvHeads || !keyLength) return null;
  // A sliding window counts only when we know which layers use it; otherwise every layer is counted in full (the safe side).
  const swaWindow = num(g('attention.sliding_window'));
  const swaEvery = swaWindow ? num(g('attention.sliding_window_pattern')) || SWA_EVERY[arch] || 0 : 0;
  const mtp = num(g('nextn_predict_layers'));
  const words = h.get('tokenizer.ggml.tokens');
  const kind = h.get('tokenizer.ggml.model');
  const vocab = typeof kind === 'string' && kind && typeof words === 'string' && /^\d+:[0-9a-f]+$/.test(words) ? `${String(h.get('tokenizer.ggml.model') ?? '')}|${words.split(':')[0]}|${num(h.get('tokenizer.ggml.bos_token_id'))}|${num(h.get('tokenizer.ggml.eos_token_id'))}|${words.split(':')[1]}` : '';
  return { arch, layers, attentionLayers, kvHeads, keyLength, valueLength, trainedContext: num(g('context_length')), experts: num(g('expert_count')), ...(num(g('expert_used_count')) > 0 ? { expertsUsed: num(g('expert_used_count')) } : {}), swaWindow: swaEvery ? swaWindow : 0, swaEvery, ...(mtp > 0 ? { mtp } : {}), ...(vocab ? { vocab } : {}) };
}

export const CACHE_BYTES: Record<string, number> = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 };

/** Bytes the context cache takes for `tokens` tokens (keys and values, every attention layer). */
export function cacheBytes(shape: ModelShape, tokens: number, cache = 'f16'): number {
  const perLayerToken = shape.kvHeads * (shape.keyLength + shape.valueLength) * (CACHE_BYTES[cache] ?? 2);
  if (!shape.swaEvery) return shape.attentionLayers * perLayerToken * tokens;
  const full = Math.floor(shape.attentionLayers / shape.swaEvery);
  return perLayerToken * (full * tokens + (shape.attentionLayers - full) * Math.min(tokens, shape.swaWindow));
}

const cache = new Map<string, Promise<ModelShape | null>>();

/** A model file's shape, read once per file (by path, size and time). Null when it cannot be read. */
export async function modelShape(path: string): Promise<ModelShape | null> {
  const s = await stat(path).catch(() => null);
  if (!s) return null;
  const key = `${path}|${s.size}|${s.mtimeMs}`;
  if (!cache.has(key)) {
    const archKeys = /^(general\.architecture|[\w.]+\.(block_count|attention\.head_count(_kv)?|attention\.(key|value)_length|embedding_length|context_length|expert_count|expert_used_count|full_attention_interval|attention\.sliding_window(_pattern)?|nextn_predict_layers)|tokenizer\.ggml\.(model|tokens|bos_token_id|eos_token_id))$/;
    cache.set(key, readHeader(path, k => archKeys.test(k)).then(shapeOf).catch(() => null));
  }
  return cache.get(key)!;
}
