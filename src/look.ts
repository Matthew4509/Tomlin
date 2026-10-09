// A hire's look: the little person drawn for them (Staff > Edit Staff > Look, and Hire staff > Change look). Gender, skin, hair, hair
// colour, top, glasses, facial hair and headwear, each one id from the lists below. The page draws it (public/look.js):
// their round picture wherever a photo would go (a photo, when set, still wins), and the same person in the office game.
// The lists live here only: the page gets them from /api/faces, so a saved id and its colour never drift apart.
// Plain functions, tested in test/look.test.ts.

export interface Look {
  gender: string;
  skin: string;
  hair: string;
  hairColour: string;
  top: string;
  glasses: string;
  facial: string;
  headwear: string;
}

export interface LookOption {
  id: string;
  name: string;
  /** The colour drawn, for colour lists (skin, hair colour, top). */
  colour?: string;
}

export const LOOK_OPTIONS: Record<keyof Look, LookOption[]> = {
  gender: [
    { id: 'woman', name: 'Woman' },
    { id: 'man', name: 'Man' },
    { id: 'nonbinary', name: 'Non-binary' },
  ],
  skin: [
    { id: 'very-light', name: 'Very light', colour: '#fbe0cc' },
    { id: 'light', name: 'Light', colour: '#f4c596' },
    { id: 'medium', name: 'Medium', colour: '#dfa577' },
    { id: 'tan', name: 'Tan', colour: '#c18456' },
    { id: 'brown', name: 'Brown', colour: '#94603c' },
    { id: 'dark', name: 'Dark brown', colour: '#62402a' },
  ],
  hair: [
    { id: 'short', name: 'Short' },
    { id: 'buzz', name: 'Buzz cut' },
    { id: 'side-part', name: 'Side part' },
    { id: 'curly', name: 'Curly' },
    { id: 'afro', name: 'Afro' },
    { id: 'bob', name: 'Bob' },
    { id: 'long', name: 'Long' },
    { id: 'ponytail', name: 'Ponytail' },
    { id: 'bun', name: 'Bun' },
    { id: 'bald', name: 'Bald' },
  ],
  hairColour: [
    { id: 'black', name: 'Black', colour: '#27272f' },
    { id: 'dark-brown', name: 'Dark brown', colour: '#4a3226' },
    { id: 'brown', name: 'Brown', colour: '#7a5236' },
    { id: 'auburn', name: 'Auburn', colour: '#93402c' },
    { id: 'ginger', name: 'Ginger', colour: '#d0703a' },
    { id: 'blonde', name: 'Blonde', colour: '#e3c26e' },
    { id: 'grey', name: 'Grey', colour: '#a3a6ad' },
    { id: 'white', name: 'White', colour: '#ecebe6' },
    { id: 'blue', name: 'Blue', colour: '#4f84d6' },
    { id: 'pink', name: 'Pink', colour: '#e58bb6' },
  ],
  top: [
    { id: 'sky', name: 'Sky blue', colour: '#69bfe9' },
    { id: 'lilac', name: 'Lilac', colour: '#b29be4' },
    { id: 'mint', name: 'Mint', colour: '#78c6a3' },
    { id: 'coral', name: 'Coral', colour: '#ef8a91' },
    { id: 'mustard', name: 'Mustard', colour: '#efbd72' },
    { id: 'steel', name: 'Steel blue', colour: '#74a7d0' },
    { id: 'charcoal', name: 'Charcoal', colour: '#4b5566' },
    { id: 'cream', name: 'Cream', colour: '#f3ead8' },
  ],
  glasses: [
    { id: 'none', name: 'None' },
    { id: 'square', name: 'Glasses' },
    { id: 'round', name: 'Round glasses' },
    { id: 'sun', name: 'Sunglasses' },
  ],
  facial: [
    { id: 'none', name: 'None' },
    { id: 'stubble', name: 'Stubble' },
    { id: 'beard', name: 'Beard' },
    { id: 'moustache', name: 'Moustache' },
  ],
  headwear: [
    { id: 'none', name: 'None' },
    { id: 'beret', name: 'Beret' },
    { id: 'cap', name: 'Cap' },
    { id: 'beanie', name: 'Beanie' },
    { id: 'headphones', name: 'Headphones' },
    { id: 'bow', name: 'Bow' },
  ],
};

export const LOOK_KEYS = Object.keys(LOOK_OPTIONS) as (keyof Look)[];

/**
 * A look as sent by the page, kept only when every part is one of the ids above. A part that is not there takes the
 * first choice (a look saved before a part was added keeps the rest); a part that is there but unknown makes it null (no
 * look), never half a look: a damaged or hand-edited staff.json then shows initials, as before looks.
 */
export function cleanLook(raw: unknown): Look | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out = {} as Look;
  for (const k of LOOK_KEYS) {
    const v = r[k] ?? LOOK_OPTIONS[k][0].id;
    if (typeof v !== 'string' || !LOOK_OPTIONS[k].some(o => o.id === v)) return null;
    out[k] = v;
  }
  return out;
}
