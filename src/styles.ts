// Picture styles for the Style picker: each adds its own words to the prompt and leaves its own words out, suggests a
// shape and a quality, and rides on one of the modes in src/modes.ts (Flat icon keeps Icon's background cut away, Photo
// keeps Blog / photo's drafts and WebP). The four styles the Images window always had (Auto, Photo, Flat, Cartoon) keep
// their mode's words exactly, and their old values ('blog' for Photo) are still read.
// Each style has sample pictures, one per picture model: the same prompt, seed and quality for every style, drawn
// through the queue and kept in data/stylesamples/<model id>/<style id>.png (or .webp) with a record of how it was
// drawn, taken from the drawn picture itself (sampleRecord), never typed.
import { PRESETS, type Mode, type ModePreset } from './modes.ts';
import type { Quality } from './quality.ts';

export type Shape = 'auto' | '1:1' | '4:3' | '16:9' | '9:16';
export const SHAPES: Record<Exclude<Shape, 'auto'>, [number, number]> = { '1:1': [1, 1], '4:3': [4, 3], '16:9': [16, 9], '9:16': [9, 16] };

export interface PictureStyle {
  id: string;
  name: string;
  /** One short line for the tile's hover. */
  about: string;
  /** Added to the prompt the model sees, after the person's words. */
  boost: string;
  /** Left out of the picture, with the other "leave out" words. */
  negative: string;
  shape: Shape;
  quality: Quality;
  /** The mode it rides on: drafts, background removal and the file kind come from there. 'auto': picked from the prompt. */
  mode: Mode | 'auto';
}

/** The words a mode adds already: a style on that mode with the same words adds nothing more. */
const same = (mode: Mode) => ({ boost: PRESETS[mode].boost, negative: PRESETS[mode].negative });

export const STYLES: PictureStyle[] = [
  { id: 'auto', name: 'Auto', about: 'Picked from the prompt', boost: '', negative: '', shape: 'auto', quality: 'mid', mode: 'auto' },
  { id: 'photo', name: 'Photo', about: 'A photo, as for a blog', ...same('blog'), shape: '4:3', quality: 'mid', mode: 'blog' },
  {
    id: 'cinematic', name: 'Cinematic', about: 'A still from a film: wide, dramatic light',
    boost: 'cinematic film still, anamorphic lens, shallow depth of field, dramatic lighting, film grain, colour graded',
    negative: 'cartoon, illustration, anime, drawing, painting, text, letters, watermark, signature, deformed, blurry, lowres',
    shape: '16:9', quality: 'mid', mode: 'custom',
  },
  {
    id: 'anime', name: 'Anime', about: 'Japanese animation: clean lines, flat bright colour',
    boost: 'anime style, clean line art, cel shading, vibrant colours, detailed painted background',
    negative: 'photo, photograph, photorealistic, realistic, 3d render, text, letters, watermark, signature, deformed, blurry, lowres',
    shape: '1:1', quality: 'mid', mode: 'custom',
  },
  {
    id: 'ink', name: 'Chinese ink', about: 'Gongbi and guofeng: fine ink lines, soft colour on silk',
    boost: 'traditional Chinese painting, guofeng, gongbi, fine ink lines, ink wash, soft mineral colours on silk, elegant, empty space',
    negative: 'photo, photograph, photorealistic, 3d render, anime, western cartoon, text, letters, watermark, signature, lowres',
    shape: '9:16', quality: 'mid', mode: 'custom',
  },
  {
    id: 'cdrama', name: 'Chinese drama (realistic)', about: 'Realistic: Chinese people in an everyday Chinese home, as in a TV drama',
    boost: 'photorealistic film still, Chinese people, Chinese nationality, ordinary modern Chinese apartment interior, everyday clothes, natural window light and warm lamp light, soft shallow focus, smooth flawless skin, cinematic colour grade',
    negative: 'cartoon, anime, illustration, 3d render, CGI, doll, costume, hanfu, fantasy, armour, text, watermark, signature',
    shape: '16:9', quality: 'mid', mode: 'custom',
  },
  { id: 'cartoon', name: 'Cartoon', about: 'A cartoon or illustration', ...same('cartoon'), shape: '1:1', quality: 'mid', mode: 'cartoon' },
  {
    id: 'watercolour', name: 'Watercolour', about: 'Soft washes of paint on paper',
    boost: 'watercolour painting, soft washes, loose brushstrokes, gentle bleeding colours, visible paper texture',
    negative: 'photo, photograph, photorealistic, 3d render, digital art, hard edges, text, letters, watermark, signature, lowres',
    shape: '4:3', quality: 'mid', mode: 'custom',
  },
  {
    id: 'surreal', name: 'Surreal', about: 'A dream: odd scale, strange soft light',
    boost: 'surreal dreamlike scene, impossible scale, floating objects, soft otherworldly light, surrealist painting, highly detailed',
    negative: 'text, letters, watermark, signature, deformed, blurry, lowres',
    shape: '4:3', quality: 'mid', mode: 'custom',
  },
  {
    id: 'pixel', name: 'Pixel art', about: 'An old video game: big square pixels, few colours',
    boost: '16-bit pixel art, crisp square pixels, limited palette, retro video game style',
    negative: 'photo, photograph, photorealistic, 3d render, smooth gradients, blurry, text, letters, watermark, signature',
    shape: '1:1', quality: 'mid', mode: 'custom',
  },
  { id: 'icon', name: 'Flat icon', about: 'A flat icon or graphic, background cut away', ...same('icon'), shape: '1:1', quality: 'mid', mode: 'icon' },
];

