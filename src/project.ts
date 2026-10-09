// Start project: a planned project from a few picks instead of a long prompt. The questions (who, what, when, where, why,
// how) come in rounds of at most four, each with the recommended answer already picked; a skipped one is kept as Assumed.
// The look is picked from four short libraries (type style, size and weight, mood palette, layout). Code, not a model,
// writes the Scope card and the design brief (about 2,000 characters together, so an 8K model can read them) into the
// job folder, and suggests who could do each kind of work from the models that fit. Plain functions, tested in
// test/project.test.ts; the server writes and reads the files (src/server/work.ts), and the jobs read them
// (src/jobrun/jobfiles.ts).

export interface Choice { id: string; name: string; hint?: string }
export interface Question {
  id: 'what' | 'who' | 'must' | 'why' | 'when' | 'where' | 'how';
  round: 1 | 2;
  ask: string;
  hint: string;
  kind: 'text' | 'lines' | 'choice';
  choices?: Choice[];
  /** The answer already picked (a choice id, or the text kept when it is skipped). */
  recommended: string;
  /** May be skipped (then the recommended answer is saved as Assumed). */
  skip: boolean;
  placeholder?: string;
}

export const QUESTIONS: Question[] = [
  { id: 'what', round: 1, ask: 'What is it?', hint: 'One line, in everyday words.', kind: 'text', recommended: '', skip: false,
    placeholder: 'e.g. a tip calculator, a booking page for a hair salon, a blog post about houseplants' },
  { id: 'who', round: 1, ask: 'Who is it for?', hint: 'The main person who will use it.', kind: 'choice', recommended: 'me', skip: true,
    choices: [{ id: 'me', name: 'Just me' }, { id: 'customers', name: 'My customers' }, { id: 'staff', name: 'My staff' }, { id: 'public', name: 'Anyone who finds it' }] },
  { id: 'must', round: 1, ask: 'What must it do on day one?', hint: 'Up to five things, each "A person can …". Leave it and the plan starts with the three most basic ones.', kind: 'lines',
    recommended: 'The planner picks the three most basic things it must do.', skip: true, placeholder: 'A visitor can …' },
  { id: 'why', round: 1, ask: 'Why does it exist?', hint: 'What would make you say it worked.', kind: 'choice', recommended: 'time', skip: true,
    choices: [{ id: 'time', name: 'Save me time' }, { id: 'customers', name: 'Bring in customers' }, { id: 'sell', name: 'Sell something' }, { id: 'learn', name: 'Try an idea or learn' }] },
  { id: 'when', round: 2, ask: 'When do you need it?', hint: 'Sets how much goes into the first version.', kind: 'choice', recommended: 'nodate', skip: true,
    choices: [{ id: 'today', name: 'Today', hint: 'the smallest version that works' }, { id: 'week', name: 'This week' }, { id: 'month', name: 'This month' }, { id: 'nodate', name: 'No date' }] },
  { id: 'where', round: 2, ask: 'Where will it run?', hint: 'Where people open it.', kind: 'choice', recommended: 'pc', skip: true,
    choices: [{ id: 'pc', name: 'Opens on this PC', hint: 'a file in the workspace folder' }, { id: 'site', name: 'On my website' }, { id: 'phones', name: 'On phones and PCs' }] },
  { id: 'how', round: 2, ask: 'How should it be built?', hint: 'Small models write plain code best.', kind: 'choice', recommended: 'onepage', skip: true,
    choices: [{ id: 'onepage', name: 'One page: plain HTML, CSS and JavaScript' }, { id: 'pages', name: 'A few pages: plain HTML, CSS and JavaScript' }, { id: 'text', name: 'Words only (a post or a document)' }] },
];

const choiceName = (q: Question, id: string) => q.choices?.find(c => c.id === id)?.name ?? '';

// ---- The look: four libraries, each with a default ----

