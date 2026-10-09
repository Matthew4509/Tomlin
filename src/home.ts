// Home: the inbox and the staff list. Every line here is written by code from the job's plan file, the step result
// waiting on disk and the state of the models, never by a model: a small model does not reliably report what it did.
// Plain functions, tested in test/home.test.ts; the server gathers the facts and the page draws them.
import type { Job } from './jobs.ts';

/** A step that came back and is waiting for the person (kept on disk as jobs/<id>/waiting.json until saved or discarded). */
export interface Waiting {
  n: number;
  at: string;
  worker: string;
  files: string[];
  /** Checks that failed, cross-file warnings and reviewer problems, counted for the line on Home. */
  flags: number;
}

/** What a job action is doing right now (one at a time), kept in memory while it runs. */
export interface Running {
  kind: 'plan' | 'step' | 'run' | 'review' | 'final';
  jobId: string | null;
  goal: string;
  /** The step being worked on, or null (planning, the end-of-job report). */
  n: number | null;
  title: string;
  role: string | null;
  stage: string;
  startedAt: number;
}

export interface Person {
  id: string;
  name: string;
  role: string;
}

/** Job roles that a hired role stands for: the planner is the project manager. */
const HIRE_FOR: Record<string, string> = { planner: 'pm', coder: 'coder', writer: 'writer', artist: 'artist', designer: 'designer' };
const ROLE_WORD: Record<string, string> = { planner: 'planner', coder: 'coder', writer: 'writer', artist: 'artist', designer: 'graphic designer', reviewer: 'reviewer', pm: 'project manager' };

