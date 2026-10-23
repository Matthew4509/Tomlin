// Same model, smaller file, fits the card (PLAN-2026-10-21-QUANT-THAT-FITS.md): a chat model that spills over its
// card into RAM may write much faster from a smaller file of the same model that sits wholly on the card (measured 22
// Oct on a GTX 1060 6 GB: Qwen3.5 9B UD-IQ3_XXS 20.1 tok/s against Q4_K_M split 8.7, the same audition score). Only a
// file that fits whole is offered: a smaller file that still spills was measured slower (the CPU unpacks IQ files
// slowly). Plain sums, tested in test/quantfit.test.ts; the speed finder (src/server/finder.ts) offers the row and the
// download only happens on the owner's press, with its size shown.

const GB = 2 ** 30;
/** Working memory a model needs on the card besides its file and cache (the speed finder's WORKING). */
export const WORKING = 0.5 * GB;
/** Left free on the card on purpose (the finder never recommends less). */
export const LEFT_FREE = 0.5 * GB;
/** llama.cpp's Auto keeps this much of each card free when it splits a model. */
export const AUTO_HELD = 1 * GB;
/** Bits a weight below which a file is not offered: Quick, Full. Answers get clearly weaker near 3. */
export const FLOOR = { quick: 3.5, full: 3.0 };
/** An IQ file on the card wrote 13% under the bandwidth sums (unpacking its codebook costs the card a little). */
export const IQ_CARD = 0.87;
/** GB/s a word reads at from RAM and from the card when nothing better is known (the Worker PC, 21 Oct). */
export const RATES = { card: 93, ram: 22 };

const QUANT = /[-_.]((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|MXFP4(?:_MOE)?|BF16|F16|F32))(?:-\d{5}-of-\d{5})?(?:\.gguf)?$/i;

/** The file's packing ("Q4_K_M", "UD-IQ3_XXS"), or '' when the name does not say. */
export function quantOf(name: string): string {
  return QUANT.exec(name)?.[1] ?? '';
}

/** The model's name without its packing, parts and .gguf: the same for every file of one model. */
export function stemOf(name: string): string {
  const base = name.replace(/\.gguf$/i, '').replace(/-\d{5}-of-\d{5}$/i, '');
  const q = quantOf(base);
  return q ? base.slice(0, base.length - q.length - 1) : base;
}

/** An IQ file (IQ3_XXS, IQ4_XS, UD-IQ3_XXS...). */
export const isIq = (q: string) => /^(UD-)?IQ/i.test(q);
/** IQ1, IQ2 and Q2 files are never offered: answers fall apart at about 2 bits. */
export const tooSmall = (q: string) => /^(UD-)?I?Q[12](?:_|$)/i.test(q);

/** Bits a weight: the file's size over its weights. */
export const bitsAWeight = (bytes: number, params: number) => (params > 0 ? (bytes * 8) / params : 0);

/** Card memory a file needs to sit wholly on the card: the file, its context cache and working memory. */
export const cardNeed = (fileBytes: number, cacheBytes: number) => fileBytes + cacheBytes + WORKING;

/** Tokens a second a dense model writes with `card` bytes on the card and `ram` bytes in RAM, by the bandwidth sums. */
export function expectedWrite(card: number, ram: number, rates = RATES, iq = false): number {
  const t = card / GB / rates.card + ram / GB / rates.ram + 0.003;
  return (1 / t) * (iq && ram === 0 ? IQ_CARD : 1);
}

/** The card's real reading speed: half its rated speed (as llama.cpp gets), from its name; the Worker PC's when unknown. */
export function cardRate(name: string, cards: { name: string; speed: number }[]): number {
  const key = (s: string) => (/\b(\d{4})\b/.exec(s)?.[1] ?? /\b([a-z]\d{3,4})\b/i.exec(s)?.[1]?.toLowerCase() ?? '');
  const k = key(name);
  const c = k ? cards.find(x => key(x.name) === k) : undefined;
  return c ? Math.round(c.speed * 0.485) : RATES.card;
}