export interface TypeStyle { id: string; name: string; heading: string; body: string; feels: string; suits: string; previewHeading: string; previewBody: string; headingWeight: number }
/** Fonts named for the built page (free on Google Fonts); the preview here uses a look-alike font already on Windows. */
export const TYPE_STYLES: TypeStyle[] = [
  { id: 'neutral', name: 'Neutral Modern', heading: 'Inter', body: 'Inter', feels: 'Clean, quiet, trustworthy', suits: 'tools, dashboards, almost anything', previewHeading: '"Segoe UI", system-ui, sans-serif', previewBody: '"Segoe UI", system-ui, sans-serif', headingWeight: 700 },
  { id: 'humanist', name: 'Humanist Classic', heading: 'Open Sans', body: 'Open Sans', feels: 'Friendly, plain-spoken', suits: 'trades, local services, clinics', previewHeading: 'Verdana, "Segoe UI", sans-serif', previewBody: 'Verdana, "Segoe UI", sans-serif', headingWeight: 700 },
  { id: 'geometric', name: 'Geometric Friendly', heading: 'Poppins', body: 'Poppins', feels: 'Round, confident, approachable', suits: 'apps, education, agencies', previewHeading: '"Century Gothic", "Trebuchet MS", sans-serif', previewBody: '"Century Gothic", "Trebuchet MS", sans-serif', headingWeight: 700 },
  { id: 'editorial', name: 'Editorial Serif', heading: 'Playfair Display', body: 'Inter', feels: 'Authoritative, polished', suits: 'consultancies, publishing', previewHeading: 'Georgia, "Times New Roman", serif', previewBody: '"Segoe UI", system-ui, sans-serif', headingWeight: 700 },
  { id: 'warm', name: 'Warm Editorial', heading: 'Newsreader', body: 'DM Sans', feels: 'Thoughtful, calm', suits: 'blogs, wellness, personal brands', previewHeading: '"Palatino Linotype", Georgia, serif', previewBody: '"Segoe UI", system-ui, sans-serif', headingWeight: 400 },
  { id: 'display', name: 'Warm Display Serif', heading: 'DM Serif Display', body: 'DM Sans', feels: 'Crafted, inviting', suits: 'cafés, craft, lifestyle', previewHeading: '"Bookman Old Style", Georgia, serif', previewBody: '"Segoe UI", system-ui, sans-serif', headingWeight: 400 },
  { id: 'grotesk', name: 'Tech Grotesk', heading: 'Space Grotesk', body: 'Space Grotesk', feels: 'Modern, a little futuristic', suits: 'startups, AI, creative tech', previewHeading: 'Bahnschrift, "Segoe UI", sans-serif', previewBody: 'Bahnschrift, "Segoe UI", sans-serif', headingWeight: 600 },
  { id: 'mono', name: 'Developer Mono', heading: 'IBM Plex Mono', body: 'IBM Plex Mono', feels: 'Technical, honest', suits: 'developer tools, docs', previewHeading: 'Consolas, ui-monospace, monospace', previewBody: 'Consolas, ui-monospace, monospace', headingWeight: 700 },
  { id: 'poster', name: 'Bold Poster', heading: 'Archivo Black', body: 'Inter', feels: 'Loud, high-impact', suits: 'events, campaigns', previewHeading: '"Arial Black", Impact, sans-serif', previewBody: '"Segoe UI", system-ui, sans-serif', headingWeight: 900 },
  { id: 'playful', name: 'Soft Playful', heading: 'Nunito', body: 'Nunito', feels: 'Rounded, cheerful', suits: 'kids, learning, communities', previewHeading: '"Trebuchet MS", "Segoe UI", sans-serif', previewBody: '"Trebuchet MS", "Segoe UI", sans-serif', headingWeight: 800 },
];