/** The person who does a role's work: the first hire in that role, else the role itself ("the coder"). */
export function whoFor(role: string | null, staff: Person[]): { name: string; id: string | null } {
  const hire = role ? staff.find(m => m.role === (HIRE_FOR[role] ?? role)) : undefined;
  return hire ? { name: hire.name, id: hire.id } : { name: `the ${ROLE_WORD[role ?? ''] ?? 'worker'}`, id: null };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const short = (s: string, max = 80) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/**
 * A worker as people read it: a model file name loses its folder, ".gguf", the quantisation and "-it"
 * ("models/Qwen3.5-0.8B-Q4_K_M.gguf" -> "Qwen3.5 0.8B"). Words that are not a file name ("laptop 0.8B") stay as they are.
 */
export function workerName(w: string): string {
  const s = String(w ?? '').trim();
  if (!s || /\s/.test(s)) return s;
  const base = s.split(/[\\/]/).pop()!.replace(/\.gguf$/i, '');
  const cut = base.replace(/[-_.](?:I?Q\d[\w]*|F16|F32|BF16)$/i, '').replace(/[-_]it$/i, '');
  return cut.replace(/[-_]+/g, ' ').trim() || s;
}

export type Kind = 'result' | 'picture' | 'tests' | 'report' | 'paused' | 'ready';

export interface HomeItem {
  job: string;
  goal: string;
  kind: Kind;
  /** The line, written by code: who did what, and what is needed. */
  text: string;
  detail: string;
  /** The button's words. */
  action: string;
  at: string;
  /** The hire it is about, for the staff row (null when nobody was hired for the role). */
  staffId: string | null;
}

/**
 * What a job needs from the person now, or null (it is running, or finished with its report written). In order of
 * weight: a step that came back, a picture to draw, failed tests, the end-of-job report, and a job paused between steps.
 */
export function jobItem(job: Job, waiting: Waiting | null, hasReport: boolean, running: boolean, staff: Person[]): HomeItem | null {
  if (running) return null;
  const total = job.steps.length;
  const base = { job: job.id, goal: short(job.goal), at: job.updated || job.created };
  if (waiting && job.steps[waiting.n]?.status === 'todo') {
    const s = job.steps[waiting.n];
    const who = whoFor(s.role, staff);
    return {
      ...base,
      kind: 'result',
      at: waiting.at,
      text: `${cap(who.name)} finished step ${waiting.n + 1} of ${total} (${short(s.title, 60)}). Please review.`,
      detail: [waiting.files.length ? `Wrote ${waiting.files.join(', ')}` : 'No files came back', `by ${workerName(waiting.worker)}`, waiting.flags ? `${waiting.flags} check${waiting.flags > 1 ? 's' : ''} to look at` : 'every check passed'].join(' · '),
      action: 'Review',
      staffId: who.id,
    };
  }
  const i = job.steps.findIndex(s => s.status === 'todo');
  if (i >= 0 && (job.steps[i].role === 'artist' || job.steps[i].role === 'designer')) {
    const who = whoFor(job.steps[i].role, staff);
    return { ...base, kind: 'picture', text: `Step ${i + 1} of ${total} needs a picture from ${who.name}: ${short(job.steps[i].title, 60)}.`, detail: 'Draw it in an artist\'s chat, then mark the step done in the job.', action: 'Open the job', staffId: who.id };
  }
  if (job.tests && !job.tests.ok) {
    return { ...base, kind: 'tests', text: `The tests failed (${job.tests.label}).`, detail: `Run on ${job.tests.at.slice(0, 16).replace('T', ' ')}. The job can add a step to fix them.`, action: 'Open the job', staffId: null };
  }
  if (i < 0) {
    if (hasReport) return null;
    return { ...base, kind: 'report', text: `All ${total} steps are done. Please review the result.`, detail: job.tests ? 'The tests passed. The end-of-job report is not written yet.' : 'No tests run yet, and the end-of-job report is not written yet.', action: 'Open the job', staffId: null };
  }
  const done = job.steps.filter(s => s.status !== 'todo').length;
  const who = whoFor(job.steps[i].role, staff);
  return { ...base, kind: done ? 'paused' : 'ready', text: done ? `Paused before step ${i + 1} of ${total}: ${short(job.steps[i].title, 60)}.` : `Not started. Step 1 of ${total}: ${short(job.steps[i].title, 60)}.`, detail: `${done} of ${total} done. Next: ${who.name}.`, action: 'Open the job', staffId: who.id };
}

/** Items that need the person, newest first within each kind, in the order of jobItem's weights. Paused jobs and jobs never started come apart. */
export function sortItems(items: HomeItem[]): { waiting: HomeItem[]; paused: HomeItem[]; ready: HomeItem[] } {
  const order: Kind[] = ['result', 'picture', 'tests', 'report'];
  const byTime = (a: HomeItem, b: HomeItem) => b.at.localeCompare(a.at);
  return {
    waiting: items.filter(x => x.kind !== 'paused' && x.kind !== 'ready').sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || byTime(a, b)),
    paused: items.filter(x => x.kind === 'paused').sort(byTime),
    ready: items.filter(x => x.kind === 'ready').sort(byTime),
  };
}

/** One of Home's "Recent projects": a job, or a project saved without a plan (plan: true). */
export interface Recent { job: string; name: string; goal: string; detail: string; action: string; plan: boolean; at: string }

/** Home's "Recent projects", newest first: each with how far it is, in words written by code. At most `max`. */
export function recentProjects(list: Job[], unplanned: { id: string; name: string; goal: string; at: string }[], runningId: string | null, max = 6): Recent[] {
  const out: Recent[] = list.map(job => {
    const total = job.steps.length;
    const done = job.steps.filter(s => s.status !== 'todo').length;
    const detail = runningId === job.id ? `Working on it now · ${done} of ${total} steps done`
      : done === total ? `All ${total} step${total === 1 ? '' : 's'} done`
      : done ? `${done} of ${total} steps done`
      : `Not started · ${total} step${total === 1 ? '' : 's'} planned`;
    return { job: job.id, name: short(job.name || job.goal, 80), goal: short(job.goal), detail, action: 'Open', plan: false, at: job.updated || job.created };
  });
  for (const p of unplanned) out.push({ job: p.id, name: short(p.name || p.goal || 'A project', 80), goal: short(p.goal), detail: 'No plan yet', action: 'Make the plan', plan: true, at: p.at });
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, max);
}

