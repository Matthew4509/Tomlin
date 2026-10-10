// Staff: a named person TOMLIN "hires" for a role at a level. The role is what they do (their prompt and example lines);
// the level is the size of model they are meant to run on. The level only SUGGESTS models: any model can be given to any
// hire, and the audition measures whether it really suits the role. Small models copy example lines better than they
// follow rules, so every role carries examples, and the system prompt (examples included) is sent on every turn.
import { join } from 'node:path';
import { readData, writeAtomic } from './atomic.ts';
import { TONES } from './persona.ts';
import { cleanLook, type Look } from './look.ts';

export interface Level {
  id: string;
  name: string;
  /** Plain-words size, and the rough model size (billions of parameters) it stands for. */
  size: string;
  minB: number;
  maxB: number;
  /** How a person at this level works. Style only: it cannot make a small model cleverer. */
  style: string;
  /** Models worth looking at. Suggestions, never a limit. */
  suggest: string;
}

/**
 * Default: no size is suggested (every model ranks the same) and no "how you work" line is sent. The first choice in
 * the Level list of Hire staff. Kept apart from LEVELS, which are the sizes (levelOfSize and the ordering read only those).
 */
export const DEFAULT_LEVEL: Level = { id: 'default', name: 'Default', size: 'any size', minB: 0, maxB: 100000, style: '',
  suggest: 'Any model you have: Default suggests no size and adds no "how you work" line.' };

export const LEVELS: Level[] = [
  { id: 'junior', name: 'Junior', size: 'about 2B (up to 3B)', minB: 0, maxB: 3.5,
    style: 'You are junior: you keep to small, clear tasks, say so when something is beyond you, and ask one short question when the request is unclear. Keep answers short.',
    suggest: 'A 1B to 3B model, for example a small Qwen3 or Gemma 3. Runs on almost any PC.' },
  { id: 'experienced', name: 'Experienced', size: '7B to 9B (4B to 13B)', minB: 3.5, maxB: 13.5,
    style: 'You are experienced (a few years in the job): you give a solid answer first, then point out the one thing that most often goes wrong.',
    suggest: 'A 7B to 9B model, for example Qwen3 8B or Gemma 3 12B. Wants 8 GB of free memory or more.' },
  { id: 'expert', name: 'Expert', size: 'about 35B (14B to 50B)', minB: 13.5, maxB: 50,
    style: 'You are an expert: you are brief and decisive, give the answer and the reason, and say what you would do differently and why.',
    suggest: 'A 30B to 35B model, often a "mixture of experts" model that is fast for its size. Wants about 24 GB of memory or a graphics card.' },
  { id: 'senior', name: 'Senior', size: '70B and up', minB: 50, maxB: 100000,
    style: 'You are senior: you see the whole picture, weigh trade-offs, say what you would not do and why, and say plainly when you are unsure.',
    suggest: 'A 70B or bigger model, for example GLM 5.2 (not tried here). Needs a big machine or a linked machine; TOMLIN will tell you if it will not fit.' },
];

export interface Check {
  label: string;
  /** True when the answer passes. */
  pass: (answer: string) => boolean;
}

export interface Role {
  id: string;
  name: string;
  hint: string;
  prompt: string;
  /** Lines that show how the role sounds (small models copy these). */
  examples: string[];
  /** Three fixed prompts for the audition, each with plain checks on the answer. */
  audition: Array<{ ask: string; checks: Check[] }>;
  /** True when a mixture-of-experts model is a good match (broad knowledge, fast). */
  likesMoe?: boolean;
  /** 'image' roles work in the Images window with a picture model; the rest chat. */
  kind?: 'image';
  /** Image roles: how every picture they draw is shaped (added after the person's own words). */
  recipe?: ImageRecipe;
  /** Image roles: three fixed prompts for the audition. */
  pictures?: Array<{ ask: string }>;
}

