// The standing jobs kept on this PC (data/agents.json) and their runs: what the Agents page lists, what the timer looks
// at, and what Home's lines come from. A job is a recipe (src/recipe.ts), the fingerprint it was approved with, whether
// it is paused, and when each trigger fires next. A run is a line: when, what started it, how it ended, its one-line
// result, where its report is, and what was held. Pure parts, tested in test/agents.test.ts; the server keeps the file
// (src/server/agents.ts).
import { cleanRecipe, recipeHash, type AgentTool, type Recipe } from './recipe.ts';
import { afterMatches, dueNow, timed, type Trigger } from './agenttriggers.ts';
import { cleanPageState, type PageState } from './pagewatch.ts';

export type RunState = 'waiting' | 'running' | 'done' | 'held' | 'budget' | 'failed' | 'skipped' | 'stopped';
export const RUN_STATES: RunState[] = ['waiting', 'running', 'done', 'held', 'budget', 'failed', 'skipped', 'stopped'];
export const RUN_FINISHED: RunState[] = ['done', 'held', 'budget', 'failed', 'skipped', 'stopped'];

export interface Job {
  id: string;
  recipe: Recipe;
  /** The recipe's fingerprint when he approved it; a job runs only while it matches (any change needs approving again). */
  approved: string | null;
  approvedAt?: string;
  paused: boolean;
  /** When each trigger fires next (ms on this PC's clock; null: not by the clock, or a Once that has fired). */
  next: (number | null)[];
  /** Each file trigger's files seen so far (by trigger index). */
  seen: Record<string, string[]>;
  /** A page watch's pages as last looked at (their kept lines are in data/agent-pages/<job>.json). */
  watch?: PageState[];
  /** "Send its summary to my phone" (N3): his tick on the job, not part of the recipe (no approval needed). */
  phone?: boolean;
  /** "Next run, also: ..." (N4): his one-off note, given to the next run's brief only, then cleared. Not a recipe change. */
  nextNote?: { text: string; at: string };
  made: string;
  changed: string;
}

export interface HeldNote { what: string; tool?: AgentTool; never?: boolean }

export interface Run {
  id: string;
  job: string;
  /** The job's and agent's names as they were (a job deleted later still reads). */
  name: string;
  agent: string;
  agentName: string;
  by: string;
  /** A file that landed, for a file trigger. */
  file?: string;
  state: RunState;
  added: string;
  started?: string;
  ended?: string;
  line: string;
  /** report.md, relative to the workspace. */
  report?: string;
  held: HeldNote[];
  /** The queue item that runs it. */
  queue?: string;
  /** Read on Home. */
  seen?: boolean;
  /** Collected from a linked PC: its name. */
  from?: string;
  /** While it waited: why its PC counted as in use by a person (src/pcbusy.ts's fixed words), for the skip line. */
  heldWhy?: string;
}

export interface AgentsFile {
  jobs: Job[];
  runs: Run[];
  /** Runs collected from each linked PC (by PC id): their run ids. */
  collected: Record<string, string[]>;
}

export const EMPTY_FILE: AgentsFile = { jobs: [], runs: [], collected: {} };
export const JOBS_MOST = 50;
export const RUNS_KEPT = 500;

const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const id = (v: unknown) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : '');

/**
 * A job's id as kept: a damaged one (a number, a name with odd characters, edited by hand) is mended, not a reason to
 * drop the job and its recipe at the next save. A job with a recipe and no usable id at all is given a new one.
 */
function jobId(v: unknown): string {
  if (id(v)) return v as string;
  const t = typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[^\w-]/g, '').slice(0, 40) : '';
  return t || `job-${crypto.randomUUID().slice(0, 12)}`;
}

export function cleanJob(raw: unknown): Job | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = { ...(raw as Record<string, unknown>) };
  // Mended only when there is a recipe to keep; a bad id with nothing else is nothing.
  if (!id(o.id) && !(o.recipe && typeof o.recipe === 'object')) return null;
  o.id = jobId(o.id);
  const recipe = cleanRecipe(o.recipe).recipe;
  const next = Array.isArray(o.next) ? o.next.map(x => (typeof x === 'number' && Number.isFinite(x) ? x : null)) : [];
  const seen: Record<string, string[]> = {};
  if (o.seen && typeof o.seen === 'object') for (const [k, v] of Object.entries(o.seen as Record<string, unknown>)) if (/^\d$/.test(k) && Array.isArray(v)) seen[k] = v.filter((x): x is string => typeof x === 'string').slice(-2000);
  const watch = (Array.isArray(o.watch) ? o.watch : []).map(cleanPageState).filter((x): x is PageState => !!x).slice(0, 10);
  return { id: o.id as string, recipe, approved: typeof o.approved === 'string' ? o.approved : null, ...(typeof o.approvedAt === 'string' ? { approvedAt: o.approvedAt } : {}), paused: o.paused === true, next, seen, ...(watch.length ? { watch } : {}), ...(o.phone === true ? { phone: true } : {}), ...(cleanNote(o.nextNote) ? { nextNote: cleanNote(o.nextNote)! } : {}), made: s(o.made, 40), changed: s(o.changed, 40) };
}