/** The "Working now" line for a running job action, with how far the job is. */
export function workingLine(r: Running, job: Job | null, staff: Person[], now = Date.now()) {
  const total = job?.steps.length ?? 0;
  const done = job?.steps.filter(s => s.status !== 'todo').length ?? 0;
  const who = whoFor(r.kind === 'plan' ? 'planner' : r.kind === 'review' || r.kind === 'final' ? 'reviewer' : r.role, staff);
  let text: string;
  if (r.kind === 'plan') text = `${cap(who.name)} is making a plan.`;
  else if (r.kind === 'final') text = `${cap(who.name)} is writing the end-of-job report.`;
  else if (r.kind === 'review') text = `${cap(who.name)} is reading step ${(r.n ?? 0) + 1}.`;
  else if (r.n == null) text = 'Starting the next step.';
  else text = `${cap(who.name)} is on step ${r.n + 1} of ${total}: ${short(r.title, 60)}.`;
  return { job: r.jobId, goal: short(r.goal), text, stage: short(r.stage, 160), done, total, seconds: Math.max(0, Math.round((now - r.startedAt) / 1000)), staffId: who.id };
}

export type State = 'on' | 'waking' | 'asleep' | 'off' | 'none';

/**
 * A staff member's state from their model and the pane it runs in. On: their model is loaded. Waking: it is loading.
 * Asleep: it is on this PC but not loaded (nothing loads until Connect). None: no model given,
 * or it is not on this PC.
 * (Off is for a PC that does not answer: a paired worker PC.)
 */
export function staffState(model: string | null | undefined, pane: { state: string; model: string | null }, installed: boolean, loadSeconds: number): { state: State; text: string } {
  if (!model) return { state: 'none', text: 'No model given' };
  if (pane.model === model && pane.state === 'connected') return { state: 'on', text: 'On' };
  if (pane.model === model && pane.state === 'loading') return { state: 'waking', text: 'Waking up' };
  if (!installed) return { state: 'none', text: 'Model not on this PC' };
  return { state: 'asleep', text: `Asleep: not loaded. Connect wakes it in about ${Math.max(1, Math.round(loadSeconds))} s` };
}

/** The dot on a hire's or a PC's icon: green available, yellow busy, red its PC's owner is using it, grey offline. */
export type Activity = 'available' | 'busy' | 'owner' | 'offline';
export function activityOf(o: { state: State; busy: boolean; away: boolean }): Activity {
  if (o.away) return 'owner';
  if (o.state === 'off' || o.state === 'none') return 'offline';
  if (o.busy || o.state === 'waking') return 'busy';
  return 'available';
}

/**
 * What a hire is doing, for Staff overview's office (public/office.js): where they are drawn and the word under them.
 * Off: their PC does not answer (they are on holiday, at the beach outside). Owner: someone at their PC is using it. No desk: no model given.
 * Arriving: their model is loading. Waiting: another answer is on their PC first. Researching: reading what they were
 * sent. Thinking: working it out before the answer (the boardroom). Typing: writing the answer. Drawing: a picture.
 * Working: a project step. Resting: nothing asked of them.
 */
export type Doing = 'off' | 'owner' | 'nodesk' | 'arriving' | 'waiting' | 'researching' | 'thinking' | 'typing' | 'drawing' | 'working' | 'resting';
export const DOING_WORDS: Record<Doing, string> = {
  off: 'On holiday: their PC is off',
  owner: "Away: their PC's owner is using it",
  nodesk: 'No desk yet: no model given',
  arriving: 'Getting ready: their model is loading',
  waiting: 'Waiting for the PC',
  researching: 'Researching: reading what they were sent',
  thinking: 'Thinking',
  typing: 'Typing',
  drawing: 'Drawing',
  working: 'Working on a project',
  resting: 'Resting',
};
/** What an answer does now: reading what it was sent, thinking first, or writing. */
export type Phase = 'reading' | 'thinking' | 'writing';
/**
 * Each person's answer by `who`: 'waiting' for their runner (another answer is on it), else its phase (reading until
 * told otherwise). Two answers for one person: the one furthest on counts (writing, thinking, reading, waiting).
 */