export interface SizeSet { id: string; name: string; h1: number; h2: number; h3: number; body: number; small: number }
export const SIZES: SizeSet[] = [
  { id: 'compact', name: 'Compact', h1: 48, h2: 32, h3: 20, body: 15, small: 13 },
  { id: 'comfortable', name: 'Comfortable', h1: 60, h2: 40, h3: 24, body: 16, small: 14 },
  { id: 'large', name: 'Large', h1: 72, h2: 48, h3: 28, body: 18, small: 15 },
];
export const WEIGHTS: Choice[] = [{ id: '300', name: 'Light' }, { id: '400', name: 'Regular' }, { id: '700', name: 'Bold' }];

export interface Palette { id: string; name: string; base: 'light' | 'dark'; page: string; card: string; ink: string; muted: string; brand: string; onBrand: string; accent: string }
const pal = (id: string, name: string, base: 'light' | 'dark', v: string): Palette => {
  const [page, card, ink, muted, brand, onBrand, accent] = v.split(' ');
  return { id, name, base, page, card, ink, muted, brand, onBrand, accent };
};
/** Mood palettes; every pair passes WCAG AA (ink and muted 4.5:1 on page and card, text on brand 4.5:1). */
export const PALETTES: Palette[] = [
  pal('trust', 'Trustworthy', 'light', '#F6F9FD #FFFFFF #0F2342 #4B5D78 #1D4ED8 #FFFFFF #0F8B8D'),
  pal('calm', 'Calm', 'light', '#F2F7F6 #FFFFFF #1F3A3A #4F6B6A #2F7F7A #FFFFFF #B9852F'),
  pal('happy', 'Happy', 'light', '#FFFBEB #FFFFFF #2B2100 #6B5413 #D97706 #1F1500 #E5484D'),
  pal('energetic', 'Energetic', 'light', '#FFFFFF #FFF4EE #111111 #555555 #D93A00 #FFFFFF #9A7A00'),
  pal('natural', 'Natural', 'light', '#F4F7EC #FFFFFF #1E2A14 #546644 #3A7D2C #FFFFFF #A8691A'),
  pal('playful', 'Playful', 'light', '#FFF7FB #FFFFFF #2A1245 #6A5585 #7C3AED #FFFFFF #D6336C'),
  pal('cosy', 'Cosy', 'light', '#FBF3E8 #FFFFFF #3A2418 #6F5748 #A94E24 #FFFFFF #5F7A45'),
  pal('retro', 'Retro', 'light', '#F6ECD9 #FFF9EC #3A2A1A #6E5B44 #B8401F #FFFFFF #2F6F73'),
  pal('romantic', 'Romantic', 'light', '#FFF5F7 #FFFFFF #3B1424 #7A5361 #C2185B #FFFFFF #B8860B'),
  pal('festive', 'Festive', 'light', '#FBF6EE #FFFFFF #1F2A1F #566356 #B3202A #FFFFFF #1F6B3A'),
  pal('minimal', 'Minimal mono', 'light', '#FAFAFA #FFFFFF #111111 #5F5F5F #111111 #FFFFFF #2563EB'),
  pal('moody', 'Moody', 'dark', '#14181F #1D232D #E4E8EE #9AA5B5 #7C9CCB #0E1218 #A594D6'),
  pal('luxury', 'Luxury', 'dark', '#0D0D0F #17171B #F2EDE4 #A8A298 #C9A96E #17130A #C75A7A'),
  pal('futuristic', 'Futuristic', 'dark', '#060914 #0E1426 #E6F0FF #8FA3C4 #22D3EE #03121A #A78BFA'),
  pal('spooky', 'Spooky', 'dark', '#120B1A #1E1228 #F4EDE6 #B7A9C3 #FF7518 #1A0A00 #8BE04E'),
];

/** A layout: its parts top to bottom, each [label, columns out of 12], for the brief and the little preview. */
export interface Layout { id: string; group: string; name: string; parts: [string, number][] }
const L = (id: string, group: string, name: string, parts: string): Layout =>
  ({ id, group, name, parts: parts.split(' | ').map(p => { const [label, cols] = p.split(':'); return [label, Number(cols)] as [string, number]; }) });