/** The most a "Next run, also" note may hold. */
export const NOTE_MOST = 600;

function cleanNote(raw: unknown): { text: string; at: string } | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = typeof o.text === 'string' ? o.text.replace(/\r/g, '').trim().slice(0, NOTE_MOST) : '';
  return text ? { text, at: typeof o.at === 'string' ? o.at.slice(0, 40) : '' } : null;
}

export function cleanRun(raw: unknown): Run | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!id(o.id) || !id(o.job)) return null;
  const held = (Array.isArray(o.held) ? o.held : []).map(h => (h && typeof h === 'object' ? h : {}) as Record<string, unknown>).filter(h => typeof h.what === 'string').slice(0, 30).map(h => ({ what: s(h.what, 300), ...(typeof h.tool === 'string' ? { tool: h.tool as AgentTool } : {}), ...(h.never === true ? { never: true } : {}) }));
  const r: Run = { id: o.id as string, job: o.job as string, name: s(o.name, 80), agent: id(o.agent), agentName: s(o.agentName, 60), by: s(o.by, 200), state: RUN_STATES.includes(o.state as RunState) ? (o.state as RunState) : 'failed', added: s(o.added, 40), line: s(o.line, 300), held };
  for (const k of ['file', 'started', 'ended', 'report', 'queue', 'from', 'heldWhy'] as const) if (typeof o[k] === 'string' && o[k]) r[k] = s(o[k], 400);
  if (o.seen === true) r.seen = true;
  return r;
}

export function cleanFile(raw: unknown): AgentsFile {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const collected: Record<string, string[]> = {};
  if (o.collected && typeof o.collected === 'object') for (const [k, v] of Object.entries(o.collected as Record<string, unknown>)) if (Array.isArray(v)) collected[k] = v.filter((x): x is string => typeof x === 'string').slice(-2000);
  return {
    jobs: (Array.isArray(o.jobs) ? o.jobs : []).map(cleanJob).filter((x): x is Job => !!x).slice(0, JOBS_MOST),
    runs: (Array.isArray(o.runs) ? o.runs : []).map(cleanRun).filter((x): x is Run => !!x).slice(-RUNS_KEPT),
    collected,
  };
}

/** Whether a job may run by itself: approved for exactly this recipe, and not paused. */
export const approvedNow = (j: Job): boolean => !!j.approved && j.approved === recipeHash(j.recipe);
export const mayRun = (j: Job): boolean => approvedNow(j) && !j.paused;

/** A run waiting or running for this job already: a trigger then adds no second one. */
export const inLine = (f: AgentsFile, job: string): Run | undefined => f.runs.find(r => r.job === job && (r.state === 'waiting' || r.state === 'running'));

/** How a run started by a page watch begins its "by" ("A watched page changed: example.com"). */
export const PAGE_BY = 'A watched page changed';

/** The page watch's trigger of a job, if it has one. */
export const pageTrigger = (j: Job): { kind: 'page'; everyMinutes: number } | undefined => j.recipe.when.find((t): t is { kind: 'page'; everyMinutes: number } => t.kind === 'page');

/** How a run started by a file trigger begins its "by" ("A file landed in inbox"). */
export const FILE_BY = 'A file landed in';
/** At most this many runs an hour for files landing, per job: 100 files dropped at once do not load a model 100 times in a row. */
export const FILE_RUNS_HOUR = 6;

/** Whether a job's file trigger may start a run now: none in line already, and fewer than FILE_RUNS_HOUR in the last hour. */
export function fileRoom(f: AgentsFile, job: string, now: number): boolean {
  if (inLine(f, job)) return false;
  return f.runs.filter(r => r.job === job && r.by.startsWith(FILE_BY) && now - Date.parse(r.added) < 3600_000).length < FILE_RUNS_HOUR;
}

/** A waiting run's line while a person uses its PC (src/pcbusy.ts's words: "a full-screen game or program was in front"). */
export const IN_USE_LINE = 'Waiting: this PC is in use';
export const inUseLine = (why: string): string => `${IN_USE_LINE} (${why.replace(/ was /, ' is ').replace(/ were /, ' are ')}).`;

/**
 * Why a run that waited too long is skipped: behind another agent's run when one is running; while a person used its PC
 * (`inUseWhy`, the words of src/pcbusy.ts), said so; else its PC was busy.
 */
