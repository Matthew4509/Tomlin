// Mode presets, picked from the prompt (the person can choose another): Icon, Blog / photo, Cartoon, Custom. A preset
// adds words to the prompt, sets how many drafts are drawn and how the result is finished and saved.
import type { Size } from './sizes.ts';

export type Mode = 'icon' | 'blog' | 'cartoon' | 'custom';
export const MODES: Mode[] = ['icon', 'blog', 'cartoon', 'custom'];

export interface ModePreset {
  mode: Mode;
  name: string;
  /** Added to the prompt the model sees (the person's own words come first). */
  boost: string;
  negative: string;
  /** Pictures drawn at once; the person picks one to finalise. */
  drafts: number;
  /** Cut the background away (transparent PNG). */
  removeBackground: boolean;
  format: 'png' | 'webp';
}

export const PRESETS: Record<Mode, ModePreset> = {
  icon: {
    mode: 'icon',
    name: 'Icon',
    boost: 'flat vector icon, simple, centered, bold outlines, plain white background',
    negative: 'photo, realistic, photograph, text, letters, words, watermark, signature, busy background, shadow, frame, border, multiple objects',
    drafts: 1,
    removeBackground: true,
    format: 'png',
  },
  blog: {
    mode: 'blog',
    name: 'Blog / photo',
    boost: 'photorealistic, natural light, high detail',
    negative: 'cartoon, illustration, drawing, text, letters, watermark, signature, logo, deformed, blurry, lowres',
    drafts: 4,
    removeBackground: false,
    format: 'webp',
  },
  cartoon: {
    mode: 'cartoon',
    name: 'Cartoon',
    boost: 'cartoon illustration, flat colours, clean bold outlines, simple shapes, soft cel shading',
    negative: 'photo, photograph, photorealistic, realistic, 3d render, text, letters, watermark, signature, blurry, deformed, lowres',
    drafts: 1,
    removeBackground: false,
    format: 'png',
  },
  custom: {
    mode: 'custom',
    name: 'Custom',
    boost: '',
    negative: '',
    drafts: 1,
    removeBackground: false,
    format: 'png',
  },
};

/** The mode a prompt asks for: icon words mean Icon; cartoon words mean Cartoon; a small size means Icon; photo words
 * mean Blog; anything else Custom. */
export function detectMode(prompt: string, target: Size | null): { mode: Mode; why: string } {
  const icon = /\b(icons?|logos?|favicons?|app ?icons?|emoji|glyph|pictogram|symbol)\b/i.exec(prompt);
  if (icon) return { mode: 'icon', why: `"${icon[0]}" in the prompt` };
  const cartoon = /\b(cartoons?|cartoony|comic(?: book| strip)?|anime|manga|cel[- ]shaded|caricature|chibi)\b/i.exec(prompt);
  if (cartoon) return { mode: 'cartoon', why: `"${cartoon[0]}" in the prompt` };
  if (target && Math.max(target.width, target.height) <= 256) return { mode: 'icon', why: `small size (${target.width}×${target.height})` };
  const photo = /\b(photos?|photographs?|photography|blog( post)?|hero( image)?|header image|realistic|photoreal(istic)?|stock image)\b/i.exec(prompt);
  if (photo) return { mode: 'blog', why: `"${photo[0]}" in the prompt` };
  return { mode: 'custom', why: 'no icon or photo words' };
}

/** Words that only ask for a picture ("make an image of ...") or say where it will be used ("for a blog post", "for my
 * website") mean nothing to the model, so they are taken out of what it sees. */
const ASKING = /^\s*(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(?:(?:make|draw|create|generate|paint|render|show)(?:\s+me)?|i\s+(?:want|need))\s+(?:an?\s+|the\s+|some\s+)?(?:image|picture|pic|illustration|drawing|artwork)s?\s+(?:of|showing|with)\s+/i;

const BARE = /^\s*(?:an?\s+|the\s+)?(?:image|picture|illustration|drawing)\s+of\s+/i;

/** "profile picture of …", "an avatar of …", "a headshot of …": a square head-and-shoulders portrait. */
export const portraitAsk = (prompt: string): boolean => /\b(profile\s+(?:picture|photo|pic|image)s?|avatars?|head\s?shots?)\b/i.test(prompt);

/** The square a portrait is drawn at when no size was given. */
export const PORTRAIT_SIZE: Size = { width: 512, height: 512 };

/** "portrait" and "centred" made DreamShaper draw a dark ring round the head (a circle in the round photo): left out. */
const PORTRAIT_WORDS = 'head and shoulders, facing the viewer, plain background filling the whole picture';
/** The same, said to models that read negative words (a model run at CFG 1, like the LCM ones here, ignores them). */
export const PORTRAIT_NEGATIVE = 'circle frame, round frame, border, badge, vignette';

/** "make a cartoon profile picture of a baker" -> "a baker, cartoon style": the asking words out, the style
 * word kept (at the end, where it reads as a style and not as the subject). */
const PORTRAIT_ASK = /^\s*(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(?:(?:make|draw|create|generate|paint|render|show)(?:\s+me)?\s+|i\s+(?:want|need)\s+)?(?:an?\s+|the\s+|my\s+|some\s+)?(?:(cartoon|anime|comic|manga|chibi)\s+)?(?:profile\s+(?:picture|photo|pic|image)|avatar|head\s?shot)s?\s+(?:of|for|showing)\s+(.+)$/is;

export function forModel(prompt: string): string {
  const portrait = PORTRAIT_ASK.exec(prompt);
  if (portrait) prompt = portrait[1] ? `${portrait[2].replace(/[\s,.]+$/, '')}, ${portrait[1].toLowerCase()} style` : portrait[2];
  return prompt
    .replace(ASKING, '')
    .replace(BARE, '')
    .replace(/\b(?:for|on|in)\s+(?:a|an|the|my|our)?\s*(?:blog(?:\s+post)?|website|web\s*site|web\s*page|article|newsletter)\b/gi, ' ')
    .replace(/\bblog\s+post\b/gi, ' ')
    .replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').replace(/^[\s,]+|[\s,]+$/g, '');
}

/** The prompt the model sees: the person's words (place-of-use words out), the portrait words when a profile picture
 * was asked for, then the mode's words. */
export function boosted(prompt: string, preset: ModePreset): string {
  const words = forModel(prompt);
  const extra = [portraitAsk(prompt) ? PORTRAIT_WORDS : '', preset.boost].filter(Boolean).join(', ');
  return extra ? `${words.replace(/[\s,.]+$/, '')}, ${extra}` : words;
}

/** A file name from the prompt: up to six plain words, joined by hyphens ("reading-chair-sunlit-room"). */
export function slug(prompt: string): string {
  const stop = new Set(['a', 'an', 'the', 'of', 'for', 'in', 'on', 'at', 'to', 'and', 'with', 'icon', 'photo', 'image', 'picture', 'blog', 'post', 'px', 'by']);
  const words = prompt.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w && !stop.has(w) && !/^\d+$/.test(w));
  return words.slice(0, 6).join('-') || 'picture';
}
