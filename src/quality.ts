// Draft / Mid / High (2.0.65), for any picture model: the size each model draws at for each, how many pictures a Draft
// gives to pick from, and the guidance that makes "leave out" words count on the fast models. A model's own sizes come
// from its registry entry (`quality`); a model without them gets sizes from its native one.
import type { RegistryModel } from './registry.ts';
import { generationSize, type Size } from './sizes.ts';

export type Quality = 'draft' | 'mid' | 'high';
export const QUALITIES: Quality[] = ['draft', 'mid', 'high'];
/** What a request asked for, or Mid. */
export const cleanQuality = (v: unknown): Quality => (QUALITIES.includes(v as Quality) ? (v as Quality) : 'mid');

/** The shape two or more people are drawn in when no size was asked for: wide (3:2), so both fit. */
export const GROUP_SIZE: Size = { width: 768, height: 512 };

type Model = Pick<RegistryModel, 'native' | 'quality' | 'defaults'>;
const to64 = (n: number) => Math.max(256, Math.round(n / 64) * 64);

/** The side (of a square worth of pixels) the model draws at for this quality. */
export function qualitySide(m: Model, q: Quality): number {
  const own = m.quality?.[q];
  if (typeof own === 'number' && own >= 256) return own;
  const native = m.native ?? 512;
  return q === 'draft' ? to64(native * 0.75) : q === 'high' ? to64(native * 1.25) : native;
}

/** The size drawn: that many pixels, in the shape asked for (each side a multiple of 64). */
export const qualitySize = (m: Model, q: Quality, target: Size | null): Size => generationSize(target, qualitySide(m, q));

/** A model that draws in a few steps at 512 (the LCM ones: 4) costs seconds a picture; a 1024 one (SDXL) does not. */
export const fastModel = (m: Model): boolean => (m.defaults?.steps ?? 20) <= 8 && (m.native ?? 512) <= 512;

/** Pictures drawn at once: a Draft gives several to pick from (four when they are cheap), Mid and High one. */
export const draftCount = (m: Model, q: Quality): number => (q !== 'draft' ? 1 : fastModel(m) ? 4 : 2);

/**
 * The guidance (CFG). The fast models run at 1, where "leave out" words are ignored altogether; for Mid and High they
 * get 1.5 when there is something to leave out (each step then costs about twice as long, still seconds). Drafts stay
 * quick; a model that reads them already keeps its own.
 */
export function cfgFor(m: Model, q: Quality, negative: string): number {
  const cfg = m.defaults?.cfg ?? 7;
  return cfg <= 1 && q !== 'draft' && negative.trim() ? 1.5 : cfg;
}