export const LAYOUTS: Layout[] = [
  L('card', 'One tool or page', 'One centred card', 'Title:12 | The tool, centred:12 | Small footer:12'),
  L('split', 'One tool or page', 'Form left, result right', 'Title:12 | Form:6 | Result:6 | Small footer:12'),
  L('article', 'One tool or page', 'One reading column', 'Title:12 | Article, narrow column:12 | Footer:12'),
  L('classic', 'Website home', 'Centred classic', 'Header:12 | Hero, centred text, two buttons:12 | Feature:4 | Feature:4 | Feature:4 | Call to action:12 | Footer:12'),
  L('splithero', 'Website home', 'Split hero', 'Header:12 | Hero text:6 | Hero image:6 | Features:12 | Prices:12 | FAQ:12 | Footer:12'),
  L('bento', 'Website home', 'Bento grid', 'Slim header:12 | Hero card:8 | Card:4 | Card:4 | Card:4 | Card:4 | Footer line:12'),
  L('editorial', 'Website home', 'Editorial', 'Header with search:12 | Lead story:8 | Small stories:4 | Topic rows:12 | Footer:12'),
  L('store', 'Website home', 'Storefront or directory', 'Search and categories:12 | Promo banner:12 | Category tiles:12 | Listing grid:12 | Footer:12'),
  L('sidebar', 'Admin', 'Sidebar and top bar', 'Top bar:12 | Sidebar:3 | Cards, chart, recent table:9'),
  L('tabs', 'Admin', 'Top tabs only', 'Tabs:12 | Card:4 | Card:4 | Card:4'),
  L('master', 'Admin', 'List and detail', 'Top bar:12 | List:4 | Selected item:8'),
  L('table', 'Admin', 'Table first', 'Top bar:12 | Sidebar:3 | Table with filters:9'),
];

export const DESIGN_DEFAULT = { type: 'neutral', weight: '700', size: 'comfortable', palette: 'trust', layout: 'card' };
export type Design = typeof DESIGN_DEFAULT;

// ---- Answers in, cleaned ----

export interface Answers {
  what: string;
  who: string;
  must: string[];
  why: string;
  when: string;
  where: string;
  how: string;
  /** Question ids he skipped: their recommended answer is kept, marked Assumed. */
  assumed: string[];
  /** The idea said back in one line (code writes it; he may change it). */
  statement: string;
}

const line = (s: unknown, max: number) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Keeps only known choices and short text; a skipped or unknown answer becomes the recommended one, marked Assumed. */
export function cleanAnswers(raw: Record<string, unknown>): Answers | { error: string } {
  const skipped = new Set(Array.isArray(raw.assumed) ? raw.assumed.map(String) : []);
  const what = line(raw.what, 120);
  if (!what) return { error: 'Say what it is first, in one line (for example "a tip calculator").' };
  const out: Answers = { what, who: '', must: [], why: '', when: '', where: '', how: '', assumed: [], statement: '' };
  for (const q of QUESTIONS) {
    if (q.id === 'what') continue;
    if (q.kind === 'lines') {
      const lines = (Array.isArray(raw.must) ? raw.must : String(raw.must ?? '').split('\n')).map(x => line(x, 100)).filter(Boolean).slice(0, 5);
      if (skipped.has('must') || !lines.length) out.assumed.push('must');
      else out.must = lines;
      continue;
    }
    const v = String(raw[q.id] ?? '');
    const known = q.choices!.some(c => c.id === v);
    (out as unknown as Record<string, string>)[q.id] = !skipped.has(q.id) && known ? v : q.recommended;
    if (skipped.has(q.id) || !known) out.assumed.push(q.id);
  }
  out.statement = line(raw.statement, 200) || sayBack(out);
  return out;
}

