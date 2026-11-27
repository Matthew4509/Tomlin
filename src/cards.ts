// Character sets: a project's characters and locations, each a card kept in the project's folder
// (specialists\characters\<name>\card.json and specialists\locations\<name>\card.json, its pictures beside it). A card is
// a name, fixed words that describe it, words to leave out, and its pictures, some ticked as the ones a reference-picture
// model is given. "@Ember in @Pine forest, leaping a log" in a picture's or a shot's prompt adds each named card's
// words, so the fox and the forest are described the same way every time (docs/REVIEW-2026-11-26-PICTURES-VIDEOS-
// CHARACTER-SETS.md). Plain functions, tested in test/cards.test.ts; the files are read and written in src/server/cards.ts.

export type CardKind = 'character' | 'location';
export const CARD_KINDS: CardKind[] = ['character', 'location'];
/** Each kind's folder under the project's specialists folder. */
export const KIND_FOLDER: Record<CardKind, string> = { character: 'characters', location: 'locations' };
export const CARD_FILE = 'card.json';
export const NAME_MOST = 40;
export const WORDS_MOST = 600;
export const AVOID_MOST = 300;
/** Pictures ticked to be given to a reference-picture model: the sheet's best views, not every picture kept. */
export const REFS_MOST = 4;
/** Pictures a card's folder may hold. */
export const PICTURES_MOST = 40;
/** The most a person may type for a picture (the Images window, the queue, a linked PC's artist). */
export const PROMPT_TYPED_MOST = 2000;
/**
 * The most a picture's whole prompt may be once its @names have added their words: what was typed, and room for four
 * cards' names and words. So a prompt typed under PROMPT_TYPED_MOST is never refused (or cut) for its cards' words.
 */
export const PROMPT_MOST = PROMPT_TYPED_MOST + 4 * (NAME_MOST + WORDS_MOST + 4);

export interface Card {
  kind: CardKind;
  name: string;
  /** The fixed words that describe it, added to every prompt that names it. */
  words: string;
  /** Words to leave out of a picture of it, added to the negative prompt. */
  avoid: string;
  /** The file names (in its folder) ticked as references. */
  refs: string[];
  at: string;
}

const PICTURE = /\.(png|webp|jpe?g)$/i;

/** A name a card can have, or null: letters, digits, spaces, - and ', at most NAME_MOST characters. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const n = v.replace(/\s+/g, ' ').trim();
  if (!n || n.length > NAME_MOST || !/^[\p{L}\p{N}][\p{L}\p{N} '\-]*$/u.test(n)) return null;
  return n;
}

/** A card as read from its file (or sent by the page), or null when it is not one. Pictures it ticks must be picture files. */
export function cleanCard(raw: unknown): Card | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = CARD_KINDS.includes(r.kind as CardKind) ? (r.kind as CardKind) : null;
  const name = cleanName(r.name);
  if (!kind || !name) return null;
  const text = (v: unknown, most: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, most) : '');
  const refs = Array.isArray(r.refs) ? [...new Set(r.refs.filter((x): x is string => typeof x === 'string' && PICTURE.test(x) && !/[\\/]/.test(x) && !x.startsWith('.')))].slice(0, REFS_MOST) : [];
  return { kind, name, words: text(r.words, WORDS_MOST), avoid: text(r.avoid, AVOID_MOST), refs, at: typeof r.at === 'string' ? r.at : '' };
}

/** Is this file one of a card's pictures? */
export const isCardPicture = (file: string): boolean => PICTURE.test(file) && !file.startsWith('.');

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Expanded {
  prompt: string;
  /** Words to add to the negative prompt (the named cards' avoid words). */
  avoid: string;
  /** The cards named, characters first. */
  used: Card[];
}

/**
 * A prompt with its @names filled in: each "@Name" of a card becomes the name, and the named cards' words follow the
 * prompt ("Ember: a young red fox, …"), so the words are never retyped. Longer names are matched first ("@Pine forest
 * at night" before "@Pine forest"); a name is matched whole, in any case. A prompt naming no card comes back as it was.
 */
export function expandPrompt(prompt: string, cards: Card[]): Expanded {
  let out = prompt;
  const used: Card[] = [];
  for (const c of [...cards].sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp(`@${escape(c.name)}(?![\\p{L}\\p{N}])`, 'giu');
    if (!re.test(out)) continue;
    out = out.replace(re, c.name);
    used.push(c);
  }
  used.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'character' ? -1 : 1));
  const said = used.filter(c => c.words).map(c => `${c.name}: ${c.words.replace(/[.\s]+$/, '')}.`);
  return {
    prompt: said.length ? `${out.trim().replace(/[.\s]+$/, '')}. ${said.join(' ')}` : out,
    avoid: [...new Set(used.map(c => c.avoid).filter(Boolean))].join(', '),
    used,
  };
}

/** "Front view, …" and the rest: the views Make a sheet draws for a character, and the plates for a location. */
export const SHEET_VIEWS: Record<CardKind, string[]> = {
  character: ['full body, front view', 'full body, three-quarter view', 'full body, side view', 'full body, back view', 'head and shoulders close-up, front view'],
  location: ['wide shot', 'middle shot', 'close detail shot'],
};

/** One prompt per view for Make a sheet: the card's words, the view, and a plain background for a character. */
export function sheetPrompts(c: Card): string[] {
  const base = `${c.name}${c.words ? `, ${c.words.replace(/[.\s]+$/, '')}` : ''}`;
  return SHEET_VIEWS[c.kind].map(v => (c.kind === 'character' ? `Character sheet of ${base}, ${v}, plain light grey background, even studio light, no other people` : `${base}, ${v}, no people`));
}