export interface ImageRecipe {
  /** Forced mode, or undefined to let the prompt decide. */
  mode?: 'icon' | 'blog' | 'custom';
  boost: string;
  negative: string;
  drafts: number;
}

const words = (s: string) => (s.match(/\S+/g) ?? []).length;
const hasList = (s: string) => (s.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) ?? []).length >= 3;
const hasCode = (s: string) => /```|[{};]\s*$|\bdef |\bfunction |=>|\bconst |\bfor \(/m.test(s);
const question = (s: string) => s.includes('?');

export const ROLES: Role[] = [
  {
    id: 'default',
    name: 'Default',
    hint: 'The model as it is, like a plain chat window: no role, no memory, no settings of ours. Use it for anything the model can do.',
    // Nothing is sent: no instructions, no examples. The audition is three plain jobs, to see what the model does alone.
    prompt: '',
    examples: [],
    audition: [
      { ask: 'What is the capital of Australia? Answer in one line.', checks: [{ label: 'said Canberra', pass: a => /canberra/i.test(a) }, { label: 'kept it short', pass: a => words(a) <= 40 }] },
      { ask: 'Write a JavaScript function that returns the largest number in an array.', checks: [{ label: 'gave code', pass: hasCode }] },
      { ask: 'In two sentences, why is the sky blue?', checks: [{ label: 'named the scattering', pass: a => /scatter/i.test(a) }, { label: 'about two sentences', pass: a => (a.match(/[.!?](\s|$)/g) ?? []).length <= 4 }] },
    ],
  },
  {
    id: 'coder',
    name: 'Coder',
    hint: 'Writes and fixes code, explains what it did.',
    prompt: 'You are a software developer. Give working code in a code block, then say in one or two sentences what it does. Name the language. If the request is unclear, ask one question first. Do not invent libraries or functions; say so when you are not sure.',
    examples: ['Here is the code:\n```js\n// the code goes here\n```\nOne or two plain sentences on what it does.', 'Which language do you want this in?'],
    audition: [
      { ask: 'Write a JavaScript function that returns the largest number in an array.', checks: [{ label: 'gave code', pass: hasCode }, { label: 'short enough to read', pass: a => words(a) < 220 }] },
      { ask: 'This Python prints nothing. What is wrong?\n\nfor i in range(3):\nprint(i)', checks: [{ label: 'found the indentation', pass: a => /indent/i.test(a) }, { label: 'showed the fix', pass: hasCode }] },
      { ask: 'Make me an app.', checks: [{ label: 'asked what app', pass: question }, { label: 'did not dump code', pass: a => !/```/.test(a) }] },
    ],
  },
  {
    id: 'writer',
    name: 'Writer',
    hint: 'Letters, articles and posts, in the tone you choose.',
    prompt: 'You are a writer. Write clear, natural prose with no filler and no headings unless asked. Ask for the one fact you need if it is missing (who it is for, how long). Do not praise the request. Give the piece, then stop.',
    examples: ['Here is a short version:\n\nThe shop opens at nine and closes at five, Monday to Saturday.', 'Who is this for, and about how long should it be?'],
    audition: [
      { ask: 'Write two sentences about why people enjoy baking bread.', checks: [{ label: 'about two sentences', pass: a => (a.match(/[.!?](\s|$)/g) ?? []).length <= 4 }, { label: 'no "as an AI"', pass: a => !/as an ai|language model/i.test(a) }] },
      { ask: 'Write a polite note to a neighbour about loud music last night.', checks: [{ label: 'a real note', pass: a => words(a) >= 25 }, { label: 'not too long', pass: a => words(a) <= 160 }] },
      { ask: 'Write a post.', checks: [{ label: 'asked what about', pass: question }] },
    ],
  },
  {
    id: 'pm',
    name: 'Project manager',
    hint: 'Breaks a goal into steps and risks. Knows a little of everything.',
    prompt: 'You are a project manager. You know a little about everything and ask the right questions. When you are given a goal or a project, answer in this shape: Goal (one line), Steps (a numbered list of at most six), Risks (two or three bullets), Question (the one thing you need to know). Keep each line short. Anything else (a greeting, a quick question) gets a plain answer of one to three sentences.',
    examples: ['Goal: launch the shop page by Friday.\nSteps:\n1. Agree the product list\n2. Write the text\n3. Take photos\n4. Build the page\n5. Test on a phone\nRisks:\n- Photos arrive late\n- Text changes after build\nQuestion: who signs it off?'],
    likesMoe: true,
    audition: [
      { ask: 'We want to move our small office to a new building next month.', checks: [{ label: 'numbered steps', pass: hasList }, { label: 'listed risks', pass: a => /risk/i.test(a) }, { label: 'asked a question', pass: question }] },
      { ask: 'Plan a birthday party for 20 people on Saturday.', checks: [{ label: 'numbered steps', pass: hasList }, { label: 'kept it short', pass: a => words(a) <= 220 }] },
      { ask: 'Things are going badly.', checks: [{ label: 'asked what is wrong', pass: question }, { label: 'did not ramble', pass: a => words(a) <= 120 }] },
    ],
  },
  {
    id: 'designer',
    name: 'Graphic designer',
    hint: 'Icons, logos and flat graphics: simple shapes, plain background, cut out ready to use. Works in the Images window.',
    kind: 'image',
    prompt: 'You make clean graphics: icons, logos, badges, flat illustrations.',
    examples: [],
    audition: [],
    recipe: { mode: 'icon', boost: 'flat vector graphic, clean shapes, limited palette, centred', negative: 'photo, realistic, text, letters, watermark, busy background, gradient noise', drafts: 1 },
    pictures: [{ ask: 'a red bicycle icon' }, { ask: 'a coffee cup logo' }, { ask: 'a house badge with a green roof' }],
  },
  {
    id: 'artist',
    name: 'Artist',
    hint: 'Illustrations and scenes with mood and detail, a few drafts to choose from. Works in the Images window.',
    kind: 'image',
    prompt: 'You make illustrations and scenes with a clear subject, mood and composition.',
    examples: [],
    audition: [],
    recipe: { boost: 'detailed illustration, rich colour, strong composition, soft lighting', negative: 'blurry, lowres, deformed, watermark, text, signature', drafts: 2 },
    pictures: [{ ask: 'a lighthouse on a cliff at dusk' }, { ask: 'a market street after rain' }, { ask: 'a fox sleeping under a tree' }],
  },
];

/** Every level a hire can have: Default first, then the sizes (Hire staff starts at the size of the model picked). */
export const LEVEL_CHOICES: Level[] = [DEFAULT_LEVEL, ...LEVELS];
export const levelOf = (id: unknown): Level => LEVEL_CHOICES.find(l => l.id === id) ?? DEFAULT_LEVEL;
/**
 * Hire roles taken away, and the role a hire who had one works as now: "other" and the receptionist became Default, the
 * model as it is.
 */
const RETIRED: Record<string, string> = { other: 'default', receptionist: 'default' };
/** An id this version does not know (a job step's own name for its kind) works as a coder, as before Default came first. */
export const roleOf = (id: unknown): Role => ROLES.find(r => r.id === (RETIRED[String(id)] ?? id)) ?? ROLES.find(r => r.id === 'coder')!;
/** The role a retired one became ("receptionist" -> "default"), or undefined for a role this version still has. */
export const retiredAs = (id: string): string | undefined => RETIRED[id];
/**
 * A hire with the Default role is sent as a plain chat window would send them: no instructions, no notebooks, and the
 * model's own sampling (only Qwen's thinking stays off, see engine.ts plainStyle).
 */
export const isPlain = (m: { role?: unknown } | null | undefined): boolean => !!m && roleOf(m.role).id === 'default';
/** Whether a picture role suits a kind of picture: one whose way of working fixes another kind (the designer's icons) does not. */
export const drawsFor = (id: unknown, mode: string): boolean => {
  const r = roleOf(id);
  return !!r.kind && (!r.recipe?.mode || r.recipe.mode === mode);
};

/** What a picture level means: the size of the picture model on disk, and which models to look at. Suggestions only. */
export const IMAGE_TIERS: Record<string, { maxGB: number; size: string; suggest: string }> = {
  default: { maxGB: 100000, size: 'any size', suggest: 'Any picture model you have: Default suggests no size.' },
  junior: { maxGB: 3.5, size: 'about 2 GB', suggest: 'A small Stable Diffusion 1.5 model (about 2 GB), for example DreamShaper 8 or Realistic Vision. Draws in a minute or two on a CPU.' },
  experienced: { maxGB: 8, size: '4 to 7 GB', suggest: 'An SDXL-class model (4 to 7 GB), for example Juggernaut XL or RealVisXL. Sharper, wants a graphics card or patience. Not in the Models list yet.' },
  expert: { maxGB: 20, size: '8 to 20 GB', suggest: 'A large modern model (8 to 20 GB), for example Qwen-Image 2.1. Best pictures and readable text; wants an NVIDIA card with 4+ GB or a lot of patience.' },
  senior: { maxGB: 100000, size: '20 GB and up', suggest: 'The biggest picture models (20 GB and up, for example Flux-class). Needs a big card or a linked machine.' },
};

export interface StaffMember {
  id: string;
  name: string;
  role: string;
  level: string;
  /** Their preferred brain: a model id on this PC, or "remote:<paired PC id>" for the model that PC has loaded (brains.ts). */
  model?: string | null;
  /** The brain used when the preferred one cannot answer now (same form). */
  fallback?: string | null;
  /** Picture hires: the style asked for when the words name none ("cartoon", "photo", "icon"; brains.ts). */
  style?: string | null;
  /** Related models on this PC this hire may also use (a designer with an icon model and a logo model). The default is `model`. */
  group?: string[];
  /** The model Wake up loaded for this hire (one of `model` + `group`); null = the default. */
  active?: string | null;
  /** Retired in 2.0.31 (linked PCs no longer get this PC's staff): kept in old files, read by nothing. */
  shared?: boolean;
  /** A backup picked while their own brains could not answer ("Backup when a PC is off"): once, or until the first choice answers again. */
  cover?: { ref: string; once?: boolean } | null;
  /** Their tone for a letter, article or post (an id from persona.ts TONES), set in their profile. Unset: the tone chosen
   * for the host (Settings.tone), as before tones were per person. */
  tone?: string | null;
  /** How they are drawn (src/look.ts): their round picture when they have no photo, and the person in the office game. */
  look?: Look | null;
}

/** Every model a hire may use on this PC, the default first: `model` and the group, without blanks, repeats or other PCs. */
export function modelsOf(m: { model?: string | null; group?: string[] }): string[] {
  return [...new Set([m.model, ...(m.group ?? [])].filter((x): x is string => typeof x === 'string' && !!x && !x.startsWith('remote:')))];
}

/** The model a hire runs on now: the one a paired PC switched them to (while it is still in their list), else the default. */
export function nowModel(m: { model?: string | null; group?: string[]; active?: string | null }): string | null {
  const list = modelsOf(m);
  return m.active && list.includes(m.active) ? m.active : m.model && !m.model.startsWith('remote:') ? m.model : null;
}

/**
 * Every hire's first lines. Said as what to do, not what not to say: naming a habit to avoid makes small models do it
 * (the old line listed "scanning, installing" and "/image", and answers came back with notes repeating it). Code goes
 * in a block with its file name above, because the block's Save button puts it on the drive (app.js codeSave).
 */
const BASE = 'You are {name}, a member of the person\'s team, running entirely on their own computer. If you are not sure of a fact, say so. You work through this chat: when asked for code or a file, write it out in full in a code block, with its file name on the line above, and the person saves it to their drive with the Save button on the block. Answer what was asked and stop; about yourself, say only what the person asks. If asked for a picture, say the team\'s artist draws it in the Images window.';

/**
 * The system prompt for one hire: who they are, the role, the level's way of working, then examples (and a writing tone).
 * A Default hire gets none of it (an empty string); a Default level only leaves out its line.
 */
export function staffSystem(member: StaffMember, tone = ''): string {
  if (isPlain(member)) return '';
  const role = roleOf(member.role);
  const level = levelOf(member.level);
  const lines = [BASE.replace('{name}', member.name), `Your job: ${role.name.toLowerCase()}. ${role.prompt}`, ...(level.style ? [level.style] : []), ...(role.examples.length ? [`Examples of how you sound (they show the style only; never repeat their content):\n${role.examples.map(e => `- ${e}`).join('\n')}`] : [])];
  if (tone) lines.push(`When asked to write a letter, article, post or message, ${tone[0].toLowerCase()}${tone.slice(1)}`);
  return lines.join('\n\n');
}

/** Billions of parameters from a model's name ("qwen3-1.7b", "Qwen3-30B-A3B", "gemma-3-12b-it"), or null. */
export function paramsB(name: string): number | null {
  const m = [...name.replace(/[_-]a\d+(?:\.\d+)?b/gi, ' ').matchAll(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*b(?![a-z])/gi)];
  return m.length ? Number(m[m.length - 1][1]) : null;
}

/** True for a mixture-of-experts model, from its name ("30b-a3b", "moe"). */
export const isMoe = (name: string): boolean => /[_-]a\d+(?:\.\d+)?b|\bmoe\b/i.test(name);

/** The model's size in billions: from its name, else about 0.6 GB a billion (a Q4 file). */
export function sizeB(name: string, bytes: number): number {
  return paramsB(name) ?? Math.round((bytes / 2 ** 30 / 0.6) * 10) / 10;
}

/** The level a model's size belongs to. */
export function levelOfSize(b: number): Level {
  return LEVELS.find(l => b <= l.maxB) ?? LEVELS[LEVELS.length - 1];
}

export interface Match {
  /** How the model sits against the hire's level: 'match', 'above' (bigger than the level), 'below', or 'any' (Default level). */
  against: 'match' | 'above' | 'below' | 'any';
  sizeB: number;
  moe: boolean;
  /** 0 to 3: how well it suggests itself (the level, plus a MoE for a role that likes one). Only ordering; never a limit. */
  rank: number;
}

export function matchModel(member: StaffMember, model: { name: string; bytes: number }): Match {
  const b = sizeB(model.name, model.bytes);
  const moe = isMoe(model.name);
  if (levelOf(member.level).id === DEFAULT_LEVEL.id) return { against: 'any', sizeB: b, moe, rank: 2 + (roleOf(member.role).likesMoe && moe ? 1 : 0) };
  const want = LEVELS.findIndex(l => l.id === levelOf(member.level).id);
  const have = LEVELS.findIndex(l => l.id === levelOfSize(b).id);
  const against = have === want ? 'match' : have > want ? 'above' : 'below';
  const rank = (against === 'match' ? 2 : against === 'above' ? 1 : 0) + (roleOf(member.role).likesMoe && moe ? 1 : 0);
  return { against, sizeB: b, moe, rank };
}

/** Where a picture model sits against an image hire's level, from its size on disk. Only ordering; never a limit. */
export function matchImageModel(member: StaffMember, bytes: number): Match {
  const gb = bytes / 2 ** 30;
  if (levelOf(member.level).id === DEFAULT_LEVEL.id) return { against: 'any', sizeB: Math.round(gb * 10) / 10, moe: false, rank: 2 };
  const ids = LEVELS.map(l => l.id);
  const have = ids.findIndex(id => gb <= IMAGE_TIERS[id].maxGB);
  const want = ids.indexOf(levelOf(member.level).id);
  const against = have === want ? 'match' : have > want ? 'above' : 'below';
  return { against, sizeB: Math.round(gb * 10) / 10, moe: false, rank: against === 'match' ? 2 : against === 'above' ? 1 : 0 };
}

/** Takes the "As an AI language model," habit out of an answer; leaves everything else as it was. */
export function cleanAnswer(text: string): string {
  return text
    // A paragraph that starts "Note: As an AI ..." (a disclaimer added to the answer) goes whole; it is never the answer.
    .replace(/(^|\n|(?<=[.!?]))[ \t]*[(*_]*note[*_]*:[*_]*\s*(?:as an ai\b|i am an ai\b|i'm an ai\b)[^\n]*(?:\n(?![ \t]*\n)[^\n]*)*/gi, '$1')
    .replace(/(^|\n)\s*(?:as an ai(?: language model)?|as a language model|i am just an ai|i'm just an ai)[^.!?\n]*[.!?]\s*/gi, '$1')
    .replace(/\s+$/, '');
}

export interface AuditionResult {
  ask: string;
  answer: string;
  seconds: number;
  checks: Array<{ label: string; pass: boolean }>;
  /** Image roles: the picture drawn for this job (gallery path), for the person to judge. */
  picture?: string;
}

/** The checks that apply to every role: something was said, it finished, and it did not announce it is an AI. */
const COMMON: Check[] = [
  { label: 'answered', pass: a => a.trim().length > 0 },
  { label: 'finished its answer', pass: a => /[.!?)`\]}:]\s*$/.test(a.trim()) || /\n\s*(?:[-*]|\d+[.)])\s+.+$/.test(a.trim()) },
  { label: 'stayed in role', pass: a => !/as an ai|language model/i.test(a) },
];