const WHO_PHRASE: Record<string, string> = { me: 'just me', customers: 'my customers', staff: 'my staff', public: 'anyone who finds it' };
const WHY_PHRASE: Record<string, string> = { time: 'save time', customers: 'bring in customers', sell: 'sell something', learn: 'try an idea' };
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The idea said back in one line, written by code from the answers. */
export function sayBack(a: Pick<Answers, 'what' | 'who' | 'why' | 'must'>): string {
  const what = upper(a.what.replace(/[.!?\s]+$/, ''));
  const first = a.must[0] ? `; first, ${a.must[0].replace(/[.!?\s]+$/, '').replace(/^./, c => c.toLowerCase())}` : '';
  return line(`${what}, for ${WHO_PHRASE[a.who] ?? 'just me'}, to ${WHY_PHRASE[a.why] ?? 'save time'}${first}.`, 200);
}

// ---- A wish nobody can promise: one kind line, written by code ----

const WISHES: { re: RegExp; what: string }[] = [
  { re: /\$\s?\d[\d,.]*\s*(?:b|bn|billion|m|mn|million)\b|\b(?:make|makes|earn|earns|worth|revenue of)\s+(?:me\s+)?(?:a |one |\$\s?)?[\d,.]*\s*(?:billion|million)\b/i, what: 'an amount of money' },
  { re: /\b(?:no|zero|without any|never (?:make|have) (?:any )?)\s*(?:mistakes?|bugs?|errors?)\b|\bbug[- ]free\b|\bflawless\b/i, what: 'no mistakes' },
  { re: /\bguarantee[ds]?\b|\b100\s?%/i, what: 'a guarantee' },
  { re: /\bgo(?:es)? viral\b|\b(?:#\s?1|number one|top) (?:on|in) google\b|\bovernight success\b/i, what: 'a result that depends on other people' },
];

/** One kind line when the words wish for something nobody can promise, else null. */
export function wishLine(...texts: string[]): string | null {
  const t = texts.join(' \n ');
  const hit = WISHES.find(w => w.re.test(t));
  if (!hit) return null;
  return `Nobody can promise ${hit.what}, but this can: a planned build in small steps, each one checked, with an honest note of what was and was not tested.`;
}

// ---- The two cards written into the job folder ----

/** The Scope card: statement, functions, the six answers and what was assumed. About 1,200 characters at most. */
export function scopeCard(a: Answers, hope: string | null = null): string {
  const q = (id: Question['id']) => QUESTIONS.find(x => x.id === id)!;
  const ans = (id: Exclude<Question['id'], 'what' | 'must'>) => choiceName(q(id), a[id]);
  const fx = a.must.length ? a.must.map((f, i) => `F${i + 1}. ${f}`) : ['F1-F3: the planner picks the three most basic things it must do (Assumed).'];
  const rows = [
    'SCOPE CARD',
    `Statement: ${a.statement}`,
    'Must do on day one:',
    ...fx,
    `What: ${a.what}`,
    `Who: ${ans('who')} · Why: ${ans('why')}`,
    `When: ${ans('when')} · Where: ${ans('where')}`,
    `How: ${ans('how')}`,
  ];
  if (a.assumed.length) rows.push(`Assumed (not answered; change any before planning): ${a.assumed.map(id => id === 'must' ? 'Must do' : `${upper(id)} = ${ans(id as 'who')}`).join('; ')}.`);
  if (hope) rows.push(`Hope, not promised: ${line(hope, 120)}`);
  return rows.join('\n');
}

export function cleanDesign(raw: Record<string, unknown>): Design {
  const pick = <T extends { id: string }>(list: T[], v: unknown, d: string) => (list.some(x => x.id === v) ? String(v) : d);
  return {
    type: pick(TYPE_STYLES, raw.type, DESIGN_DEFAULT.type),
    weight: pick(WEIGHTS, raw.weight, DESIGN_DEFAULT.weight),
    size: pick(SIZES, raw.size, DESIGN_DEFAULT.size),
    palette: pick(PALETTES, raw.palette, DESIGN_DEFAULT.palette),
    layout: pick(LAYOUTS, raw.layout, DESIGN_DEFAULT.layout),
  };
}

/** The design brief: type, sizes, colours by role, layout. About 750 characters. */
export function designBrief(d: Design): string {
  const t = TYPE_STYLES.find(x => x.id === d.type)!;
  const s = SIZES.find(x => x.id === d.size)!;
  const p = PALETTES.find(x => x.id === d.palette)!;
  const l = LAYOUTS.find(x => x.id === d.layout)!;
  const w = WEIGHTS.find(x => x.id === d.weight)!;
  return [
    'DESIGN BRIEF',
    `Type: ${t.name} (${t.feels.toLowerCase()}). Headings ${t.heading} ${w.name.toLowerCase()} ${d.weight}, body ${t.body} 400 (Google Fonts; fall back to system-ui).`,
    `Sizes (${s.name}): h1 ${s.h1}px, h2 ${s.h2}px, h3 ${s.h3}px, body ${s.body}px, small ${s.small}px. Line height 1.55 body, 1.1 h1. Phone: h1 x0.65, never under 34px. No text under 12px.`,
    `Colours (${p.name}, ${p.base}): page ${p.page}, card ${p.card}, ink ${p.ink}, muted ${p.muted}, brand ${p.brand}, text on brand ${p.onBrand}, accent ${p.accent}. Use them as CSS variables.`,
    `Layout (${l.group}: ${l.name}): ${l.parts.map(([label, cols]) => cols === 12 ? label : `${label} (${cols}/12)`).join(', ')}. One column on a phone.`,
  ].join('\n');
}

// ---- Suggested hires: per kind of work, from models that fit; only suggested, never assigned ----

export interface Candidate {
  kind: 'chat' | 'image';
  /** A hire's name, or null for a model nobody was hired on yet. */
  hire: string | null;
  role: string | null;
  model: string;
  /** "This PC" or the linked PC's name. */
  where: string;
  /** Model size in billions of parameters (0 when unknown). */
  sizeB: number;
  /** Context in tokens (0 when unknown). */
  ctx: number;
  /** 'ok' | 'tight' | 'no' for this PC; a linked PC's own staff count as 'ok' (they run there). */
  fit: 'ok' | 'tight' | 'no';
}
export interface Suggestion { work: 'plan' | 'code' | 'write' | 'pictures'; label: string; who: string | null; where: string | null; reason: string }

export const WORK: { id: Suggestion['work']; label: string; role: string }[] = [
  { id: 'plan', label: 'Plan the steps', role: 'pm' },
  { id: 'code', label: 'Write the code', role: 'coder' },
  { id: 'write', label: 'Write the words', role: 'writer' },
  { id: 'pictures', label: 'Draw the pictures', role: 'artist' },
];

const k = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n));
const whoText = (c: Candidate) => (c.hire ? `${c.hire} (${c.model})` : c.model);
const onText = (c: Candidate) => (c.where === 'This PC' ? 'this PC' : `"${c.where}"`);