export function phasesByWho(list: { who: string; waiting: boolean; phase?: Phase }[]): Map<string, Phase | 'waiting'> {
  const rank = { waiting: 0, reading: 1, thinking: 2, writing: 3 } as const;
  const out = new Map<string, Phase | 'waiting'>();
  for (const a of list) {
    if (!a.who) continue;
    const now: Phase | 'waiting' = a.waiting ? 'waiting' : a.phase ?? 'reading';
    const was = out.get(a.who);
    if (!was || rank[now] > rank[was]) out.set(a.who, now);
  }
  return out;
}

export function doingOf(o: { state: State; away: boolean; remoteBusy: boolean; phase: Phase | 'waiting' | null; picture: boolean; job: boolean }): Doing {
  if (o.away) return 'owner';
  if (o.state === 'off') return 'off';
  if (o.state === 'none') return 'nodesk';
  // Their model is still loading: whatever was asked of them waits for it.
  if (o.state === 'waking') return 'arriving';
  if (o.picture) return 'drawing';
  if (o.phase === 'writing') return 'typing';
  if (o.phase === 'thinking') return 'thinking';
  if (o.phase === 'reading') return 'researching';
  if (o.phase === 'waiting' || o.remoteBusy) return 'waiting';
  if (o.job) return 'working';
  return 'resting';
}

// ---- The office's rewards: employee of the month (most tokens written this month) and the weekly leaderboard ----

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** This month (from its 1st) and this week (from Monday), in this PC's own time, as "YYYY-MM-DD" days. */
export function awardPeriods(now = new Date()): { month: string; monthName: string; monthFrom: string; weekFrom: string; today: string } {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  return {
    month: day(now).slice(0, 7),
    monthName: now.toLocaleString('en-GB', { month: 'long', year: 'numeric' }),
    monthFrom: day(new Date(now.getFullYear(), now.getMonth(), 1)),
    weekFrom: day(monday),
    today: day(now),
  };
}
/** One award: who was employee of the month, for which month, with how many tokens written. */
export interface Award { month: string; id: string; name: string; out: number; at: string }
/** Awards as kept (data/office.json): newest last, one per month, the last 24 months. */
export function cleanAwards(raw: unknown): Award[] {
  const list = Array.isArray((raw as { awards?: unknown })?.awards) ? (raw as { awards: unknown[] }).awards : [];
  const by = new Map<string, Award>();
  for (const a of list) {
    const r = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
    if (typeof r.month !== 'string' || !/^\d{4}-\d{2}$/.test(r.month) || typeof r.id !== 'string' || !r.id) continue;
    by.set(r.month, { month: r.month, id: r.id, name: String(r.name ?? '').slice(0, 60), out: Math.max(0, Math.round(Number(r.out) || 0)), at: String(r.at ?? '') });
  }
  return [...by.values()].sort((x, y) => x.month.localeCompare(y.month)).slice(-24);
}
/**
 * The winner of a board, in whatever order it comes: whoever wrote the most. Nobody when no one wrote anything, and
 * nobody alone when the most is shared (`tied` lists them, so the page can say who).
 */
export function winnerOf<T extends { out: number }>(board: T[]): { won: T } | { tied: T[] } | null {
  const most = Math.max(0, ...board.map(r => r.out));
  if (!(most > 0)) return null;
  const top = board.filter(r => r.out === most);
  return top.length === 1 ? { won: top[0] } : { tied: top };
}
/**
 * This month's award when the board has moved on since it was given (a month still running keeps counting): who leads
 * now, else null (no award this month, or its winner still leads).
 */
export function awardBehind<T extends { id: string; out: number }>(awards: Award[], month: string, board: T[]): T | null {
  const a = awards.find(x => x.month === month);
  const w = a ? winnerOf(board) : null;
  return w && 'won' in w && w.won.id !== a!.id ? w.won : null;
}
/** The awards with `month`'s taken off (Undo award), and the one taken; null when that month has none. */
export function undoAward(awards: Award[], month: string): { awards: Award[]; undone: Award } | null {
  const undone = awards.find(a => a.month === month);
  return undone ? { awards: awards.filter(a => a !== undone), undone } : null;
}

/**
 * The office's reward shop (public/office.js): the team's tokens written are its money. A coffee round and a box of
 * donuts are treats (bought again and again); the gym equipment stays in the lounge once bought.
 */