export function runChecks(role: Role, index: number, answer: string): AuditionResult['checks'] {
  const test = role.audition[index];
  return [...COMMON, ...test.checks].map(c => ({ label: c.label, pass: c.pass(answer) }));
}

export interface Audition {
  model: string;
  at: string;
  score: number;
  of: number;
  seconds: number;
  results: AuditionResult[];
}

interface File {
  staff: StaffMember[];
  /** Ids of people who left: never given to a new hire, so nobody inherits their chats, notebook or photo. */
  gone?: string[];
  /** Last audition per "role:model". */
  auditions: Record<string, Audition>;
}

/** The roster, saved in the data folder as staff.json. Kept in memory, written whole through a temporary file. */
export class Staff {
  private file: File = { staff: [], auditions: {} };
  private dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async load(dir: string): Promise<Staff> {
    const s = new Staff(dir);
    // Not there yet: no roster. Damaged: set aside and reported (src/atomic.ts), never saved over.
    const f = await readData<Partial<File> | null>(join(dir, 'staff.json'), null);
    if (f && typeof f === 'object') {
      s.file = { ...f, staff: Array.isArray(f.staff) ? f.staff.filter(m => m && typeof m.id === 'string').map(m => (RETIRED[m.role] ? { ...m, role: RETIRED[m.role] } : m)) : [], auditions: f.auditions ?? {}, gone: Array.isArray(f.gone) ? f.gone.filter(x => typeof x === 'string') : [] };
    }
    return s;
  }