/** One suggestion per kind of work, each with a one-line reason; the person decides. */
export function suggestHires(all: Candidate[], words = ''): Suggestion[] {
  const usable = all.filter(c => c.fit !== 'no');
  const chat = usable.filter(c => c.kind === 'chat');
  const fitRank = (c: Candidate) => (c.fit === 'ok' ? 1 : 0);
  const out: Suggestion[] = [];
  for (const w of WORK) {
    const none = (reason: string): Suggestion => ({ work: w.id, label: w.label, who: null, where: null, reason });
    if (w.id === 'pictures') {
      const pics = usable.filter(c => c.kind === 'image').sort((a, b) => Number(!!b.hire) - Number(!!a.hire) || Number(b.where !== 'This PC') - Number(a.where !== 'This PC') || fitRank(b) - fitRank(a));
      const c = pics[0];
      if (!c) { out.push(none('Nobody can draw yet: get a picture model under Models (DreamShaper 8 is about 2 GB).')); continue; }
      out.push({ work: w.id, label: w.label, who: whoText(c), where: c.where, reason: c.where !== 'This PC' ? `Draws on ${onText(c)}, so this PC stays free for the code.` : c.hire ? `${c.hire} is your ${c.role === 'designer' ? 'graphic designer' : 'artist'} and the model fits this PC.` : 'The picture model on this PC that fits; nobody is hired on it yet.' });
      continue;
    }
    if (!chat.length) { out.push(none('No chat model fits yet: get one under Models (a 2B to 9B model).')); continue; }
    let pick: Candidate;
    let reason: string;
    if (w.id === 'plan') {
      pick = [...chat].sort((a, b) => b.ctx - a.ctx || b.sizeB - a.sizeB || fitRank(b) - fitRank(a))[0];
      reason = `The longest context${pick.ctx ? ` (${k(pick.ctx)} tokens)` : ''} that fits: the planner reads the whole Scope card and design brief at once.`;
    } else {
      const own = chat.filter(c => c.role === w.role).sort((a, b) => fitRank(b) - fitRank(a) || b.sizeB - a.sizeB)[0];
      const named = w.id === 'code' ? chat.filter(c => /coder|code/i.test(c.model)).sort((a, b) => b.sizeB - a.sizeB)[0] : undefined;
      const biggest = [...chat].sort((a, b) => b.sizeB - a.sizeB || fitRank(b) - fitRank(a))[0];
      pick = own ?? named ?? biggest;
      reason = own ? `${own.hire} is your ${w.id === 'code' ? 'coder' : 'writer'}, on ${onText(own)}.`
        : named ? 'A model made for code, and it fits.'
        : `The biggest model that fits${pick.sizeB ? ` (about ${pick.sizeB}B)` : ''}; nobody is hired as the ${w.id === 'code' ? 'coder' : 'writer'} yet.`;
      if (w.id === 'write' && !own && !/\b(?:text|post|blog|article|document|words)\b/i.test(words)) reason += ' Only needed for help text and labels.';
    }
    out.push({ work: w.id, label: w.label, who: whoText(pick), where: pick.where, reason });
  }
  return out;
}

