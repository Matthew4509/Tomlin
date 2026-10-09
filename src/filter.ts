// The fixed adult limits, enforced in code between the person and the model (the prompt alone is not enough: a small
// model can be talked out of anything). Everything between adults is allowed. Two things are never allowed in anything
// sexual, in either direction:
//   1. anyone under 18, or described as a child, "young", at school, or by a school grade or an age under 18;
//   2. real, identifiable people: celebrities, exes, people the person knows.
// A message (a picture prompt, a job goal or step, a request from a linked PC) is checked before a model sees it.
//
// These are word checks, so they err on the side of refusing: "young" or "school" near anything sexual is refused even
// when it was innocent. They cannot recognise every real person (a single first name, or a lower-case full name, gets
// through). test/filter.test.ts is a release blocker.

export type Verdict = { ok: true } | { ok: false; reason: 'minor' | 'real-person'; words: string };

export const REFUSAL: Record<'minor' | 'real-person', string> = {
  minor: 'Not that. Nothing sexual with anyone under 18, or anyone described as a child, young or at school, even in a story. Change the subject and carry on.',
  'real-person': 'Not that. Nothing sexual about real people: celebrities, exes, or anyone you know. Make someone up instead and carry on.',
};

// ---- Normalising: what people do to get words past a filter ----

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

/** Lower case, accents and look-alike letters folded, invisible characters removed, runs of 3+ letters cut to two
 * ("teeeen" -> "teen"; variants() also tries one, for "loooli"). */
