// Jobs: a goal split into small steps by a project manager, each step done by a worker, with the plan kept on disk. The
// plan file and the workspace files are the memory, not the chat, so a long job never depends on one long conversation.
// This file holds the plain functions (plan format, prompts, reading a worker's answer); the plain functions are tested in
// test/jobs.test.ts. Nothing here runs code or touches the disk: the server saves the plan as jobs/<id>/plan.json.
import { keptFromModels, RESERVED, SPECIALISTS, stamp } from './folders.ts';
import { cleanPath } from './workspace.ts';

export const ROLE_IDS = ['coder', 'writer', 'artist', 'designer'] as const;
/** Steps the planner may make; the person (and "fix the failing tests") may add more, up to MAX_STEPS. */
export const PLAN_STEPS = 8;
export const MAX_STEPS = 12;
export const MAX_STEP_FILES = 4;
/** What a model with an 8,192-token context can take in one step: the files a step reads must fit this. */
export const MAX_INPUT_CHARS = 8000;

/** The most a job step's answer may take, in tokens, however big the context (PLAN F10 G2). */
export const STEP_CEILING = 32768;

/**
 * Room in a context of `ctx` tokens: the answer (whole files, or edit blocks for a long one) in tokens, and the files
 * read in, in characters (about 2.2 characters a token for code, on the safe side), after the instructions and the
 * notes. From 16K up the answer is a third of the context (6,000 at least, 32,768 at most), so a bigger context buys a
 * bigger step: 16K reads about 19,500 characters of files, 64K about 92,800.
 */
export function budget(ctx: number, front = 0): { answer: number; input: number } {
  const answer = ctx >= 16384 ? Math.max(6000, Math.min(STEP_CEILING, Math.floor(ctx / 3))) : ctx >= 8192 ? 3000 : 1500;
  // `front`: the characters of the packet's front (Scope card, design brief, notebooks), about 3 characters a token.
  return { answer, input: Math.max(2000, Math.round((ctx - answer - 1500 - Math.ceil(front / 3)) * 2.2)) };
}
const MAX_NOTES = 1600;

export type StepStatus = 'todo' | 'done' | 'skipped';

export interface Step {
  title: string;
  role: string;
  /** The files this step may read and change (workspace paths). It may not touch any other. */
  files: string[];
  brief: string;
  /** What to look at to know the step worked (shown to the person; nothing is run). */
  check: string;
  status: StepStatus;
  /** Two or three lines about what was done, kept for the later steps. */
  summary: string;
  wrote: string[];
}

export interface Job {
  id: string;
  goal: string;
  created: string;
  updated: string;
  /** Decisions so far, one line per finished step: the only thing later steps are told besides their own brief and files. */
  notes: string;
  steps: Step[];
  /** The last test run the person started (output kept short). */
  tests?: { label: string; ok: boolean; at: string; output: string; seconds: number };
  /** Hidden from the lists (Jobs, Home); its folder and files stay, and it can be shown again. */
  hidden?: boolean;
  /** The project's name (Home, "Lets create a project"); older jobs have none and show their goal. */
  name?: string;
  /** The project folder inside the workspace that the steps' files are in; '' (or none) = the workspace itself. */
  folder?: string;
  /** Who does what on this job; none = every seat on its default. */
  team?: Team;
}

/**
 * Who does what on one job. `pm` plans: '' = the strongest worker available, else a hire's id. Coder, writer and
 * auditing: 'default' (a hire in that role, else the project manager; auditing: the strongest worker), 'none' (not
 * assigned: the project manager does the coder's or the writer's steps; nobody audits), or a hire's id. `expect`: what
 * the person expects of the final audit, given to the auditor with the end-of-job report.
 */
export interface Team { pm: string; coder: string; writer: string; audit: string; expect: string }
export const TEAM_DEFAULT: Team = { pm: '', coder: 'default', writer: 'default', audit: 'default', expect: '' };
export const SEATS = ['coder', 'writer', 'audit'] as const;

