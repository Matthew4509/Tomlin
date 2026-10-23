// Same model, smaller file, fits the card: the sums checked against the 21-22 Oct figures from the Worker PC (GTX 1060
// 6 GB, 5.4 GB free before a model loads), PLAN-2026-10-21-QUANT-THAT-FITS.md sections 1c and 7b.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoSplit, bitsAWeight, cardNeed, cardRate, expectedWrite, isIq, pickSmaller, quantOf, stemOf, tooSmall } from '../src/quantfit.ts';
import { CARDS } from '../src/calc.ts';

const GB = 2 ** 30;
const f = (name: string, gb: number) => ({ name, bytes: Math.round(gb * GB) });
// Hugging Face's own sizes, read 21 Oct (unsloth/Qwen3.5-9B-GGUF, bartowski/google_gemma-3-12b-it-GGUF).
const NINE = [f('Qwen3.5-9B-Q8_0', 8.87), f('Qwen3.5-9B-Q4_K_M', 5.29), f('Qwen3.5-9B-IQ4_XS', 4.81), f('Qwen3.5-9B-Q3_K_M', 4.35), f('Qwen3.5-9B-Q3_K_S', 4.02), f('Qwen3.5-9B-UD-IQ3_XXS', 3.74), f('Qwen3.5-9B-UD-IQ2_XXS', 2.9), f('Qwen3.5-9B-Q2_K', 3.4)];
const GEMMA = [f('google_gemma-3-12b-it-Q4_K_M', 6.80), f('google_gemma-3-12b-it-IQ4_XS', 6.10), f('google_gemma-3-12b-it-Q3_K_M', 5.60), f('google_gemma-3-12b-it-IQ3_M', 5.27), f('google_gemma-3-12b-it-IQ3_XXS', 4.46), f('google_gemma-3-12b-it-IQ2_M', 4.01)];
const ROOM = 5.4 * GB;
const RATES = { card: 93, ram: 22 };

test('a file\'s packing and its model\'s name without it', () => {
  assert.equal(quantOf('Qwen3.5-9B-Q4_K_M'), 'Q4_K_M');
  assert.equal(quantOf('Qwen3.5-9B-UD-IQ3_XXS.gguf'), 'UD-IQ3_XXS');
  assert.equal(quantOf('Qwen3.5-35B-A3B-UD-Q4_K_XL'), 'UD-Q4_K_XL');
  assert.equal(quantOf('gpt-oss-20b-MXFP4'), 'MXFP4');
  assert.equal(stemOf('Qwen3.5-9B-UD-IQ3_XXS'), 'Qwen3.5-9B');
  assert.equal(stemOf('Qwen3.5-35B-A3B-Q4_K_M-00001-of-00002.gguf'), 'Qwen3.5-35B-A3B');
  assert.equal(stemOf('google_gemma-3-12b-it-Q4_K_M'), 'google_gemma-3-12b-it');
  assert.equal(stemOf('my-own-model'), 'my-own-model', 'no packing in the name: the name itself');
  assert.equal(isIq('UD-IQ3_XXS'), true);
  assert.equal(isIq('Q3_K_S'), false);
  assert.equal(tooSmall('UD-IQ2_XXS'), true);
  assert.equal(tooSmall('Q2_K'), true);
  assert.equal(tooSmall('IQ3_XXS'), false);
});

test('bits a weight, the card room a file needs, and the bandwidth sums match the measured Worker PC', () => {
  assert.equal(Math.round(bitsAWeight(5.29 * GB, 8.95e9) * 10) / 10, 5.1);
  assert.equal(cardNeed(3.74 * GB, 0.55 * GB), 4.79 * GB);
  // The 9B Q4_K_M at 16k, split by llama.cpp's Auto: about 7.9 by the sums (8.7 measured at 8k).
  const split = autoSplit(5.29 * GB, 0.55 * GB, ROOM);
  assert.equal(Math.round(expectedWrite(split.card, split.ram, RATES) * 10) / 10, 7.9);
  // UD-IQ3_XXS wholly on the card: 23.1 by bandwidth, 20.1 once IQ's unpacking is counted (20.1 measured).
  assert.equal(Math.round(expectedWrite(3.74 * GB, 0, RATES) * 10) / 10, 23.1);
  assert.equal(Math.round(expectedWrite(3.74 * GB, 0, RATES, true) * 10) / 10, 20.1);
  assert.equal(cardRate('NVIDIA GeForce GTX 1060 6GB', CARDS), 93);
  assert.equal(cardRate('NVIDIA Quadro P2000', CARDS), 68);
  assert.equal(cardRate('Some other card', CARDS), 93);
});