export interface FileOption { name: string; bytes: number }

export interface Pick {
  file: FileOption;
  quant: string;
  bits: number;
  bitsNow: number;
  /** Card memory left free with it loaded (bytes). */
  left: number;
  /** Tokens a second by the sums, and the same for the file in use. */
  expect: number;
  now: number;
}

/**
 * The smaller file to offer: of the same model's files, smaller than the one in use, at or over the floor's bits a
 * weight (never IQ1/IQ2/Q2), that fit wholly on the card with 0.5 GB left free, the biggest (the best answers that
 * still fit). `room`: the card's memory free with this model not loaded (bytes); `extra`: other card use to keep (a
 * guessing model on the card). `split`: the file in use, its bytes on the card and in RAM (measured, or worked out).
 * `measured`: its writing speed on that PC, which scales the sums (null: the sums alone). Null with `why` when nothing
 * qualifies, or when it is not expected to be more than 5% faster.
 */
export function pickSmaller(o: {
  files: FileOption[];
  current: FileOption;
  params: number;
  cacheBytes: number;
  room: number;
  extra?: number;
  split: { card: number; ram: number };
  rates: { card: number; ram: number };
  measured: number | null;
  size: 'quick' | 'full';
}): { pick: Pick | null; why: string } {
  const floor = FLOOR[o.size];
  const bitsNow = bitsAWeight(o.current.bytes, o.params);
  const nowSum = expectedWrite(o.split.card, o.split.ram, o.rates);
  const scale = o.measured && nowSum ? Math.min(2, Math.max(0.5, o.measured / nowSum)) : 1;
  const now = o.measured ?? nowSum;
  const stem = stemOf(o.current.name).toLowerCase();
  const room = o.room - (o.extra ?? 0) - LEFT_FREE;
  const smaller = o.files.filter(f => stemOf(f.name).toLowerCase() === stem && f.bytes < o.current.bytes * 0.98 && quantOf(f.name) && !tooSmall(quantOf(f.name)));
  const bitsOk = smaller.filter(f => bitsAWeight(f.bytes, o.params) >= floor);
  const fits = bitsOk.filter(f => cardNeed(f.bytes, o.cacheBytes) <= room).sort((a, b) => b.bytes - a.bytes);
  if (!fits.length) {
    if (!bitsOk.length) return { pick: null, why: smaller.length ? `every smaller file of this model is under ${floor} bits a weight (answers get clearly weaker)` : 'no smaller file of this model was found' };
    const best = [...bitsOk].sort((a, b) => a.bytes - b.bytes)[0];
    return { pick: null, why: `nothing smaller fits this card whole: the smallest, ${best.name} (${(best.bytes / GB).toFixed(1)} GB), needs ${((cardNeed(best.bytes, o.cacheBytes) + LEFT_FREE + (o.extra ?? 0)) / GB).toFixed(1)} GB of card memory and it has ${(o.room / GB).toFixed(1)} GB` };
  }
  const file = fits[0];
  const quant = quantOf(file.name);
  const expect = expectedWrite(file.bytes, 0, o.rates, isIq(quant)) * scale;
  if (expect <= now * 1.05) return { pick: null, why: `${file.name} fits the card but is not expected to be more than 5% faster` };
  return { pick: { file, quant, bits: bitsAWeight(file.bytes, o.params), bitsNow, left: o.room - (o.extra ?? 0) - cardNeed(file.bytes, o.cacheBytes), expect, now }, why: '' };
}

/** How much of a file llama.cpp's Auto puts on the card when it does not fit (1 GB held back, the cache and working memory first). */
export const autoSplit = (bytes: number, cacheBytes: number, room: number) => {
  const card = Math.max(0, Math.min(bytes, room - AUTO_HELD - cacheBytes - WORKING));
  return { card, ram: bytes - card };
};