export const SHOP = [
  { id: 'coffee', name: 'Coffee round', price: 2_000, keeps: false },
  { id: 'donuts', name: 'Box of donuts', price: 5_000, keeps: false },
  { id: 'gym', name: 'Gym equipment', price: 100_000, keeps: true },
] as const;
export type ShopId = (typeof SHOP)[number]['id'];
/** One purchase: what, what it cost then, when. */
export interface Bought { item: ShopId; price: number; at: string }
/** Purchases as kept (data/office.json, beside the awards): oldest first, the last 1000. */
export function cleanBought(raw: unknown): Bought[] {
  const list = Array.isArray((raw as { bought?: unknown })?.bought) ? (raw as { bought: unknown[] }).bought : [];
  const out: Bought[] = [];
  for (const b of list) {
    const r = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    if (!SHOP.some(i => i.id === r.item)) continue;
    out.push({ item: r.item as ShopId, price: Math.max(0, Math.round(Number(r.price) || 0)), at: String(r.at ?? '').slice(0, 40) });
  }
  return out.slice(-1000);
}
/** The team's purse: every token its hires ever wrote, less what was spent. */
export function purseOf(earned: number, bought: Bought[]): { earned: number; spent: number; left: number } {
  const spent = bought.reduce((n, b) => n + b.price, 0);
  const e = Math.max(0, Math.round(earned) || 0);
  return { earned: e, spent, left: Math.max(0, e - spent) };
}
/** The shop's items with whether each is owned already (only the gym can be). */
export const shopView = (bought: Bought[]) => SHOP.map(i => ({ ...i, owned: i.keeps && bought.some(b => b.item === i.id) }));
/** Buying `item`: the purchase to keep, or why not (unknown, owned already, not enough tokens). */
export function buy(item: unknown, earned: number, bought: Bought[], now = new Date()): { bought: Bought } | { error: string } {
  const i = SHOP.find(x => x.id === item);
  if (!i) return { error: 'That is not in the office shop. Pick a coffee round, donuts or the gym equipment.' };
  if (i.keeps && bought.some(b => b.item === i.id)) return { error: `The office has the ${i.name.toLowerCase()} already: it stays in the lounge.` };
  const left = purseOf(earned, bought).left;
  const n = (x: number) => x.toLocaleString('en-GB');
  if (left < i.price) return { error: `Not enough tokens yet: the ${i.name.toLowerCase()} costs ${n(i.price)} and the team has ${n(left)} to spend. Every token your staff write adds to it, so talk to them and come back.` };
  return { bought: { item: i.id, price: i.price, at: now.toISOString() } };
}

/**
 * A paired worker PC: On (a model loaded), Asleep (answers, no model loaded), Off (does not answer), or Not linked (it
 * answers, but refuses this PC: the link was removed there, or it was set up again), with what it said.
 */
export function pcState(r: { ok: boolean; model?: string | null; image?: { name: string | null } | null; away?: string | null; answered?: boolean; relink?: boolean; error?: string }): { state: State; text: string } {
  if (!r.ok && (r.answered || r.relink)) return { state: 'off', text: `Not linked any more: ${String(r.error ?? 'it refused this PC').replace(/[.\s]+$/, '')}. Link it again under Other PCs` };
  if (!r.ok) return { state: 'off', text: 'Off: not answering' };
  // Someone at that PC pressed "I need to use the pc" (F7 E5).
  if (r.away) return { state: 'off', text: 'Logged off: "I need to log off for now"' };
  return r.model || r.image?.name ? { state: 'on', text: 'On' } : { state: 'asleep', text: 'Asleep: no model loaded' };
}

// ---- Job rooms: one group chat per job, every line made by code from the job's events ----

/**
 * One thing that happened in a job, appended by code to jobs/<id>/events.jsonl as it happens. The room is replayed from
 * these, so a job opened again days later shows the same room. Nothing here is written by a model.
 */
