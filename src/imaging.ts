// Finishing a picture: resize to the target (Lanczos), fit a different shape (crop, pad or stretch), trim and centre
// an icon, save as WebP near a size budget, and an .ico with several sizes inside.
import sharp from 'sharp';
import type { Size } from './sizes.ts';

export type Fit = 'crop' | 'pad' | 'stretch';

/** Resizes `png` to `target`. Crop keeps the middle; pad adds a border (see-through when the picture has an alpha
 * channel, else white); stretch changes the shape. */
export async function fitTo(png: Buffer, target: Size, fit: Fit): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const alpha = !!meta.hasAlpha;
  const fitMode = fit === 'crop' ? 'cover' : fit === 'pad' ? 'contain' : 'fill';
  return sharp(png)
    .resize({ width: target.width, height: target.height, fit: fitMode, kernel: 'lanczos3', position: 'centre', background: alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 255, g: 255, b: 255, alpha: 1 } })
    .png()
    .toBuffer();
}

/** Puts `mask` (one byte per pixel, 0 = background) into `png` as its alpha channel. */
export async function withAlpha(png: Buffer, mask: Buffer, size: Size): Promise<Buffer> {
  const rgb = await sharp(png).removeAlpha().resize(size.width, size.height).raw().toBuffer();
  const out = Buffer.alloc(size.width * size.height * 4);
  for (let i = 0; i < size.width * size.height; i++) {
    out[i * 4] = rgb[i * 3];
    out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2];
    out[i * 4 + 3] = mask[i];
  }
  return sharp(out, { raw: { width: size.width, height: size.height, channels: 4 } }).png().toBuffer();
}

/**
 * An icon cut out of its background: trimmed to what is left, then centred on a square see-through canvas with a
 * small margin, so it sits in the middle whatever the model drew.
 */
export async function centreIcon(png: Buffer, margin = 0.06): Promise<Buffer> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return png;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const side = Math.round(Math.max(w, h) / (1 - 2 * margin));
  const cut = await sharp(png).ensureAlpha().extract({ left: minX, top: minY, width: w, height: h }).png().toBuffer();
  return sharp({ create: { width: side, height: side, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: cut, left: Math.floor((side - w) / 2), top: Math.floor((side - h) / 2) }])
    .png()
    .toBuffer();
}

/** True when some pixels are see-through (the model drew its own transparent background). */
export async function hasTransparency(png: Buffer): Promise<boolean> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let clear = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) clear++;
  return clear > info.width * info.height * 0.02;
}

/** WebP aimed at 60-120 KB: quality lowered until it fits (never below 45), or raised (up to 95) when a soft
 * picture comes out under 60 KB, so the budget goes on detail. */
export async function webp(png: Buffer, maxBytes = 120 * 1024, minBytes = 60 * 1024): Promise<{ data: Buffer; quality: number }> {
  const at = async (quality: number) => ({ data: await sharp(png).webp({ quality, effort: 5 }).toBuffer(), quality });
  let best = await at(82);
  if (best.data.length > maxBytes) {
    for (const q of [75, 68, 61, 54, 45]) {
      best = await at(q);
      if (best.data.length <= maxBytes) break;
    }
    return best;
  }
  for (const q of [88, 92, 95]) {
    if (best.data.length >= minBytes) break;
    const next = await at(q);
    if (next.data.length > maxBytes) break;
    best = next;
  }
  return best;
}

export const ICO_SIZES = [16, 32, 64, 128, 256];

/** PNG copies at `ICO_SIZES` and one .ico file holding them all (PNG inside, as Windows Vista and later read). */
export async function iconSet(png: Buffer): Promise<{ pngs: Array<{ size: number; data: Buffer }>; ico: Buffer }> {
  const pngs = await Promise.all(ICO_SIZES.map(async size => ({ size, data: await sharp(png).resize(size, size, { fit: 'contain', kernel: 'lanczos3', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer() })));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach((p, i) => {
    const o = i * 16;
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, o);
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(p.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += p.data.length;
  });
  return { pngs, ico: Buffer.concat([header, dir, ...pngs.map(p => p.data)]) };
}

export async function sizeOf(data: Buffer): Promise<Size> {
  const m = await sharp(data).metadata();
  return { width: m.width ?? 0, height: m.height ?? 0 };
}