export function plain(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[­​-‏⁠﻿]/g, '')
    .replace(/[‘’ʼ`]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, '-')
    .toLowerCase()
    .replace(/([a-z])\1{2,}/g, '$1$1');
}

/** The same with digits and symbols read as letters (for words; ages are read from plain()). */
function unleet(text: string): string {
  return text.replace(/(?<=[a-z])[0134579@$!]|[0134579@$!](?=[a-z])/g, c => LEET[c] ?? c);
}

/** Letters only, for words spelt out with gaps ("l o l i", "u.n.d.e.r.a.g.e"). */
/** The forms each word check runs on: as written, digits read as letters, and doubled letters cut to one. */
function variants(p: string): string[] {
  const u = unleet(p);
  return [p, u, u.replace(/([a-z])\1+/g, '$1')];
}

function squashed(text: string): string {
  return text.replace(/[^a-z]/g, '');
}

// ---- Sexual content ----

const SEXUAL = new RegExp('\\b(' + [
  // Food, family and work are everyday talk: "chicken breasts", "take it off the heat", "hard for the kids", "dog
  // grooming" and "the kids sleep with me" must not count, so the ambiguous words only count in their sexual shape.
  'sex', 'sexy', 'sexual(ly)?', 'sexting', 'fuck(s|ed|ing|er)?', 'cum(s|ming|med)?', 'orgasm(s|ing)?', 'horny', 'aroused?', 'arousal',
  'naked', 'nude(s)?', 'nudity', 'nsfw', 'porn(o|y)?', 'pornographic', 'erotic(a)?', 'sensual', 'lust(ful)?', 'kink(y|s)?', 'fetish(es)?',
  'blow ?jobs?', 'hand ?jobs?', 'rim ?jobs?', 'dick(s)?', 'cock(s)?', 'penis', 'pussy', 'pussies', 'clit(oris)?', 'vagina', 'tits', 'titties',
  'boobs?', 'nipples?', 'anal', 'butt ?plug', 'dildo', 'vibrator', 'erection', 'hard[- ]?on', 'strip ?club', 'stripper', 'strip ?tease',
  'strip(ping)? (off|down|naked|for (me|you))', 'undress(ing|ed)?', 'lingerie', 'panties', 'thong', 'bra', 'knickers', 'masturbat\\w*',
  'wank(ing|er)?', 'jerk(ing)? off', 'jack(ing)? off', 'finger(ing|ed) (me|you|her|him|myself|yourself)', 'grop(e|ed|ing)', 'fondl(e|ed|ing)',
  'foreplay', 'make out', 'making out', 'seduc(e|ed|ing|tive)', 'hook(ed|ing)? up with (me|you|him|her|someone)', 'turn(s|ed)? (me|you) on',
  'spank(ing|ed)?', 'bdsm', 'bondage', 'dominatrix', 'doggy ?style', 'sixty[- ]?nine', 'threesome',
  'rape', 'raped', 'molest(ed|ing|ation)?', 'suck(ing)? (me|you|him|her) off', 'lick(ing)? (me|you|her|him) (out|all over)',
  'bend (me|you|her|him) over', 'take (your|my|her|his) (clothes|top|shirt|bra|pants|knickers|panties|dress|skirt|underwear) off',
  'touch(ing)? (me|you|her|him|myself|yourself) (there|down there)', '(so|getting|make me|made me|makes me) (wet|hard)',
  'bed(room)? with (me|you)', 'in bed together', 'onlyfans',
  // Plain words for sex. "sleep with" only counts about her or him or you: "the kids sleep with me" stays everyday talk.
  'sleep(s|ing)? with (her|him|you)', 'slept with (her|him|you)', 'take (her|him|the \\w+|a \\w+) to bed', 'go(ing)? to bed with (her|him|you)', 'get(ting)? (her|him) laid',
  'get(ting)? laid', 'bang(ing|ed)? (her|him|you)', 'screw(ing|ed)? (her|him|you)', 'do(ing)? (her|him) (hard|from behind)', 'have my way with',
  'make love', 'making love', '(intimate|intimacy) with (her|him|you)', 'be with (her|him) like that',
].join('|') + ')\\b', 'i');

/** True when the text is sexual (or on the way there). Errs on the side of yes. */
export function isSexual(text: string): boolean {
  const p = plain(text);
  return variants(p).some(v => SEXUAL.test(v));
}

// ---- Minors ----

const MINOR_WORDS = new RegExp('\\b(' + [
  'child', 'children', 'childs', 'childlike', 'kid', 'kids', 'kiddo', 'kiddie(s)?', 'kiddy', 'minor', 'minors', 'under ?age(d)?',
  'teen', 'teens', 'teenage(d|r|rs)?', 'preteen(s)?', 'pre-teen(s)?', 'tween(s)?', 'adolescent(s)?', 'pubescent', 'prepubescent',
  'pre-pubescent', 'puberty', 'juvenile(s)?', 'toddler(s)?', 'infant(s)?', 'newborn(s)?', 'loli(s|con)?', 'shota(con)?', 'jailbait',
  'school ?girls?', 'school ?boys?', 'school ?kids?', 'school(s)?', 'schooler(s)?', 'pupils?', 'kindergarten', 'kindergartener',
  'elementary', 'middle school', 'junior high', 'high school(er)?', 'primary school', 'secondary school', 'grade school(er)?',
  'freshman', 'sophomore', 'little (girl|boy|girls|boys|one|ones)', 'young (girl|boy|girls|boys|one|ones|thing|lad|lass)',
  'girl scouts?', 'boy scouts?', 'brownies', 'cub scouts?', 'pedo(s|phile|philia)?', 'paedo(s|phile|philia)?', 'cp',
  'sweet sixteen', 'quinceanera', 'bar mitzvah', 'bat mitzvah', 'babysat',
].join('|') + ')\\b', 'i');

/** "young", "younger", "youngest", "youthful" - except when it plainly means an adult ("young woman", "feel young"). */
const YOUNG = /\b(young(er|est|ish|ster|sters|ling|lings)?|youthful|youth|underdeveloped|undeveloped|flat[- ]chested)\b(?!\s+(woman|women|lady|ladies|man|men|adult|adults|professional|professionals|couple|wife|husband|mum|mom|mother|dad|father|at heart))/i;
const FEEL_YOUNG = /\b(feel(s|ing)?|felt|look(s|ing)?|stay(s|ing)?|keep(s)? (me|you)) (so |really |much )?young(er)?\b/gi;

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
};
const NUM = `(\\d{1,2}|${Object.keys(NUMBER_WORDS).join('|')})`;
const AGE_PATTERNS = [
  new RegExp(`\\b${NUM}\\s*(?:-|\\s)?\\s*(?:yo|y/o|y\\.o\\.?)\\b`, 'gi'),
  new RegExp(`\\b${NUM}\\s*(?:-|\\s)?\\s*(?:yrs?|years?|year)\\s*-?\\s*olds?\\b`, 'gi'),
  new RegExp(`\\b(?:age|aged|ages|age of)\\s*(?:of\\s*)?${NUM}\\b`, 'gi'),
  new RegExp(`\\b(?:i am|i'm|im|who is|who's|whos|who was|who are|she was|he was|was only|she is|she's|shes|he is|he's|hes|you are|you're|youre|ur|they are|they're|is only|is just|only|just turned|turned|turning)\\s+(?:only\\s+|just\\s+|barely\\s+)?${NUM}(?![\\d%]|[.,:/]\\d|\\s*(?:min|mins|minute|minutes|hour|hours|hrs?|sec|secs|seconds?|days?|weeks?|months?|km|kms|miles?|mi|foot|feet|ft|inch|inches|in|cm|mm|kg|kgs|lbs?|pounds?|stone|percent|times|x|am|pm|o'clock|of|out|and a half|drinks?|beers?|shots?|dollars?|bucks|quid))`, 'gi'),
  new RegExp(`\\b${NUM}\\s*(?:st|nd|rd|th)?\\s+grade(r|rs)?\\b`, 'gi'),
  /\bgrade\s+(\d{1,2})\b/gi,
  /\byear\s+(\d{1,2})\s+(?:student|pupil)s?\b/gi,
  /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\s+grade(r|rs)?\b/gi,
];

function ageUnder18(p: string): string | null {
  for (const re of AGE_PATTERNS) {
    for (const m of p.matchAll(re)) {
      const raw = m[1];
      if (raw === undefined || /^(r|rs)$/.test(raw)) return m[0]; // grade words carry no number and are always school age
      const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
      if (n !== undefined && n < 18) return m[0];
    }
  }
  // "N years" without "old" is mostly a length of time ("married for 10 years", "10 years ago"). It is an age only
  // beside a person: "a 16 year girl", "girl, 16 years", "her 16yrs".
  for (const m of p.matchAll(BARE_YEARS)) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
    if (n === undefined || n >= 18) continue;
    const before = p.slice(Math.max(0, m.index - 30), m.index);
    const after = p.slice(m.index + m[0].length, m.index + m[0].length + 30);
    if (DURATION_BEFORE.test(before) || DURATION_AFTER.test(after)) continue;
    if (PERSON_AFTER.test(after) || PERSON_BEFORE.test(before)) return m[0];
  }
  return null;
}

const PERSON = 'girls?|boys?|gf|bf|girlfriend|boyfriend|daughter|son|niece|nephew|sister|brother|cousin|step ?daughter|step ?son|student|virgin|babysitter|body|child|kid|female|male|f|m';
const BARE_YEARS = new RegExp(`\\b${NUM}\\s*(?:-|\\s)?\\s*(?:yrs?|years?)\\b(?!\\s*-?\\s*olds?\\b)`, 'gi');
const PERSON_AFTER = new RegExp(`^\\s*-?\\s*(?:${PERSON})\\b`);
const PERSON_BEFORE = new RegExp(`\\b(?:${PERSON}|her|him|she|he|she's|he's|shes|hes)\\s*[,:(-]?\\s*$`);
const DURATION_BEFORE = /\b(for|past|last|over|after|within|in|been|together|married|almost|nearly|about|around|than|every|those|these|many|few)\s*$/;
const DURATION_AFTER = /^\s*(ago|later|now|since|before|back|together|married|of|in|on|from|and|or|old|younger|older|apart|between)\b/;

const SQUASHED_MINOR = /(loli|shota|underage|preteen|prepubescent|jailbait|schoolgirl|schoolboy|pedophil|paedophil|toddler|kindergarten)/;

// Schooling that is for adults, or that is over: "night school", "trade school", "law school", "finished school in 2004".
// These do not place a minor, so they are taken out before the school words are looked for. An age under 18 or a
// child word next to them is still found by the other checks.
const ADULT_SCHOOL = /\b(?:night|evening|learning|trade|technical|vocational|adult|law|med|medical|nursing|grad|graduate|business|beauty|culinary|driving|flight|dental|veterinary|police|military)\s+schools?\b|\b(?:finish(?:ed|ing)?|left|quit|since|out of|year (?:i|you|he|she|we|they) (?:finished|left))\s+(?:high |grad |trade |the )?school\b|\bschool reunions?\b/g;

/** The words that place a minor in the text, or null. */
export function minorWords(text: string): string | null {
  const p = plain(text).replace(ADULT_SCHOOL, ' ');
  const u = unleet(p);
  const word = variants(p).map(v => MINOR_WORDS.exec(v)).find(Boolean);
  if (word) return word[0];
  const young = YOUNG.exec(p.replace(FEEL_YOUNG, ' '));
  if (young) return young[0];
  const age = ageUnder18(p);
  if (age) return age;
  // Spelt with gaps: only long words that cannot turn up by accident across ordinary words.
  const gapped = /[a-z][^a-z\s]{1,2}[a-z]|(?:\b[a-z]\s){3,}/.test(p) ? SQUASHED_MINOR.exec(squashed(u)) : null;
  return gapped ? gapped[0] : null;
}

// ---- Real people ----

const PEOPLE_WORDS = new RegExp('\\b(' + [
  'my ex', 'ex', "ex's", 'exes', 'ex-?(girlfriend|boyfriend|wife|husband|partner|gf|bf)s?', 'co-?workers?', 'colleagues?', 'my boss',
  'boss', 'bosses', 'my manager', 'supervisor', 'employees?', 'neighbou?rs?', 'classmates?', 'room-?mates?', 'flat-?mates?',
  'house-?mates?', 'landlord', 'landlady', 'my (best )?friend', "my (best )?friend's", "(friend|mate|brother|neighbou?r|boss)'s (wife|girlfriend|husband|boyfriend|mum|mom|sister|daughter|partner)",
  '(girl|guy|woman|man|lady|someone|people) (i know|from work|at work|at the office|at my office|at the gym|next door)',
  'celebrit(y|ies)', 'celebs?', 'famous', 'actress(es)?', 'actors?', 'singers?', 'pop ?stars?', 'rappers?',
  'influencers?', 'streamers?', 'youtubers?', 'tiktokers?', 'instagram', 'insta', 'politicians?', 'president', 'prime minister',
  'royal family', 'real (person|people|woman|women|man|men|girl|guy)', 'real[- ]life (person|people|woman|man)', 'irl',
].join('|') + ')\\b', 'i');

/** Two or more capitalised words in a row that are not ordinary words or places: probably someone's full name. */
const ORDINARY_CAPS = new Set([
  'i', 'oh', 'my', 'god', 'gods', 'jesus', 'christ', 'yes', 'no', 'hey', 'hi', 'hello', 'ok', 'okay', 'please', 'mr', 'mrs', 'ms', 'miss',
  'sir', 'madam', 'dear', 'baby', 'babe', 'honey', 'good', 'morning', 'night', 'evening', 'happy', 'merry', 'christmas', 'new', 'year',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december', 'the', 'and', 'of', 'a', 'an', 'you', 'me', 'we', 'it', 'lol', 'omg',
  'york', 'los', 'las', 'san', 'santa', 'city', 'angeles', 'vegas', 'francisco', 'diego', 'hong', 'kong', 'zealand', 'united', 'states',
  'kingdom', 'south', 'north', 'east', 'west', 'saint', 'st', 'fort', 'port', 'mount', 'lake', 'river', 'beach', 'island', 'islands',
  'street', 'road', 'park', 'hotel', 'club', 'bar', 'restaurant', 'airport', 'station', 'america', 'american', 'english',
]);

function fullNames(text: string, known: Set<string>): string | null {
  // Sentence starts are capitalised anyway, so a name must be two capitalised words where neither is ordinary.
  for (const m of text.matchAll(/\b([A-Z][a-z'’]+)(?:\s+(?:de|van|von|del|la|le|da|di|al|bin|mac|mc))?\s+([A-Z][a-z'’]+)\b/g)) {
    const [a, b] = [m[1].toLowerCase(), m[2].toLowerCase()];
    if (ORDINARY_CAPS.has(a) || ORDINARY_CAPS.has(b) || known.has(a) || known.has(b)) continue;
    return m[0];
  }
  return null;
}

/** An @handle: a real account. */
const HANDLE = /(^|\s)@[a-z0-9_.]{2,}/i;

/** The words that point at a real person, or null. `known` = names known to be made up (none unless given). */
export function realPersonWords(text: string, known: Set<string> = new Set(), namesToo = true): string | null {
  const p = plain(text);
  const w = variants(p).map(v => PEOPLE_WORDS.exec(v)).find(Boolean);
  if (w) return w[0];
  const h = HANDLE.exec(text);
  if (h) return h[0].trim();
  return namesToo ? fullNames(text.normalize('NFKC'), known) : null;
}

// ---- The check ----

export interface Context {
  /** The newest messages before this one, oldest first (both sides, blocked ones already left out). */
  recent: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** What the person's recent messages and the last answer bring with them: the window the limits look at. */
function windowOf(ctx: Context): { user: string; last: string } {
  const users = ctx.recent.filter(t => t.role === 'user').slice(-2).map(t => t.content);
  const last = [...ctx.recent].reverse().find(t => t.role === 'assistant')?.content ?? '';
  return { user: users.join('\n'), last };
}

/**
 * The person's message, before the model sees it. Sexual (here or just before) + a minor (here, in their last two
 * messages, or in the last answer) = refused. Sexual + a real person (here or their last two) = refused.
 */
export function checkMessage(message: string, ctx: Context): Verdict {
  const { user, last } = windowOf(ctx);
  const sexual = isSexual(message) || isSexual(user) || isSexual(last);
  if (!sexual) return { ok: true };
  const minor = minorWords(message) ?? minorWords(user) ?? minorWords(last);
  if (minor) return { ok: false, reason: 'minor', words: minor };
  const person = realPersonWords(message) ?? realPersonWords(user);
  if (person) return { ok: false, reason: 'real-person', words: person };
  return { ok: true };
}