  // A save that fails (a full disk) has already changed the roster in memory: it is read back from the file before the
  // fault is passed on, so a refused hire, change or firing never shows as done (and comes undone at the next start).
  private async save(): Promise<void> {
    try {
      await writeAtomic(join(this.dir, 'staff.json'), JSON.stringify(this.file, null, 1));
    } catch (e) {
      this.file = (await Staff.load(this.dir).catch(() => null))?.file ?? this.file;
      throw e;
    }
  }

  list(): StaffMember[] {
    return this.file.staff;
  }

  get(id: string): StaffMember | undefined {
    return this.file.staff.find(m => m.id === id);
  }

  auditions(): Record<string, Audition> {
    return this.file.auditions;
  }

  /**
   * `taken`: whether an id still has something on disk (chats, a notebook) from someone who left before leavers were
   * listed; such an id is not given out either.
   */
  async hire(name: unknown, role: unknown, level: unknown, model?: unknown, taken: (id: string) => boolean = () => false, look?: unknown): Promise<StaffMember> {
    const clean = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
    if (!clean) throw new Error('Give them a name first.');
    const base = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'staff';
    let id = base;
    for (let n = 2; this.get(id) || this.file.gone?.includes(id) || taken(id); n++) id = `${base}-${n}`;
    const m: StaffMember = { id, name: clean, role: roleOf(role).id, level: levelOf(level).id, model: typeof model === 'string' && model ? model : null };
    const drawn = cleanLook(look);
    if (drawn) m.look = drawn;
    this.file.staff.push(m);
    await this.save();
    return m;
  }