/** A team from loose fields: only known hire ids (from `hires`), the three seat words, and one short line of expectations. */
export function cleanTeam(raw: unknown, hires: string[], base: Team = TEAM_DEFAULT): Team {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Team = { ...TEAM_DEFAULT, ...base };
  if ('pm' in r) out.pm = typeof r.pm === 'string' && hires.includes(r.pm) ? r.pm : '';
  for (const k of SEATS) {
    if (!(k in r)) continue;
    const v = String(r[k] ?? '');
    out[k] = v === 'none' || hires.includes(v) ? v : 'default';
  }
  if ('expect' in r) out.expect = String(r.expect ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  // A hire who left the team is no longer picked: the seat goes back to its default.
  if (out.pm && !hires.includes(out.pm)) out.pm = '';
  for (const k of SEATS) if (out[k] !== 'default' && out[k] !== 'none' && !hires.includes(out[k])) out[k] = 'default';
  return out;
}

/** A project folder inside the workspace, as typed: plain names joined by "/", or null when it cannot be one. */
export function cleanProjectFolder(input: unknown): string | null {
  const raw = String(input ?? '').replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  if (!raw || raw.length > 120 || /[\0<>:"|?*]/.test(raw)) return null;
  const parts = raw.split('/').map(p => p.trim());
  if (parts.length > 3 || parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.') || /[ .]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(p))) return null;
  // jobs\ holds every project's plan; chats\ and notes\ hold quick chats and notes (src/folders.ts).
  if (parts[0].toLowerCase() === 'jobs' || parts[0] === 'node_modules' || RESERVED.includes(parts[0].toLowerCase())) return null;
  return parts.join('/');
}

/** The default project folder: the date and time, "2026-10-07-1116" (src/folders.ts). */
export const folderStamp = stamp;

const oneLine = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function jobId(now = new Date(), rand = Math.random()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const t = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `${t}-${Math.floor(rand * 0x10000).toString(16).padStart(4, '0')}`;
}

export const validId = (id: unknown): id is string => typeof id === 'string' && /^\d{8}-\d{4}-[0-9a-f]{4}$/.test(id);

export const planPath = (id: string) => `jobs/${id}/plan.json`;

/**
 * Whether a path's own name reads like a file name, not a sentence: a small model sometimes puts its picture prompt or
 * its brief in FILES ("A cosy cafe table with two cups at golden hour.md"). Names the app makes itself (the date and
 * time, then up to 40 characters of first words: src/folders.ts) always pass.
 */
export function looksLikeFileName(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const base = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  if (base.length > 60) return false;
  return /^\d{4}-\d{2}-\d{2}-\d{4}(-\d+)? /.test(base) || base.split(/\s+/).length <= 5;
}

/** A list of workspace paths from "a.js, b.css" or an array: only plain relative text files, no repeats, at most four. */
export function cleanFiles(input: unknown): string[] {
  const raw = Array.isArray(input) ? input.map(String) : String(input ?? '').split(/[,;\n]/);
  const out: string[] = [];
  for (const r of raw) {
    const p = cleanPath(r.replace(/^[`'"\s-]+|[`'"\s]+$/g, ''));
    if (p && looksLikeFileName(p) && !p.startsWith('jobs/') && !keptFromModels(p) && !out.includes(p)) out.push(p);
  }
  return out.slice(0, MAX_STEP_FILES);
}

/** A file name written in prose: "app.js", "src/app.js", "`notes.md`". */
const FILE_WORD = /[\w./-]*\w\.(?:md|txt|html?|css|m?js|jsx|tsx?|json|csv|xml|ya?ml|py|php|sql|toml)\b/gi;

const CODE_EXT =/\.(js|mjs|ts|tsx|jsx|py|php|sql|css|html?|json|ya?ml|toml)$/i;

/** A role id from the model's word ("Coder", "developer", "copywriter"); a guess from the files when it is unclear. */
export function cleanRole(word: unknown, files: string[]): string {
  const w = String(word ?? '').toLowerCase();
  if (/design|icon|logo/.test(w)) return 'designer';
  if (/artist|illustrat|picture|image/.test(w)) return 'artist';
  if (/writ|copy|text|blog|edit/.test(w)) return 'writer';
  if (/cod|dev|program|engineer/.test(w)) return 'coder';
  return files.some(f => CODE_EXT.test(f)) ? 'coder' : 'writer';
}

/** One step from loose fields (the model's, or the person's edit): limits applied, status and summary left to the caller. */
export function cleanStep(raw: Record<string, unknown>): Step | null {
  const title = oneLine(raw.title, 100);
  if (!title) return null;
  const brief = String(raw.brief ?? '').replace(/\r/g, '').trim().slice(0, 1600) || title;
  let role = ROLE_IDS.includes(String(raw.role) as never) ? String(raw.role) : cleanRole(raw.role, cleanFiles(raw.files));
  // A model often leaves FILES empty and names the file in the brief ("In app.js, write ..."): take it from there.
  let files = cleanFiles(raw.files);
  if (!files.length && role !== 'artist' && role !== 'designer') files = cleanFiles(`${title} ${brief}`.match(FILE_WORD) ?? []);
  // A step with files to write is text or code, never a picture (a model calls CSS work "designer").
  if (files.length && (role === 'artist' || role === 'designer')) role = cleanRole('', files);
  return {
    title,
    role,
    files,
    brief,
    check: oneLine(raw.check, 200),
    status: 'todo',
    summary: '',
    wrote: [],
  };
}

/** What the project manager is told. A fixed line format, because small models keep to lines better than to JSON. */
export function planSystem(existing: string[], workers = '', handed: string[] = []): string {
  return [
    'You are a project manager. You plan; you do not do the work. Split the goal into small steps that one worker can finish in one go: one file or one function per step, at most ' + PLAN_STEPS + ' steps.',
    'Answer with the steps only, in exactly this form, one block per step, no other text:',
    'STEP: short title\nROLE: coder or writer or artist or designer\nFILES: file names this step reads or changes, separated by commas (workspace paths such as src/app.js or blog/post.md; leave empty for a picture)\nBRIEF: what the worker must do, in two or three plain sentences, with every detail the worker needs, because the worker sees only this brief and those files\nCHECK: what a person can look at to know the step worked',
    'A file too long to write out whole is changed with find-and-replace blocks, so a step may name a long file; keep each step to one change in it.',
    'Order the steps so each one only needs what earlier steps made. Name the files in the plan so later steps can find them. When two steps must agree on a name (an element id, a function, a heading), write that exact name into both briefs, because a worker never sees the other worker\'s file. Use coder for code, writer for text, artist for a picture or scene, designer for an icon or logo.',
    existing.length ? `Files already in the workspace (you may plan to change them): ${existing.slice(0, 40).join(', ')}.` : 'The workspace has no files yet.',
    `Text the writer writes for people to read (chapters, articles, copy) is handed in under ${SPECIALISTS}/writer/, each file name starting with the date and time; pictures from the artist or designer go under ${SPECIALISTS}/images/.`,
    handed.length ? `Work the specialists have handed in, newest first (read these for what is done; the newest of each folder is the current one): ${handed.join(', ')}.` : '',
    workers,
  ].filter(Boolean).join('\n\n');
}

/** Words that say a picture is wanted but not what is in it ("Picture", "Draw the logo"). */
const PICTURE_WORDS = /^(a|an|the|of|for|and|to|it|draw|make|create|add|picture|pictures|pic|image|images|img|illustration|drawing|art|artwork|photo|icon|logo|hero|header|banner|cover|step|\d+)$/i;
/** Whether a picture step says what to draw: at least two words beyond "draw the picture". */
export const picturePromptOk = (prompt: string) => prompt.split(/[^\p{L}\p{N}]+/u).filter(w => w && !PICTURE_WORDS.test(w)).length >= 2;

/**
 * The steps from the manager's answer. Takes "STEP:" blocks; falls back to a numbered list. Empty when there is nothing
 * usable. A picture step that does not say what to draw (no brief, or only "draw the picture") is left out.
 */
export function parsePlan(text: string): Step[] {
  const clean = text.replace(/\r/g, '').replace(/\*\*/g, '');
  const blocks = clean.split(/^\s*(?:#+\s*)?STEP\s*\d*\s*:/im).slice(1);
  const steps: Step[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const raw: Record<string, string> = { title: lines[0] };
    let key = 'title';
    for (const line of lines.slice(1)) {
      const m = /^\s*(ROLE|FILES?|BRIEF|CHECK)\s*:\s*(.*)$/i.exec(line);
      if (m) {
        key = m[1].toLowerCase().replace(/^file$/, 'files');
        raw[key] = m[2];
      } else if (key !== 'title' && line.trim()) raw[key] = `${raw[key] ?? ''} ${line.trim()}`;
    }
    const step = cleanStep(raw);
    const picture = step && !step.files.length && (step.role === 'artist' || step.role === 'designer');
    if (step && !(picture && !picturePromptOk(`${step.title} ${step.brief}`))) steps.push(step);
  }
  if (!steps.length) {
    for (const m of clean.matchAll(/^\s*\d+[.)]\s+(.{4,})$/gm)) {
      const step = cleanStep({ title: m[1].replace(/\s+[-–:].*$/, '') || m[1], brief: m[1] });
      if (step) steps.push(step);
    }
  }
  return steps.slice(0, PLAN_STEPS);
}

/** Records a finished step in the job's notes, keeping the newest lines when it grows past the limit. */
export function addNote(notes: string, n: number, title: string, summary: string, facts: string[] = []): string {
  // A file's names are listed once, as they are now: an older list for the same file is dropped.
  const paths = facts.filter(Boolean).map(f => `  ${f.slice(0, f.indexOf(':') + 1)}`);
  const lines = [...dropNote(notes, n).split('\n').filter(l => l && !paths.some(p => l.startsWith(p))), `Step ${n} (${title}): ${oneLine(summary, 300) || 'done.'}`, ...facts.filter(Boolean).map(f => `  ${oneLine(f, 400)}`)];
  while (lines.join('\n').length > MAX_NOTES && lines.length > 1) lines.shift();
  return lines.join('\n');
}

/** Takes a step's own line out of the notes (the step is to be done again); the names read from its files stay, as the files do. */
export const dropNote = (notes: string, n: number) => notes.split('\n').filter(l => !l.startsWith(`Step ${n} (`)).join('\n');

/**
 * The names other files must use, read from a saved file by code (not by the model, which forgets to mention them):
 * element ids in HTML, functions and top-level names in JavaScript/TypeScript/Python/PHP, class selectors in CSS.
 * Empty when there is nothing to name.
 */
const uniq = (xs: Iterable<string>, max = 1000) => [...new Set(xs)].slice(0, max);
const extOf = (path: string) => path.slice(path.lastIndexOf('.')).toLowerCase();
const isHtml = (p: string) => /^\.html?$/.test(extOf(p));
/** tip.test.mjs, test_tip.py, tests/x.js, x.spec.ts */
const isTestFile = (p: string) => /(^|[/._-])(test|tests|spec)([/._-]|$)/i.test(p);
const isScript = (p: string) => /^\.(m?js|jsx|tsx?)$/.test(extOf(p));
/** Element ids a page defines. */
const idsIn = (html: string) => uniq([...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]));
/** Local scripts and style sheets a page loads. */
const loadsIn = (html: string) => uniq([...html.matchAll(/\b(?:src|href)\s*=\s*["'](?!\w+:|\/\/)([^"'?#]+\.(?:m?js|css))["']/gi)].map(m => m[1].replace(/^\.\//, '')));
/** Element ids a script looks up. */
const idsUsedIn = (js: string) => uniq([...js.matchAll(/getElementById\(\s*["']([^"']+)["']|querySelector(?:All)?\(\s*["']#([\w-]+)["']/g)].map(m => m[1] ?? m[2]));

export function factsOf(path: string, text: string): string {
  const ext = extOf(path);
  const parts: string[] = [];
  if (isHtml(path)) {
    const ids = idsIn(text).slice(0, 20);
    if (ids.length) parts.push(`ids ${ids.join(', ')}`);
    const links = loadsIn(text).slice(0, 12);
    if (links.length) parts.push(`loads ${links.join(', ')}`);
  } else if (isScript(path)) {
    const names = uniq([...text.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var|class)\s+([A-Za-z_$][\w$]*))/gm)].map(m => m[1] ?? m[2]), 12);
    if (names.length) parts.push(`defines ${names.join(', ')}`);
    const ids = idsUsedIn(text).slice(0, 12);
    if (ids.length) parts.push(`uses ids ${ids.join(', ')}`);
  } else if (ext === '.py') {
    const names = uniq([...text.matchAll(/^(?:async\s+)?(?:def|class)\s+(\w+)/gm)].map(m => m[1]));
    if (names.length) parts.push(`defines ${names.join(', ')}`);
  } else if (ext === '.php') {
    const names = uniq([...text.matchAll(/^\s*(?:function|class)\s+(\w+)/gm)].map(m => m[1]));
    if (names.length) parts.push(`defines ${names.join(', ')}`);
  } else if (ext === '.css') {
    const sel = uniq([...text.matchAll(/([#.][A-Za-z_][\w-]*)(?=[^{}]*\{)/g)].map(m => m[1]), 16);
    if (sel.length) parts.push(`styles ${sel.join(', ')}`);
  }
  return parts.length ? `${path}: ${parts.join('; ')}` : '';
}

/**
 * Plain checks across the web files of the workspace as they would be after saving (no model, nothing run): a script
 * looking up an id no page has, a style rule for an id no page has, and a script or style sheet no page loads.
 * Only looks when there is at least one page. Paths are relative to the workspace.
 */
export function crossCheck(files: Record<string, string>): string[] {
  const pages = Object.keys(files).filter(isHtml);
  if (!pages.length) return [];
  const ids = new Set(pages.flatMap(p => idsIn(files[p])));
  const loaded = new Set(pages.flatMap(p => {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
    return loadsIn(files[p]).map(l => (l.startsWith('/') ? l.slice(1) : dir + l));
  }));
  const out: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (isScript(path)) {
      const missing = idsUsedIn(text).filter(id => !ids.has(id));
      if (missing.length) out.push(`${path} looks up ${missing.map(id => `"${id}"`).join(', ')}, but no page has an element with ${missing.length > 1 ? 'those ids' : 'that id'}.`);
    }
    if (extOf(path) === '.css') {
      const missing = uniq([...text.matchAll(/#([A-Za-z_][\w-]*)(?=[^{}]*\{)/g)].map(m => m[1])).filter(id => !ids.has(id));
      if (missing.length) out.push(`${path} styles ${missing.map(id => `#${id}`).join(', ')}, but no page has ${missing.length > 1 ? 'those ids' : 'that id'}.`);
    }
    // Only beside a page: a script elsewhere may be a server file or a module another script imports.
    const besidePage = pages.some(p => p.slice(0, p.lastIndexOf('/') + 1) === path.slice(0, path.lastIndexOf('/') + 1));
    if (besidePage && !isTestFile(path) && (/\.m?js$/.test(path) || extOf(path) === '.css') && !loaded.has(path) && !Object.values(files).some(t => t.includes(`/${path.split('/').pop()}'`) || t.includes(`/${path.split('/').pop()}"`))) out.push(`${path} is not loaded by any page (${pages.join(', ')}).`);
  }
  return out.slice(0, 12);
}

/** The steps the person edited, merged with the job: finished steps stay as they were, in front; the rest take the edited order. */
export function applyEdit(job: Job, edited: unknown): Step[] | { error: string } {
  if (!Array.isArray(edited)) return { error: 'There are no steps to save.' };
  const kept = job.steps.filter(s => s.status !== 'todo');
  const rest: Step[] = [];
  for (const e of edited.slice(0, MAX_STEPS)) {
    const step = e && typeof e === 'object' ? cleanStep(e as Record<string, unknown>) : null;
    if (step) rest.push(step);
  }
  if (kept.length + rest.length > MAX_STEPS) return { error: `A job has at most ${MAX_STEPS} steps.` };
  return [...kept, ...rest];
}

/** The index of the next step to do, or -1. */
export const nextIndex = (job: Job) => job.steps.findIndex(s => s.status === 'todo');

/**
 * Which of a step's files go back whole and which by edit blocks (PLAN F10 G2): a new file and the shorter files go
 * whole while together they take at most 4/5 of the answer (`answerChars`); a file past that is too long to write out
 * whole, so it is changed with find-and-replace blocks that code checks before anything is saved.
 */
export function editFiles(files: string[], texts: Record<string, string | null>, answerChars: number): string[] {
  let used = 0;
  const out: string[] = [];
  for (const f of [...files].sort((a, b) => (texts[a]?.length ?? 0) - (texts[b]?.length ?? 0))) {
    const n = texts[f]?.length ?? 0;
    if (texts[f] == null || used + n <= answerChars * 0.8) used += n;
    else out.push(f);
  }
  return files.filter(f => out.includes(f));
}

/** The edit block's form, with the real file name in it (a small model copies the form as it is written). */
const editForm = (path: string) => `=== EDIT: ${path} ===\n<<<<<<< SEARCH\n[the exact lines to change, copied from the file]\n=======\n[the same lines, changed]\n>>>>>>> REPLACE\n=== END EDIT ===`;

/** What a worker is told. It sees its brief, its files and the notes, never the whole job. `edit`: files changed by edit blocks. */
export function workerSystem(rolePrompt: string, job: Job, step: Step, n: number, front = '', edit: string[] = []): string {
  const whole = step.files.filter(f => !edit.includes(f));
  return [
    front,
    rolePrompt,
    `You are doing step ${n} of ${job.steps.length} of a job. The overall goal: ${job.goal}`,
    job.notes ? `Done so far:\n${job.notes}` : '',
    step.files.length ? `You may write only these files: ${step.files.join(', ')}.` : '',
    whole.length
      ? `Give ${edit.length ? `${whole.join(', ')}` : 'each file you write'} IN FULL (never a fragment or "the rest is unchanged"), in this form:\n=== FILE: path ===\nthe whole file text\n=== END FILE ===`
      : '',
    edit.length
      ? `${edit.join(', ')} ${edit.length > 1 ? 'are' : 'is'} too long to write out whole: change ${edit.length > 1 ? 'them' : 'it'} with one or more EDIT blocks, in this form (the words in [ ] say what goes there):\n${editForm(edit[0])}\nThe SEARCH lines must be copied from the file exactly (same spaces, same words) and be enough to match one place only, or the change is refused. Several SEARCH/REPLACE pairs may follow one another inside one EDIT; to add new lines, SEARCH for the line they go after and repeat it above the new lines.`
      : '',
    step.files.length
      ? 'Then one last line: SUMMARY: two or three short sentences saying what you did, with the exact names a later step must use (element ids, function names, file names).'
      : 'Answer with what was asked, then one last line: SUMMARY: two or three short sentences saying what you did.',
    'Do not invent facts. If something you need is missing, say so in the SUMMARY.',
  ].filter(Boolean).join('\n\n');
}

/** The names read from files earlier steps saved (the indented lines of the notes). */
export const notedFacts = (notes: string) => notes.split('\n').filter(l => l.startsWith('  ')).map(l => l.trim());

/** The owner's notes from the job room, addressed to this person: they come with the brief and weigh as much. */
export const ownerNote = (notes: string[]) => `Owner's note${notes.length > 1 ? 's' : ''} for this step (follow ${notes.length > 1 ? 'them' : 'it'} as part of the brief):\n${notes.map(n => `- ${n.replace(/\s+/g, ' ').trim()}`).join('\n')}`;

/** The worker's message: the brief, the exact names other files use (next to the brief, where a small model still reads them), and the current text of each file it may change. */
export function workerUser(step: Step, texts: Record<string, string | null>, notes = '', ownerNotes: string[] = [], edit: string[] = []): string {
  const facts = notedFacts(notes).filter(f => !step.files.some(p => f.startsWith(`${p}:`)));
  const parts = [`Your step: ${step.title}\n\n${step.brief}`];
  if (ownerNotes.length) parts.push(ownerNote(ownerNotes));
  if (facts.length) parts.push(`Other files already made. Use exactly these names, do not invent new ones:\n${facts.map(f => `- ${f}`).join('\n')}`);
  for (const f of step.files) parts.push(texts[f] == null ? `File ${f} does not exist yet: create it.` : `Current ${f}${edit.includes(f) ? ' (too long to write out whole: change it with EDIT blocks)' : ''}:\n=== FILE: ${f} ===\n${texts[f]}\n=== END FILE ===`);
  // Last, because a small model follows the last thing it read: it otherwise rewrites the other files too.
  const how = edit.length ? `. Change ${edit.join(' and ')} with EDIT blocks only, never the whole file` : '';
  if (step.files.length) parts.push(`Write only ${step.files.join(' and ')}${facts.length ? '. Do not write any other file: the others are done' : ''}${how}. End with the SUMMARY line.`);
  return parts.join('\n\n');
}

export interface Result {
  files: { path: string; text: string }[];
  summary: string;
  /** Files the worker wrote that the step did not allow (dropped). */
  dropped: string[];
  /** Find-and-replace blocks for long files, in the order given (applied by applyEdits, checked by code). */
  edits?: { path: string; find: string; replace: string }[];
}

/**
 * The EDIT blocks in an answer: "=== EDIT: path ===", then one or more SEARCH (or FIND) / ======= / REPLACE parts, closed by
 * ">>>>>>> REPLACE"; the END EDIT line is optional. Only allowed paths count; the rest are named in `dropped`.
 */
export function parseEdits(answer: string, allowed: string[]): { edits: { path: string; find: string; replace: string }[]; dropped: string[]; rest: string } {
  const text = answer.replace(/\r/g, '');
  const edits: { path: string; find: string; replace: string }[] = [];
  const dropped: string[] = [];
  const head = /^\s*=+\s*EDIT:\s*(.+?)\s*=*\s*$/gm;
  const heads = [...text.matchAll(head)];
  let rest = text;
  heads.forEach((m, k) => {
    const start = m.index! + m[0].length;
    const nextHead = /^\s*=+\s*(?:EDIT|FILE):/m.exec(text.slice(start));
    const stop = k + 1 < heads.length ? heads[k + 1].index! : nextHead ? start + nextHead.index : text.length;
    let chunk = text.slice(start, stop);
    const end = /^\s*=+\s*END(?: EDIT)?\s*=*\s*$/im.exec(chunk);
    if (end) chunk = chunk.slice(0, end.index);
    const path = cleanPath(m[1].replace(/^[`'"\s]+|[`'"\s]+$/g, ''));
    const ok = !!path && allowed.includes(path);
    if (!ok && !dropped.includes(m[1].trim())) dropped.push(m[1].trim());
    for (const b of stripFence(chunk).matchAll(/^<{5,}\s*(?:SEARCH|FIND)\s*\n([\s\S]*?)^={5,}\s*\n([\s\S]*?)^>{5,}\s*REPLACE\s*$/gm)) {
      if (ok) edits.push({ path: path!, find: b[1].replace(/\n$/, ''), replace: b[2].replace(/\n$/, '') });
    }
    rest = rest.replace(text.slice(m.index!, end ? start + end.index + end[0].length : stop), '\n');
  });
  return { edits, dropped, rest };
}

/**
 * The file after its edit blocks, in order, or what is wrong. A SEARCH must match one place only: exactly, else line by
 * line ignoring spaces at the ends of lines. A SEARCH that matches nothing, or more than one place, is refused, and so
 * nothing of that file is changed.
 */
export function applyEdits(path: string, text: string, edits: { find: string; replace: string }[]): { text: string } | { problems: string[] } {
  const problems: string[] = [];
  let out = text.replace(/\r\n/g, '\n');
  edits.forEach((e, k) => {
    const label = `${path}, edit ${k + 1}`;
    if (!e.find.trim()) return void problems.push(`${label}: the SEARCH part is empty. Copy the exact lines to change from the file.`);
    const at = indexesOf(out, e.find);
    if (at.length === 1) return void (out = out.slice(0, at[0]) + e.replace + out.slice(at[0] + e.find.length));
    if (at.length > 1) return void problems.push(`${label}: the SEARCH lines are in ${at.length} places. Copy more lines around the change so they match one place only.`);
    // Spaces at line ends are the usual slip: match line by line without them.
    const lines = out.split('\n');
    const want = e.find.split('\n').map(l => l.trimEnd());
    const hits: number[] = [];
    for (let i = 0; i + want.length <= lines.length; i++) if (want.every((w, j) => lines[i + j].trimEnd() === w)) hits.push(i);
    if (hits.length === 1) {
      lines.splice(hits[0], want.length, ...e.replace.split('\n'));
      return void (out = lines.join('\n'));
    }
    const first = want.find(l => l.trim()) ?? '';
    problems.push(hits.length > 1
      ? `${label}: the SEARCH lines are in ${hits.length} places. Copy more lines around the change so they match one place only.`
      : `${label}: the SEARCH lines are not in ${path} (the first is "${first.trim().slice(0, 80)}"). Copy them exactly from the current file, same spaces and words.`);
  });
  return problems.length ? { problems } : { text: out.endsWith('\n') ? out : `${out}\n` };
}

function indexesOf(text: string, find: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(find); i >= 0 && out.length < 5; i = text.indexOf(find, i + 1)) out.push(i);
  return out;
}

/** The files and summary in a worker's answer. Only the step's own files are accepted. With one allowed file and one code fence, the fence is that file. */
export function parseResult(answer: string, allowed: string[], edit: string[] = []): Result {
  const blocks = edit.length ? parseEdits(answer, edit) : null;
  const text = blocks ? blocks.rest : answer.replace(/\r/g, '');
  const files: Result['files'] = [];
  const dropped: string[] = [];
  const add = (rawPath: string, body: string) => {
    const path = cleanPath(rawPath.replace(/^[`'"\s]+|[`'"\s]+$/g, ''));
    const trimmed = body.replace(/^\n/, '').replace(/\n+$/, '');
    if (path && allowed.includes(path)) {
      if (!files.some(f => f.path === path)) files.push({ path, text: `${trimmed}\n` });
    } else if (!dropped.includes(rawPath.trim())) dropped.push(rawPath.trim());
  };
  // A block runs from its FILE line to its END line; small models sometimes leave the END line out, so the next FILE
  // line, a SUMMARY line or the end of the answer also closes it.
  const head = /^\s*=+\s*FILE:\s*(.+?)\s*=*\s*$/gm;
  const heads = [...text.matchAll(head)];
  let rest = text;
  heads.forEach((m, k) => {
    const start = m.index! + m[0].length;
    const stop = k + 1 < heads.length ? heads[k + 1].index! : text.length;
    const chunk = text.slice(start, stop);
    const end = /^\s*=+\s*END(?: FILE)?\s*=*\s*$|^\s*\**SUMMARY\**\s*:/im.exec(chunk);
    add(m[1], stripFence(end ? chunk.slice(0, end.index) : chunk));
    rest = rest.replace(text.slice(m.index!, end ? start + end.index + (/^\s*=/.test(end[0]) ? end[0].length : 0) : stop), '\n');
  });
  if (!heads.length && allowed.length === 1) {
    const fence = /```[\w+-]*\n([\s\S]*?)```/.exec(text);
    if (fence) {
      add(allowed[0], fence[1]);
      rest = rest.replace(fence[0], '\n');
    }
  }
  // The last SUMMARY: anywhere in a line (a model sometimes echoes "Then one last line: SUMMARY: ...").
  const summaries = [...rest.matchAll(/.*SUMMARY\**\s*:\s*(.*)/gi)];
  const summary = summaries.length ? summaries[summaries.length - 1][1] : rest.replace(/```[\s\S]*?```/g, '');
  return { files, summary: oneLine(summary, 400), dropped: [...dropped, ...(blocks?.dropped ?? [])], ...(blocks ? { edits: blocks.edits } : {}) };
}

/**
 * Files that came back much shorter than they went in (under half, from at least 500 characters): a small model often
 * sends back a fragment of a long file and says it is whole. Saving it would throw the rest away, so it is a failed check.
 */
export function shrunk(before: Record<string, string | null>, after: { path: string; text: string }[]): string[] {
  return after.flatMap(f => {
    const was = before[f.path]?.length ?? 0;
    return was >= 500 && f.text.length < was / 2 ? [`${f.path} came back at ${f.text.length.toLocaleString('en-GB')} characters, from ${was.toLocaleString('en-GB')}: most of the file was left out. Give the WHOLE file, every line, with the change made.`] : [];
  });
}

/** Told to the worker on a retry: what failed, and to give the whole files again. Last in the message, where a small model reads it. */
export function fixMessage(problems: string[], allowed: string[], edit: string[] = []): string {
  const whole = allowed.filter(f => !edit.includes(f));
  const again = [whole.length ? `${whole.length > 1 ? 'the files' : whole[0]} again, whole and fixed, in the same form` : '', edit.length ? `every EDIT block for ${edit.join(' and ')} again, in the "=== EDIT: ${edit[0]} ===" form, with SEARCH lines copied exactly from the file as it was given to you` : ''].filter(Boolean).join(', and ');
  return `Your last answer failed these checks:\n${problems.map(p => `- ${p}`).join('\n')}\n\nGive ${again}, then the SUMMARY line.`;
}

// ---- Who does each step, and how often the model has to change ----

/** The role whose model a step needs: picture steps need none here (they are drawn in the Images window). */
export const workerRole = (step: Step) => (step.role === 'artist' || step.role === 'designer' ? null : step.role === 'writer' ? 'writer' : 'coder');

/**
 * How many times the chat model would have to be swapped to run the waiting steps in order, starting from the model
 * that is connected now. `modelFor` gives the model id for a role ('' = whatever is connected: never a swap).
 */
export function swapCount(steps: Step[], connected: string | null, modelFor: (role: string) => string): { swaps: number; loads: string[] } {
  let now = connected ?? '';
  const loads: string[] = [];
  for (const s of steps) {
    const role = s.status === 'todo' ? workerRole(s) : null;
    if (!role) continue;
    const want = modelFor(role);
    if (want && want !== now) {
      loads.push(want);
      now = want;
    }
  }
  return { swaps: loads.length, loads };
}

// ---- The reviewer ----

export const REVIEW_SYSTEM = [
  'You are a careful reviewer. You read one step of a job: its brief, the names other files use, and the files the worker wrote. You do not rewrite anything.',
  'Look for: what the brief asked for and is missing; names (ids, functions, files) that do not match the other files; code that cannot work; text that states facts it cannot know.',
  'Answer in exactly this form:\nVERDICT: OK or PROBLEMS\nthen, for PROBLEMS, at most five lines in the form "- file name: what is wrong and why, in one sentence". A line with only a file name is no use to anyone.\nDo not praise, do not repeat the code.',
].join('\n\n');

/** The reviewer's message for one step's proposed files (cut to what the context can take). */
export function reviewUser(job: Job, step: Step, files: { path: string; text: string }[], findings: string[], maxChars = MAX_INPUT_CHARS, ownerNotes: string[] = [], front = ''): string {
  const facts = notedFacts(job.notes).filter(f => !step.files.some(p => f.startsWith(`${p}:`)));
  const parts = [front, `The goal of the whole job: ${job.goal}`, `The step: ${step.title}\n${step.brief}`].filter(Boolean);
  if (ownerNotes.length) parts.push(ownerNote(ownerNotes));
  if (facts.length) parts.push(`Names in the other files:\n${facts.map(f => `- ${f}`).join('\n')}`);
  if (findings.length) parts.push(`Checks made by code already found:\n${findings.map(f => `- ${f}`).join('\n')}`);
  let room = maxChars;
  for (const f of files) {
    const text = f.text.length > room ? `${f.text.slice(0, Math.max(0, room))}\n[... cut: the rest of the file was too long to show]` : f.text;
    room -= text.length;
    parts.push(`=== FILE: ${f.path} ===\n${text}\n=== END FILE ===`);
  }
  return parts.join('\n\n');
}

/** OK, problems, or unclear (null) when the reviewer did not answer in the form. */
export function parseReview(text: string): { ok: boolean | null; problems: string[] } {
  const t = text.replace(/\r/g, '').replace(/\*\*/g, '');
  const verdict = /VERDICT\s*:\s*(OK|PROBLEMS?)/i.exec(t)?.[1]?.toUpperCase();
  // A line that is only a file name ("- tip.mjs") says nothing: small reviewers write those.
  const problems = [...t.matchAll(/^\s*[-*•]\s+(.{6,})$/gm)].map(m => oneLine(m[1], 300)).filter(p => !/^`?[\w./-]+`?:?$/.test(p)).slice(0, 5);
  if (verdict === 'OK') return { ok: true, problems: [] };
  if (verdict) return { ok: false, problems: problems.length ? problems : ['The reviewer said there are problems but did not say what they are.'] };
  return { ok: null, problems };
}

export const JOB_REVIEW_SYSTEM = 'You are a careful reviewer writing the end-of-job report for the person who asked for the work. From the goal, the plan, what each step did and the checks, write: what was built (one short paragraph), what was checked and what was NOT checked, known problems, and the next thing the person should do. Plain words, short, no praise, no invented facts. Under 250 words.';

/** The end-of-job message: goal, steps with their summaries, the names in the files, and every finding. */
export function jobReviewUser(job: Job, findings: string[], files: string[], front = '', handed: string[] = []): string {
  return [
    front,
    `Goal: ${job.goal}`,
    job.team?.expect ? `What the person expects of this final audit: ${job.team.expect.replace(/[.!?\s]+$/, '')}. Say plainly how the work measures up to that, and what it would still take.` : '',
    `Steps:\n${job.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.title}${s.summary ? `: ${s.summary}` : ''}${s.wrote.length ? ` (wrote ${s.wrote.join(', ')})` : ''}`).join('\n')}`,
    `Files in the workspace now: ${files.slice(0, 60).join(', ') || 'none'}`,
    handed.length ? `Work the specialists handed in (${SPECIALISTS} folders), newest first; the newest of each folder is the current one:\n${handed.map(h => `- ${h}`).join('\n')}` : '',
    notedFacts(job.notes).length ? `Names in the files:\n${notedFacts(job.notes).map(f => `- ${f}`).join('\n')}` : '',
    `Findings from the checks:\n${findings.length ? findings.map(f => `- ${f}`).join('\n') : '- none'}`,
  ].filter(Boolean).join('\n\n');
}

/** Workspace paths a file imports by a relative path ("./tip.mjs", require('../lib/x.js')). */
export function relativeImports(path: string, text: string, workspaceFiles: string[]): string[] {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')).split('/') : [];
  const out: string[] = [];
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']|^\s*from\s+\.(\w+)\s+import/gm)) {
    if (m[2]) {
      const py = [...dir, `${m[2]}.py`].join('/');
      if (workspaceFiles.includes(py)) out.push(py);
      continue;
    }
    const parts = [...dir];
    for (const seg of m[1].split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    const p = parts.join('/');
    const hit = [p, `${p}.js`, `${p}.mjs`, `${p}.ts`].find(c => workspaceFiles.includes(c));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/**
 * A new step to fix failing tests: the test output in the brief, and the files to change: those the output names plus
 * the files the failing tests import (the code under test), code before tests; else the last code step's files.
 */
export function testFixStep(job: Job, label: string, output: string, workspaceFiles: string[], texts: Record<string, string> = {}): Step {
  const named = workspaceFiles.filter(f => !f.startsWith('jobs/') && output.includes(f.split('/').pop()!));
  const imported = named.filter(isTestFile).flatMap(f => relativeImports(f, texts[f] ?? '', workspaceFiles));
  const both = [...new Set([...imported, ...named])].sort((a, b) => Number(isTestFile(a)) - Number(isTestFile(b)));
  const lastCode = [...job.steps].reverse().find(s => s.role === 'coder' && s.files.length)?.files ?? [];
  const files = cleanFiles(both.length ? both : lastCode);
  const tail = output.length > 1200 ? `${output.slice(0, 1200)}...` : output;
  return {
    title: `Fix the failing tests (${label})`,
    role: 'coder',
    files,
    brief: `The tests (${label}) failed. Change the code so they pass; do not change what the tests expect unless the test itself is wrong. The test output:\n${tail}`,
    check: `${label} passes`,
    status: 'todo',
    summary: '',
    wrote: [],
  };
}

/** A worker sometimes wraps the file text in a code fence inside the FILE markers: remove it. */
function stripFence(body: string): string {
  const m = /^\s*```[\w+-]*\n([\s\S]*?)\n?```\s*$/.exec(body);
  return m ? m[1] : body;
}