/** The values the Style row and the Sheet style list always sent: still read, as the style they meant. */
const OLD_VALUES: Record<string, string> = { blog: 'photo' };

/** The style a value names (a style's id, or an old value such as 'blog'), or null. */
export function styleOf(v: unknown): PictureStyle | null {
  if (typeof v !== 'string') return null;
  const id = OLD_VALUES[v] ?? v;
  return STYLES.find(s => s.id === id) ?? null;
}

/** A style picked by hand (not Auto), or null. */
export const pickedStyle = (v: unknown): PictureStyle | null => {
  const s = styleOf(v);
  return s && s.mode !== 'auto' ? s : null;
};

/** The value the Images window's Style row sends for a style (the old values for the four it always had). */
export const formValue = (s: PictureStyle): string => (s.id === 'photo' ? 'blog' : s.id);

/** The mode preset a picture is drawn with for a style: its mode's, with the style's words. */
export function presetOf(s: PictureStyle): ModePreset {
  if (s.mode === 'auto') throw new Error('Auto has no preset of its own: the mode is picked from the prompt.');
  return { ...PRESETS[s.mode], boost: s.boost, negative: s.negative };
}

/**
 * The words a style adds beyond its mode's own, for a linked PC that knows only the modes (its words are sent with the
 * prompt and the "leave out" words, so any TOMLIN there draws it). None for a style that is its mode's own.
 */
export function extraWords(s: PictureStyle | null): { boost: string; negative: string } {
  if (!s || s.mode === 'auto') return { boost: '', negative: '' };
  const own = PRESETS[s.mode];
  return own.boost === s.boost && own.negative === s.negative ? { boost: '', negative: '' } : { boost: s.boost, negative: s.negative };
}

/** The prompt with words added at the end (the person's own words first). */
export const withWords = (prompt: string, words: string): string => (words ? `${prompt.replace(/[\s,.]+$/, '')}, ${words}` : prompt);
/** Two lists of "leave out" words as one. */
export const bothNegative = (a: string | undefined, b: string): string => [a?.trim(), b].filter(Boolean).join(', ');

/** A shape at a model's own size: the same number of pixels as its square side, each side a multiple of 8. */
export function shapeSize(shape: Shape, side: number): { width: number; height: number } | null {
  if (shape === 'auto') return null;
  const [a, b] = SHAPES[shape];
  const k = side / Math.sqrt(a * b);
  return { width: Math.round((a * k) / 8) * 8, height: Math.round((b * k) / 8) * 8 };
}

// ---- Samples ----

/** The one prompt every sample is drawn from, the one seed, and the quality: only the style changes. */
export const SAMPLE_PROMPT = 'a red fox sitting in a snowy pine forest at dusk';
export const SAMPLE_SEED = 4242;
export const SAMPLE_QUALITY: Quality = 'mid';

/** The styles that have samples: every one but Auto (it has no words of its own). */
export const sampleStyles = (): PictureStyle[] => STYLES.filter(s => s.mode !== 'auto');

/** A model's id as a folder name: TOMLIN's own ids are letters, digits, dots, dashes and underscores. */
export const isModelKey = (v: unknown): v is string => typeof v === 'string' && /^[\w][\w.-]{0,79}$/.test(v) && !v.includes('..');