export type JobEvent = { at: string } & (
  | { type: 'plan'; steps: number; worker: string; split?: { title: string; parts: number }[] }
  | { type: 'split'; n: number; parts: number; files: string[][]; worker: string; room: number }
  | { type: 'moved'; n: number; role: string; from: string; to: string; why: string }
  | { type: 'step'; n: number; title: string; role: string; worker: string; notes: string[] }
  | { type: 'result'; n: number; role: string; files: string[]; flags: number; worker: string; tries: number; notes: string[] }
  | { type: 'failed'; n: number; role: string; error: string }
  | { type: 'saved'; n: number; files: string[]; auto: boolean; left: number }
  | { type: 'discard'; n: number }
  | { type: 'mark'; n: number; status: string; left: number }
  | { type: 'edit'; steps: number }
  | { type: 'addfix'; n: number }
  | { type: 'tests'; ok: boolean; label: string }
  | { type: 'review'; n: number; ok: boolean | null; problems: number; notes: string[] }
  | { type: 'report'; path: string }
  | { type: 'picture'; n: number; title: string; role: string }
  | { type: 'note'; id: string; text: string; to: Mention[] }
);

/** Someone a note is addressed to: a hire (by name) or a role with nobody hired ("@coder"). `role` is the job role. */
export interface Mention {
  staffId: string | null;
  name: string;
  role: string | null;
}

export interface RoomLine {
  at: string;
  /** Who says it: "You", "TOMLIN", or the person doing the role. */
  from: string;
  fromId: string | null;
  /** The "to Rowan" tag. */
  to: string | null;
  text: string;
  /** "you" for his own lines, "manager" for the manager's, "staff" for a worker's. */
  side: 'you' | 'manager' | 'staff';
  /** A line that needs him (a result to review, a stop, a picture to draw). */
  needs: boolean;
}

/** The job role a hired role works as (the project manager plans); a role with no job steps is left out. */
const JOB_ROLE_OF: Record<string, string> = { pm: 'planner', coder: 'coder', writer: 'writer', artist: 'artist', designer: 'designer' };
const ROLE_ALIASES: Record<string, string> = { coder: 'coder', writer: 'writer', artist: 'artist', designer: 'designer', reviewer: 'reviewer', planner: 'planner', pm: 'planner' };

/**
 * Who a message is addressed to: every "@Name" that matches a hire's first name or whole name (spaces left out), or a
 * job role ("@coder"), in the order written, each once. A hire's role decides which steps read the note.
 */
export function mentions(text: string, staff: Person[]): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(/(?:^|[\s(,])@([\p{L}\p{N}_.-]+)/gu)) {
    const word = m[1].replace(/[.,-]+$/, '').toLowerCase();
    const hire = staff.find(p => p.name.split(/\s+/)[0].toLowerCase() === word || p.name.replace(/\s+/g, '').toLowerCase() === word);
    const alias = ROLE_ALIASES[word];
    // "@writer" with a writer hired is that person.
    const byRole = alias ? whoFor(alias, staff) : null;
    const add: Mention | null = hire
      ? { staffId: hire.id, name: hire.name, role: JOB_ROLE_OF[hire.role] ?? null }
      : alias ? { staffId: byRole!.id, name: byRole!.name, role: alias } : null;
    if (add && !out.some(o => o.name === add.name)) out.push(add);
  }
  return out;
}

/** The owner's notes a step in this role has not read yet: a note is used once a step in that role came back with it. */
export function pendingNotes(events: JobEvent[], role: string): { id: string; text: string }[] {
  const used = new Set(events.flatMap(e => ((e.type === 'result' && e.role === role) || (e.type === 'review' && role === 'reviewer') ? e.notes : [])));
  return events.flatMap(e => (e.type === 'note' && e.to.some(t => t.role === role) && !used.has(e.id) ? [{ id: e.id, text: e.text }] : []));
}