// ---- "Lets create a project" on Home: a name, a folder, a mini description and the prompt ----

export interface Quick { name: string; folder: string; about: string; prompt: string }

/** The four fields cleaned; the prompt (or, without one, the description) is what gets planned. */
export function cleanQuick(raw: Record<string, unknown>, folder: string): Quick | { error: string } {
  const about = line(raw.about, 200);
  const prompt = String(raw.prompt ?? '').replace(/\r/g, '').trim().slice(0, 1500);
  if (!prompt && !about) return { error: 'Type the prompt first: what should exist when it is finished?' };
  const name = line(raw.name, 80) || `Project ${folder}`;
  return { name, folder, about, prompt };
}

/**
 * The Scope card for a project made on Home: written by code from the person's own words (no questions were asked). The mini
 * description is the statement; `hope`: the description when it wishes for what nobody can promise, listed as a hope.
 */
export function quickScope(q: Quick, hope: string | null = null): string {
  const statement = hope === q.about ? '' : q.about;
  const rows = [
    'SCOPE CARD',
    `Project: ${q.name}`,
    statement ? `Statement: ${statement}` : '',
    q.prompt ? `What is asked:\n${q.prompt}` : `Statement: ${q.about}`,
  ];
  if (hope) rows.push(`Hope, not promised: ${line(hope, 120)}`);
  return rows.filter(Boolean).join('\n');
}

/** The files a project keeps in its job folder. */
export const projectPath = (id: string, file: 'project.json' | 'scope.md' | 'design.md') => `jobs/${id}/${file}`;
