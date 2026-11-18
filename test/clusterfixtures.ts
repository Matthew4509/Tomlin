// The PCs and models the cluster engine tests use. Model sizes were read from the real files' headers on 14 Nov 2026
// (tensor bytes by kind); the speeds are worked out from the Z820's measured run (Qwen3-Next-80B Q3, 8.67 tok/s with
// the experts in RAM and the rest on its RTX 3060). The main PC's RAM speed is NOT measured: it is set equal to the
// Z820's here, as the plan says.
import type { Member, ModelFacts } from '../src/cluster/engine.ts';

export const GIB = 2 ** 30;

/** Qwen3-Next-80B-A3B-Instruct UD-Q3_K_XL: 48 layers, 512 experts (10 chosen), experts 31.73 GiB, attention and the rest 1.29 GiB read a word. */
export const NEXT80: ModelFacts = {
  name: 'Qwen3-Next-80B',
  bytes: 33.18 * GIB,
  layers: 48,
  kv: 1 * GIB,
  moe: { experts: 512, used: 10, expertLayer: 0.6611 * GIB, rest: 1.451 * GIB, restActive: 1.288 * GIB, hidden: 2048 },
};

/** Qwen3.8-Flash-Next UD-Q3_K_XL: 48 layers, 512 experts (10 chosen), experts 52.32 GiB, a 26.8 GiB lookup table, 3.85 GiB read a word outside the experts. */
export const FLASH38: ModelFacts = {
  name: 'Qwen3.8-Flash-Next',
  bytes: 83.31 * GIB,
  layers: 48,
  kv: 1.5 * GIB,
  moe: { experts: 512, used: 10, expertLayer: 1.09 * GIB, rest: 30.99 * GIB, restActive: 3.854 * GIB, hidden: 2560 },
};

export const DENSE12: ModelFacts = { name: 'Dense-12B', bytes: 7 * GIB, layers: 40, kv: 1 * GIB };

/** Effective speeds: the card's through weights, the processor's through weights in RAM, the fixed part of each word. */
const SPEEDS = { card: 250e9, ram: 6.7e9, fixedMs: 10 };

export const z820 = (): Member => ({ id: 'z820', name: 'Big PC', loader: true, ramFree: 58 * GIB, ramTotal: 64 * GIB, card: { free: 11.2 * GIB, total: 12 * GIB }, builds: ['b11284'], speeds: { ...SPEEDS } });
export const z240 = (): Member => ({ id: 'z240', name: 'Main PC', loader: false, ramFree: 40 * GIB, ramTotal: 48 * GIB, card: { free: 4.5 * GIB, total: 5 * GIB }, builds: ['b11284'], speeds: { card: 80e9, ram: 6.7e9, fixedMs: 10 } });