/** The room's lines, in order. For a job made before rooms existed, the plan file stands in: one line per finished step. */
export function roomLines(events: JobEvent[], job: Job, staff: Person[]): RoomLine[] {
  const total = job.steps.length;
  const lines: RoomLine[] = [];
  const you = (at: string, text: string, to: string | null = null): RoomLine => ({ at, from: 'You', fromId: null, to, text, side: 'you', needs: false });
  const mgr = (at: string, text: string, to: string | null = null, needs = false): RoomLine => ({ at, from: 'TOMLIN', fromId: null, to, text, side: 'manager', needs });
  const by = (role: string | null, at: string, text: string, to: string | null = null, needs = false): RoomLine => {
    const w = whoFor(role, staff);
    return { at, from: cap(w.name), fromId: w.id, to, text, side: 'staff', needs };
  };
  const title = (n: number) => short(job.steps[n]?.title ?? `step ${n + 1}`, 60);
  const allDone = (at: string) => mgr(at, `All ${total} steps are done. Please review the result: run the tests or ask for the end-of-job report.`, 'You', true);
  if (!events.length) {
    lines.push(mgr(job.created, `The plan for "${short(job.goal)}" has ${total} step${total === 1 ? '' : 's'}. This job was made before job rooms, so the lines below come from its plan file.`));
    job.steps.forEach((s, n) => {
      if (s.status === 'done') lines.push(by(s.role, job.updated || job.created, `Step ${n + 1} done: ${s.summary || title(n)}`));
      if (s.status === 'skipped') lines.push(mgr(job.updated || job.created, `Step ${n + 1} was skipped: ${title(n)}.`));
    });
    return lines;
  }
  for (const e of events) {
    switch (e.type) {
      case 'plan':
        lines.push(by('planner', e.at, `Made a plan in ${e.steps} step${e.steps === 1 ? '' : 's'} (${workerName(e.worker)}). Read it and change anything before it runs.`, 'You', true));
        if (e.split?.length) lines.push(mgr(e.at, `Split ${e.split.map(x => `"${short(x.title, 50)}" into ${x.parts} parts`).join(', ')}: the files were too big for one step of the worker who does it.`));
        break;
      case 'split': lines.push(mgr(e.at, `Step ${e.n + 1} is too big for ${workerName(e.worker)} in one go (about ${e.room.toLocaleString('en-GB')} characters a step), so it is now ${e.parts} steps: ${e.files.map(f => f.join(' + ')).join('; ')}.`)); break;
      case 'moved': lines.push(mgr(e.at, `Step ${e.n + 1} goes to ${e.to} instead of ${e.from}: ${short(e.why, 240)}.`, cap(whoFor(e.role, staff).name))); break;
      case 'step': {
        const w = whoFor(e.role, staff);
        lines.push(mgr(e.at, `Assigning step ${e.n + 1} of ${total} (${short(e.title, 60)}) to ${w.name}.`, cap(w.name)));
        lines.push(by(e.role, e.at, `On it.${e.notes.length ? ` Reading your note${e.notes.length > 1 ? 's' : ''} with the brief.` : ''} (${workerName(e.worker)})`));
        break;
      }
      case 'result': lines.push(by(e.role, e.at, `Finished step ${e.n + 1}, please review. ${e.files.length ? `Wrote ${e.files.join(', ')}` : 'No files came back'} · ${e.flags ? `${e.flags} check${e.flags > 1 ? 's' : ''} to look at` : 'every check passed'}${e.tries > 1 ? ` · ${e.tries} tries` : ''}.`, 'You', true)); break;
      case 'failed': lines.push(e.error === 'Stopped.' ? you(e.at, `Stopped step ${e.n + 1}.`) : by(e.role, e.at, `Step ${e.n + 1} stopped: ${short(e.error, 240)}`, 'You', true)); break;
      case 'saved':
        lines.push(e.auto ? mgr(e.at, `Saved step ${e.n + 1}: every check passed.${e.files.length ? ` (${e.files.join(', ')})` : ''}`) : you(e.at, `Saved step ${e.n + 1}${e.files.length ? ` (${e.files.join(', ')})` : ''}.`));
        if (e.left === 0) lines.push(allDone(e.at));
        break;
      case 'discard': lines.push(you(e.at, `Discarded what came back for step ${e.n + 1}.`)); break;
      case 'mark':
        lines.push(you(e.at, e.status === 'todo' ? `Put step ${e.n + 1} back to do again.` : `Marked step ${e.n + 1} ${e.status === 'done' ? 'done' : 'skipped'}.`));
        if (e.left === 0 && e.status !== 'todo') lines.push(allDone(e.at));
        break;
      case 'edit': lines.push(you(e.at, `Changed the plan: now ${e.steps} step${e.steps === 1 ? '' : 's'}.`)); break;
      case 'addfix': lines.push(mgr(e.at, `Added step ${e.n + 1} to fix the failing tests.`, cap(whoFor('coder', staff).name))); break;
      case 'tests': lines.push(mgr(e.at, `The tests ${e.ok ? 'passed' : 'failed'} (${e.label}).`, e.ok ? null : 'You', !e.ok)); break;
      case 'review': lines.push(by('reviewer', e.at, e.ok === true ? `Read step ${e.n + 1}: it looks right.` : e.ok === false ? `Read step ${e.n + 1}: found ${e.problems} problem${e.problems === 1 ? '' : 's'}. See the step in Jobs.` : `Read step ${e.n + 1} but gave no clear answer.`, 'You')); break;
      case 'report': lines.push(by('reviewer', e.at, `Wrote the end-of-job report (${e.path}). Please read it: a model wrote it.`, 'You', true)); break;
      case 'picture': {
        const w = whoFor(e.role, staff);
        lines.push(mgr(e.at, `Step ${e.n + 1} needs a picture from ${w.name}: ${short(e.title, 60)}. Draw it in an artist's chat, then mark the step done.`, cap(w.name), true));
        break;
      }
      case 'note':
        lines.push(you(e.at, e.text, e.to.length ? e.to.map(t => cap(t.name)).join(', ') : null));
        lines.push(mgr(e.at, noteReply(e.to, job, readBy(events, e.id))));
        break;
    }
  }
  return lines;
}