/** The queue items that draw every style's sample for one artist (src/server/queue.ts adds them). `side`: the model's own size. */
export function sampleItems(as: string, side: number): Record<string, unknown>[] {
  return sampleStyles().map(s => {
    const size = shapeSize(s.shape, side);
    return { kind: 'picture', prompt: SAMPLE_PROMPT, as, mode: s.mode, style: s.id, quality: SAMPLE_QUALITY, seed: SAMPLE_SEED, ...(size ?? {}), sample: true };
  });
}

/** How a sample was drawn, as the picture itself says. */
export interface SampleRecord {
  style: string;
  /** The model's id in TOMLIN's list, and its name. */
  model: string;
  modelName: string;
  /** The PC it was drawn on. */
  pc: string;
  seconds: number;
  steps: number;
  width: number;
  height: number;
  seed: number;
  prompt: string;
  /** When it was drawn. */
  at: string;
  /** The file beside the record: <style id>.png or .webp. */
  file: string;
}

/** The parts of a drawn picture (src/gallery.ts Picture) a sample's record is made from. */
export interface DrawnFacts {
  prompt: string;
  seed: number;
  steps: number;
  seconds: number;
  target: { width: number; height: number };
  at: string;
  format: 'png' | 'webp';
  settingsUnknown?: boolean;
}

/**
 * A sample's record, from the drawn picture and what the drawing said (`drawn`: the model id and name it was drawn
 * with, and the PC). Refused in words when the picture does not say enough to be an honest sample: no model id (an
 * older TOMLIN on a linked PC), settings not known, another prompt.
 */
export function sampleRecord(styleId: string, pic: DrawnFacts, drawn: { model?: string | null; modelName?: string | null; pc?: string | null }): SampleRecord | { error: string } {
  const s = pickedStyle(styleId);
  if (!s) return { error: 'That is not a style with samples.' };
  if (!isModelKey(drawn.model)) return { error: 'the PC that drew it did not say which picture model it used (it may run an older TOMLIN), so it is not kept as a sample.' };
  if (pic.settingsUnknown) return { error: 'the PC that drew it did not send its steps and seed back (it may run an older TOMLIN), so it is not kept as a sample.' };
  if (pic.prompt !== SAMPLE_PROMPT) return { error: 'it was not drawn from the sample prompt, so it is not kept as a sample.' };
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const [seconds, steps, width, height, seed] = [n(pic.seconds), n(pic.steps), n(pic.target?.width), n(pic.target?.height), n(pic.seed)];
  if (seconds === null || steps === null || !width || !height || seed === null) return { error: 'the picture does not say how it was drawn, so it is not kept as a sample.' };
  return {
    style: s.id, model: drawn.model, modelName: String(drawn.modelName ?? '').replace(/\s*\(.*\)$/, '').trim() || drawn.model, pc: String(drawn.pc ?? '').trim() || 'a PC',
    seconds: Math.round(seconds * 10) / 10, steps: Math.round(steps), width: Math.round(width), height: Math.round(height), seed: Math.round(seed), prompt: pic.prompt, at: pic.at,
    file: `${s.id}.${pic.format === 'webp' ? 'webp' : 'png'}`,
  };
}

/** A record as read back from disk: anything that does not fit is dropped (null). */
export function cleanRecord(raw: unknown): SampleRecord | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!r || !pickedStyle(r.style) || !isModelKey(r.model)) return null;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const file = str(r.file, 40);
  if (file !== `${r.style}.png` && file !== `${r.style}.webp`) return null;
  const [seconds, steps, width, height, seed] = [num(r.seconds), num(r.steps), num(r.width), num(r.height), num(r.seed)];
  if (seconds === null || steps === null || !width || !height || seed === null || !str(r.at, 40)) return null;
  return { style: r.style as string, model: r.model as string, modelName: str(r.modelName, 120) || (r.model as string), pc: str(r.pc, 80) || 'a PC', seconds, steps, width, height, seed, prompt: str(r.prompt, 300), at: str(r.at, 40), file };
}

/** The line under a sample: "Drawn by DreamShaper 8 on Worker PC in 12 s, 512×512, 20 steps, 27 Nov 2026". */
export function honestLine(r: SampleRecord): string {
  const d = new Date(r.at);
  const day = Number.isNaN(d.getTime()) ? 'date not known' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return `Drawn by ${r.modelName} on ${r.pc} in ${Math.max(1, Math.round(r.seconds))} s, ${r.width}×${r.height}, ${r.steps} steps, ${day}`;
}
