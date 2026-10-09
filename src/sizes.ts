// Picture sizes: a size written in the prompt ("120px x 120px", "600x600", "1200 by 630") is taken out of the text the
// model sees and becomes the target; the model always draws at about 512 x 512 worth of pixels (the size these
// models were trained at), in the target's shape, and the result is resized to the target afterwards.

export interface Size {
  width: number;
  height: number;
}

const MIN = 16;
const MAX = 4096;

// "120px x 120px", "600x600", "600 × 400 px", "1200 by 630 pixels", "1920*1080"
const PAIR = /(?:\b(?:at|size|sized|of|in)\s+)?\b(\d{2,4})\s*(?:px|pixels?)?\s*(?:x|×|\*|by)\s*(\d{2,4})\s*(?:px|pixels?)?\b/i;
// "32px", "256 pixels" alone: a square
const SINGLE = /(?:\b(?:at|size|sized|of|in)\s+)?\b(\d{2,4})\s*(?:px|pixels?)\b(?!\s*(?:x|×|\*|by)\s*\d)/i;

/** The size written in `prompt`, if any, and the prompt without it (tidied: no doubled spaces or stray commas). */
export function parseSize(prompt: string): { size: Size | null; prompt: string } {
  let m = PAIR.exec(prompt);
  let size: Size | null = null;
  if (m) size = { width: Number(m[1]), height: Number(m[2]) };
  else {
    m = SINGLE.exec(prompt);
    if (m) size = { width: Number(m[1]), height: Number(m[1]) };
  }
  if (!m || !size || size.width < MIN || size.height < MIN || size.width > MAX || size.height > MAX) return { size: null, prompt: tidy(prompt) };
  return { size, prompt: tidy(prompt.slice(0, m.index) + ' ' + prompt.slice(m.index + m[0].length)) };
}

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/([,;:])\s*(?=[,;:.]|$)/g, '').replace(/^[\s,;:.-]+|[\s,;:-]+$/g, '').trim();
}

const round = (n: number, to: number) => Math.max(to, Math.round(n / to) * to);

/**
 * The size the model draws at: `native` x `native` worth of pixels (about 0.26 megapixels at 512), in the shape of
 * `target`, each side a multiple of 64 (what the models need), each side 256 to 1024.
 */
export function generationSize(target: Size | null, native = 512): Size {
  if (!target) return { width: native, height: native };
  const area = native * native;
  const aspect = target.width / target.height;
  const clamp = (n: number) => Math.min(native * 2, Math.max(native / 2, n));
  return { width: clamp(round(Math.sqrt(area * aspect), 64)), height: clamp(round(Math.sqrt(area / aspect), 64)) };
}

/** "600×600" */
export function sizeText(s: Size): string {
  return `${s.width}×${s.height}`;
}
