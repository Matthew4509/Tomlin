// Reference pictures sent with a picture asked of a linked PC (/worker/draw): a character's or a location's ticked
// pictures (src/cards.ts) live only on the PC that has the project, so they go with the request as PNG data, and the
// linked PC hands them to its picture runner as it would its own (src/images.ts refPictures).
import { crc32, inflateSync } from 'node:zlib';

/** What a linked PC that takes reference pictures with /worker/draw says in its hello's `can` (2.1.33 on). */
export const DRAW_REFS_CAN = 'draw-refs';
/** At most this many go with one picture (the most any picture model's card takes: src/cards.ts REFS_MOST). */
export const REFS_SENT_MOST = 4;
/** One reference picture's largest PNG (they are made at most 1024 on the longest side, so far under this). */
export const REF_BYTES_MOST = 4 * 2 ** 20;
/**
 * The largest sealed /worker/draw request: the words and choices, and every reference picture as base64, sealed (which
 * is base64 again). src/jobrun/node.ts reads the draw door's body up to this; every other door keeps its small limit.
 */
export const DRAW_BODY = Math.ceil(REFS_SENT_MOST * REF_BYTES_MOST * (4 / 3) * (4 / 3)) + (64 << 10);

/**
 * The largest seed a picture may be asked with: the runner reads a seed as a whole number this size or under, so the
 * Images window, the queue and a linked PC all take the same seeds and draw with the one asked.
 */
export const SEED_MOST = 2 ** 32 - 1;
/** Whether this is a seed a picture can be drawn with: a whole number from 0 to SEED_MOST. */
export const isSeed = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= SEED_MOST;
/** Why a seed asked cannot be drawn with (null when it can, or none was asked). */
export const seedWhy = (v: unknown): string | null => (v === undefined || v === null || isSeed(v) ? null : `The seed must be a whole number from 0 to ${SEED_MOST}.`);

const PNG_HEAD =Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A sent reference's longest side: senders make them at most 1024, so twice that is room enough. */
export const REF_SIDE_MOST = 2048;
/** Samples per pixel for each PNG colour type (grey, RGB, palette, grey with alpha, RGBA). */
const SAMPLES: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** The bit depths each colour type may have. */
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
/** The seven passes of an interlaced PNG: first column and row, then the step between them. */
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/**
 * Whether these bytes are a whole PNG of at most REF_SIDE_MOST on each side: every chunk whole with a right checksum,
 * a sound header first, picture data, an end, and picture data that unpacks to exactly the size the header claims.
 * A header that claims a huge picture, or a few PNG bytes and then rubbish, is not one.
 */
export function isSoundPng(png: Buffer): boolean {
  if (png.length < PNG_HEAD.length + 25 || !png.subarray(0, PNG_HEAD.length).equals(PNG_HEAD)) return false;
  let at = PNG_HEAD.length;
  let w = 0, h = 0, depth = 0, colour = 0, interlace = 0;
  let sawEnd = false, sawPalette = false;
  const data: Buffer[] = [];
  while (at < png.length) {
    if (at + 12 > png.length) return false;
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (len > png.length - at - 12) return false;
    const body = png.subarray(at + 8, at + 8 + len);
    if ((crc32(png.subarray(at + 4, at + 8 + len)) >>> 0) !== png.readUInt32BE(at + 8 + len)) return false;
    if (at === PNG_HEAD.length) {
      if (type !== 'IHDR' || len !== 13) return false;
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      depth = body[8];
      colour = body[9];
      interlace = body[12];
      if (!w || !h || w > REF_SIDE_MOST || h > REF_SIDE_MOST || !DEPTHS[colour]?.includes(depth) || body[10] !== 0 || body[11] !== 0 || interlace > 1) return false;
    } else if (type === 'IHDR') return false;
    if (type === 'PLTE') sawPalette = true;
    if (type === 'IDAT') data.push(body);
    at += 12 + len;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd || !data.length || (colour === 3 && !sawPalette)) return false;
  // The size the picture data must unpack to: each row's bytes and a filter byte, for each pass when interlaced.
  const bits = SAMPLES[colour] * depth;
  const rows = (pw: number, ph: number) => (pw && ph ? ph * (1 + Math.ceil((pw * bits) / 8)) : 0);
  const want = interlace
    ? ADAM7.reduce((n, [x, y, dx, dy]) => n + rows(Math.ceil((w - x) / dx), Math.ceil((h - y) / dy)), 0)
    : rows(w, h);
  try {
    const raw = inflateSync(Buffer.concat(data), { maxOutputLength: want + 1 });
    if (raw.length !== want) return false;
    // Each row starts with a filter type of 0 to 4.
    if (!interlace) for (let r = 0, step = want / h; r < h; r++) if (raw[r * step] > 4) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * The reference pictures a request carried, checked: whole base64 PNGs (isSoundPng) of REF_BYTES_MOST or less, at
 * most REFS_SENT_MOST. Anything else is left out (the picture is still drawn from the words), so a bad one never
 * reaches the runner. src/images.ts then reads each one again and makes it afresh before the runner sees it.
 */
export function cleanRefImages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw.slice(0, REFS_SENT_MOST)) {
    if (typeof x !== 'string' || x.length > Math.ceil(REF_BYTES_MOST / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(x)) continue;
    const png = Buffer.from(x, 'base64');
    if (png.length > REF_BYTES_MOST || !isSoundPng(png)) continue;
    out.push(x);
  }
  return out;
}