/** What the manager says after a note, so he knows whether anyone will read it. Workers never read the room itself. */
export function noteReply(to: Mention[], job: Job, read: Record<string, number> = {}): string {
  if (!to.length) return 'Noted here. Nobody reads the room by themselves: start a note with @Name (or @coder, @writer) to put it into that person\'s next step.';
  return to.map(t => {
    if (!t.role) return `${cap(t.name)} has no steps in jobs, so nobody will read this.`;
    // Once used, the line says what happened, not what the job looks like now.
    if (t.role in read) return `${cap(t.name)} read this with step ${read[t.role] + 1}.`;
    if (t.role === 'reviewer') return `${cap(t.name)} will read this the next time a step is reviewed.`;
    const i = job.steps.findIndex(s => s.status === 'todo' && s.role === t.role);
    if (i >= 0) return `${cap(t.name)} will read this with step ${i + 1} (${short(job.steps[i].title, 50)}).`;
    return `${cap(t.name)} has no step waiting in this job: the note goes into their next step if one is added.`;
  }).join(' ');
}

/** Which roles' steps came back with a note in their brief, and the first such step. */
function readBy(events: JobEvent[], id: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.type === 'result' && e.notes.includes(id) && !(e.role in out)) out[e.role] = e.n;
    if (e.type === 'review' && e.notes.includes(id) && !('reviewer' in out)) out.reviewer = e.n;
  }
  return out;
}

/** The rail row for a room: the goal, its newest line, and how many lines there are (the page keeps what was seen). */
export function roomRow(job: Job, events: JobEvent[], staff: Person[]) {
  const lines = roomLines(events, job, staff);
  const last = lines[lines.length - 1];
  const done = job.steps.filter(s => s.status !== 'todo').length;
  return { id: job.id, goal: short(job.goal, 60), last: last ? `${last.from}: ${short(last.text, 70)}` : '', at: last?.at ?? job.updated, lines: lines.length, needs: !!last?.needs, stuck: isStuck(events), done, total: job.steps.length };
}

/** Stuck waiting for him: the last thing that happened (notes aside) is a step that stopped on a fault, or failed tests. A mute still lets this through by default. */
export function isStuck(events: JobEvent[]): boolean {
  const last = [...events].reverse().find(e => e.type !== 'note');
  return !!last && ((last.type === 'failed' && last.error !== 'Stopped.') || (last.type === 'tests' && !last.ok));
}