  async change(id: string, change: { name?: unknown; role?: unknown; level?: unknown; model?: unknown; fallback?: unknown; style?: unknown; group?: unknown; active?: unknown; cover?: unknown; tone?: unknown; look?: unknown }): Promise<StaffMember | null> {
    const m = this.get(id);
    if (!m) return null;
    if (typeof change.name === 'string' && change.name.trim()) m.name = change.name.trim().replace(/\s+/g, ' ').slice(0, 30);
    if (change.role !== undefined) m.role = roleOf(change.role).id;
    if (change.level !== undefined) m.level = levelOf(change.level).id;
    if (change.model !== undefined) m.model = typeof change.model === 'string' && change.model ? change.model : null;
    if (change.fallback !== undefined) m.fallback = typeof change.fallback === 'string' && change.fallback ? change.fallback : null;
    if (change.style !== undefined) m.style = change.style === 'cartoon' || change.style === 'photo' || change.style === 'icon' ? change.style : null;
    if (change.group !== undefined) m.group = Array.isArray(change.group) ? [...new Set(change.group.filter((x): x is string => typeof x === 'string' && !!x && !x.startsWith('remote:')))].slice(0, 12) : [];
    if (change.active !== undefined) m.active = typeof change.active === 'string' && change.active ? change.active : null;
    if (change.tone !== undefined) m.tone = TONES.some(t => t.id === change.tone) ? (change.tone as string) : null;
    if (change.look !== undefined) m.look = cleanLook(change.look);
    if (change.cover !== undefined) {
      const c = (change.cover && typeof change.cover === 'object' ? change.cover : {}) as { ref?: unknown; once?: unknown };
      m.cover = typeof c.ref === 'string' && c.ref ? { ref: c.ref, ...(c.once === true ? { once: true } : {}) } : null;
    }
    // A fallback the same as the preferred one is no fallback; the default is never also in the group; a switch to a
    // model no longer in the list is dropped.
    if (m.fallback && m.fallback === m.model) m.fallback = null;
    if (m.cover && (m.cover.ref === m.model || m.cover.ref === m.fallback)) m.cover = null;
    if (m.group) m.group = m.group.filter(x => x !== m.model);
    if (m.active && (m.active === m.model || !modelsOf(m).includes(m.active))) m.active = null;
    await this.save();
    return m;
  }

  async fire(id: string): Promise<boolean> {
    const before = this.file.staff.length;
    this.file.staff = this.file.staff.filter(m => m.id !== id);
    if (this.file.staff.length === before) return false;
    this.file.gone = [...new Set([...(this.file.gone ?? []), id])];
    await this.save();
    return true;
  }

  async recordAudition(role: string, a: Audition): Promise<void> {
    this.file.auditions[`${role}:${a.model}`] = a;
    await this.save();
  }
}