export function skipLine(f: AgentsFile, run: Run, minutes: number, inUseWhy = ''): string {
  const ahead = f.runs.find(r => r.state === 'running' && r.id !== run.id);
  if (ahead) return `Skipped: it waited ${minutes} minutes behind ${ahead.agentName}'s ${ahead.name}.`;
  if (inUseWhy) return `Skipped: ${inUseWhy} for ${minutes} minutes.`;
  return `Skipped: its PC was busy for ${minutes} minutes.`;
}

/** Whether a recipe's Agent `name` is one of `agents`: by id, by whole name, or by first name ("Jess" is "Jess Smith"). */
export function agentKnown(name: string, agents: { id: string; name: string }[]): boolean {
  const want = name.trim().toLowerCase();
  if (!want) return false;
  return agents.some(a => {
    const full = a.name.trim().toLowerCase();
    return a.id === name.trim() || full === want || full.split(/\s+/)[0] === want;
  });
}

/**
 * The clock's look at every job: the runs to add now (one per job however many of its triggers are due) and each job's
 * next times. A paused or unapproved job only moves its times on (a time missed while paused does not run on Resume).
 */
export function clockTick(f: AgentsFile, now: number): { start: { job: string; by: string }[]; next: Record<string, (number | null)[]> } {
  const start: { job: string; by: string }[] = [];
  const next: Record<string, (number | null)[]> = {};
  for (const j of f.jobs) {
    if (!j.recipe.when.some(timed)) continue;
    const d = dueNow(j.recipe.when, j.next, now);
    next[j.id] = d.next;
    if (d.fire && mayRun(j) && !inLine(f, j.id)) start.push({ job: j.id, by: d.missed ? `${whenLine(j.recipe.when)} (missed while this PC was off: run once now)` : whenLine(j.recipe.when) });
  }
  return { start, next };
}

/** The clock triggers in words, for "Started by". */
export const whenLine = (when: Trigger[]): string => {
  const t = when.filter(timed);
  return t.length ? (t.length === 1 ? 'its timer' : 'one of its timers') : 'its trigger';
};

/** The jobs an "After" trigger names, once a run of `ran` has finished (done or held: a failed run starts nothing). */
export function afterRuns(f: AgentsFile, ran: Run): string[] {
  if (ran.state !== 'done' && ran.state !== 'held' && ran.state !== 'budget') return [];
  return f.jobs.filter(j => j.id !== ran.job && mayRun(j) && !inLine(f, j.id) && j.recipe.when.some(t => t.kind === 'after' && afterMatches(t.job, { name: ran.name, agentName: ran.agentName }))).map(j => j.id);
}

/** A held item allowed for next time: its tool added to the recipe, which counts as approved by that press. */
export function allowTool(j: Job, tool: AgentTool, now = new Date().toISOString()): Job {
  const tools: AgentTool[] = j.recipe.tools.includes(tool) ? j.recipe.tools : [...j.recipe.tools, tool];
  const recipe = { ...j.recipe, tools, ...(tool === 'memory' ? { memory: true } : {}) };
  return { ...j, recipe, approved: recipeHash(recipe), approvedAt: now, changed: now };
}

/** Home's lines for finished agent runs not yet seen: one each, and the ones that found nothing new folded into one. */
export function agentHomeLines(f: AgentsFile, text: (r: Run) => string): { key: string; kind: 'agent' | 'agent-quiet' | 'failed'; text: string; report: boolean; detail: string; runs: string[]; at: string }[] {
  const fresh = f.runs.filter(r => RUN_FINISHED.includes(r.state) && r.state !== 'stopped' && !r.seen);
  const quiet = fresh.filter(r => r.state === 'done' && /^(summary:\s*)?(nothing (new|changed)|no (change|changes|new)|unchanged)/i.test(r.line));
  const loud = fresh.filter(r => !quiet.includes(r));
  const out = loud.map(r => ({ key: `agent:${r.id}`, kind: (r.state === 'failed' || r.state === 'skipped' ? 'failed' : 'agent') as 'agent' | 'failed', text: text(r), report: !!r.report, detail: [r.held.length ? `Held ${r.held.length} thing${r.held.length === 1 ? '' : 's'}.` : '', r.from ? `On ${r.from}.` : ''].filter(Boolean).join(' '), runs: [r.id], at: r.ended ?? r.added }));
  if (quiet.length) out.push({ key: 'agent-quiet', kind: 'agent-quiet' as 'agent', report: true, text: `${quiet.length} agent run${quiet.length === 1 ? '' : 's'} found nothing new.`, detail: [...new Set(quiet.map(r => r.name))].slice(0, 4).join(', '), runs: quiet.map(r => r.id), at: quiet.map(r => r.ended ?? r.added).sort().at(-1)! });
  return out;
}