const nine = (ctxGb: number, size: 'quick' | 'full' = 'quick', extra = 0, measured: number | null = null) => pickSmaller({
  files: NINE, current: NINE[1], params: 8.95e9, cacheBytes: ctxGb * GB, room: ROOM, extra,
  split: autoSplit(NINE[1].bytes, ctxGb * GB, ROOM), rates: RATES, measured, size,
});

test('the 9B: at 16k the UD-IQ3_XXS fits whole; at 8k the bigger Q3_K_S does (the biggest that fits)', () => {
  const at16 = nine(0.55);
  assert.equal(at16.pick?.file.name, 'Qwen3.5-9B-UD-IQ3_XXS');
  assert.equal(Math.round(at16.pick!.bits * 10) / 10, 3.6);
  assert.equal(Math.round(at16.pick!.expect * 10) / 10, 20.1);
  assert.ok(at16.pick!.left >= 0.5 * GB);
  const at8 = nine(0.30);
  assert.equal(at8.pick?.file.name, 'Qwen3.5-9B-Q3_K_S');
  assert.ok(at8.pick!.expect > 20, 'a K file on the card is not cut for unpacking');
});

test('measured speed scales the sums: the 9B measured 8.7 against 8.4 by the sums', () => {
  const r = nine(0.30, 'quick', 0, 8.7);
  assert.equal(r.pick?.now, 8.7);
  assert.ok(r.pick!.expect > 21.6, 'scaled up with the PC\'s own figure');
});

test('never a bigger file, never IQ2 or Q2, and the guessing model on the card leaves no room for the 9B', () => {
  const full = nine(0.30, 'full');
  assert.notEqual(full.pick?.file.name, 'Qwen3.5-9B-Q8_0');
  assert.ok(!/Q2|IQ2/.test(full.pick!.file.name));
  // Qwen3.5 0.8B on the card: 0.9 GB with its cache and working memory.
  const withGuesser = nine(0.30, 'quick', 0.9 * GB);
  assert.equal(withGuesser.pick, null);
  assert.match(withGuesser.why, /nothing smaller fits this card whole/);
});

test('Gemma 3 12B: nothing worth using fits whole (only IQ2 would), said with the figures', () => {
  const r = pickSmaller({ files: GEMMA, current: GEMMA[0], params: 11.77e9, cacheBytes: 0.81 * GB, room: ROOM, split: autoSplit(GEMMA[0].bytes, 0.81 * GB, ROOM), rates: RATES, measured: 4.8, size: 'full' });
  assert.equal(r.pick, null);
  assert.match(r.why, /nothing smaller fits this card whole: the smallest, google_gemma-3-12b-it-IQ3_XXS/);
  const quick = pickSmaller({ files: GEMMA, current: GEMMA[0], params: 11.77e9, cacheBytes: 0.81 * GB, room: ROOM, split: autoSplit(GEMMA[0].bytes, 0.81 * GB, ROOM), rates: RATES, measured: 4.8, size: 'quick' });
  assert.equal(quick.pick, null);
});

test('a smaller file only when it is more than 5% faster, and only files of the same model', () => {
  const other = pickSmaller({ files: [f('Llama-3-8B-Q3_K_S', 3.5)], current: NINE[1], params: 8.95e9, cacheBytes: 0.3 * GB, room: ROOM, split: autoSplit(NINE[1].bytes, 0.3 * GB, ROOM), rates: RATES, measured: null, size: 'quick' });
  assert.equal(other.pick, null);
  assert.match(other.why, /no smaller file of this model/);
  // A card with room for all of it already: the smaller file gains little.
  const big = pickSmaller({ files: NINE, current: NINE[1], params: 8.95e9, cacheBytes: 0.3 * GB, room: 12 * GB, split: { card: NINE[1].bytes, ram: 0 }, rates: RATES, measured: null, size: 'quick' });
  assert.ok(big.pick === null || big.pick.expect > big.pick.now * 1.05);
});
