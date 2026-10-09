// Steps sized to workers: what each worker (a "seat": a model on this PC or on a linked PC, with its context size) can
// take in one step, and what to do with a step that does not fit its worker: split it into parts that do, or move it to
// a worker it fits. Big reading jobs (the plan, a fix across files, the end-of-job report) go to the biggest-context
// worker when the switch says so. Also the check that the plan's F1, F2, … are the ones on the Scope card. Nothing here
// loads a model or touches the disk; the plain functions are tested in test/seats.test.ts.
import { budget, MAX_STEPS, type Step } from './jobs.ts';

/** One worker as it stands now, read without loading anything. */
export interface Seat {
  /** The brain ref: a model id here, "remote:<pc>", or '' for the connected model. */
  ref: string;
  /** "Qwen3.5-0.8B" or "Qwen3-30B on node 3". */
  label: string;
  ctx: number;
  /** Billions of parameters from the name (null when the name does not say). */
  params: number | null;
  /** Answers now (no model swap needed). */
  ready: boolean;
}

/** Where big reading jobs go: the biggest-context worker, or the one picked. Retired with "Who does the work": jobs pass 'picked'. */
export type BigReads = 'biggest' | 'picked';
export const isBigReads = (v: unknown): v is BigReads => v === 'biggest' || v === 'picked';

/**
 * Characters of files one step can read and change on a model with `ctx` tokens, after the packet front of `front`
 * characters: what it can read in. The files that fit its answer go back whole; a longer one is changed with edit
 * blocks (jobs.editFiles), so the answer no longer caps the step (PLAN F10 G2).
 */
export function stepRoom(ctx: number, front = 0): number {
  return budget(ctx, front).input;
}

/** A big reading job among steps: a fix across two or more files (the "fix the failing tests" step, or a step titled as a fix). */
export const crossFile = (s: Step) => s.files.length > 1 && /\bfix/i.test(s.title);

/**
 * The strongest worker available ("Lets go!" and a project manager left on Default): most parameters, then most
 * context, then one that answers now (no load).
 */
export function strongest(seats: Seat[]): Seat | null {
  return [...seats].sort((a, b) => (b.params ?? 0) - (a.params ?? 0) || b.ctx - a.ctx || Number(b.ready) - Number(a.ready))[0] ?? null;
}

/** The biggest worker: most context, then most parameters, then one that answers now. */
export function biggest(seats: Seat[]): Seat | null {
  return [...seats].sort((a, b) => b.ctx - a.ctx || (b.params ?? 0) - (a.params ?? 0) || Number(b.ready) - Number(a.ready))[0] ?? null;
}

/** The smallest worker a step of `need` characters fits: one that answers now first (no swap), then the least context. */
export function smallestFit(seats: Seat[], need: number, roomOf: (s: Seat) => number): Seat | null {
  return seats.filter(s => roomOf(s) >= need).sort((a, b) => Number(b.ready) - Number(a.ready) || a.ctx - b.ctx)[0] ?? null;
}

/** The step's files in order, grouped so each group fits `room` characters; null when one file alone does not fit. */
export function groupFiles(files: string[], sizes: Record<string, number>, room: number): string[][] | null {
  const groups: string[][] = [];
  let cur: string[] = [];
  let used = 0;
  for (const f of files) {
    const n = sizes[f] ?? 0;
    if (n > room) return null;
    if (cur.length && used + n > room) {
      groups.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(f);
    used += n;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** One step as parts, one per group of files: the same brief, and each part told which files the other parts change. */
export function splitStep(step: Step, groups: string[][]): Step[] {
  return groups.map((files, k) => {
    const others = groups.filter((_, j) => j !== k).flat();
    const line = `This is part ${k + 1} of ${groups.length} of this step: change only ${files.join(', ')}.${others.length ? ` The other part${groups.length > 2 ? 's change' : ' changes'} ${others.join(', ')}: do not write ${others.length > 1 ? 'them' : 'it'}, and use the names ${others.length > 1 ? 'they use' : 'it uses'}.` : ''}`;
    return {
      ...step,
      title: `${step.title.slice(0, 80)} (part ${k + 1} of ${groups.length})`,
      files,
      brief: `${step.brief.slice(0, 1600 - line.length - 2)}\n\n${line}`,
      status: 'todo',
      summary: '',
      wrote: [],
    };
  });
}

export type Fit =
  | { kind: 'fits'; seat: Seat }
  | { kind: 'move'; seat: Seat; why: string }
  | { kind: 'split'; seat: Seat; groups: string[][] }
  | { kind: 'none'; why: string };

const n = (x: number) => x.toLocaleString('en-GB');
const ctxWord = (s: Seat) => `${s.label}, ${n(s.ctx)}-token context`;

/**
 * What to do with a step before it runs. `own` is the worker the step belongs to (the hire in its role, else "Who does
 * the work"); `pool` is every worker that can answer or be loaded; `sizes` the characters of the step's files now (a
 * file not made yet counts 0); `steps` how many steps the job has now (a split may not take it past MAX_STEPS).
 * A fix across files is a big reading job: with `mode` "biggest" it goes to the biggest-context worker.
 * Otherwise: its own worker when it fits; else split by files for its own worker; else the smallest worker it fits.
 */
export function fitStep(step: Step, sizes: Record<string, number>, own: Seat, pool: Seat[], roomOf: (s: Seat) => number, mode: BigReads, steps: number): Fit {
  const need = step.files.reduce((t, f) => t + (sizes[f] ?? 0), 0);
  const all = pool.some(s => s.ref === own.ref) ? pool : [own, ...pool];
  if (crossFile(step) && mode === 'biggest') {
    const big = biggest(all)!;
    if (big.ref !== own.ref && roomOf(big) >= need) return { kind: 'move', seat: big, why: `a fix across files is a big reading job, so it goes to the worker with the biggest context (${ctxWord(big)})` };
  }
  if (roomOf(own) >= need) return { kind: 'fits', seat: own };
  // A fix across files is not split: its files have to be read together.
  const groups = crossFile(step) ? null : groupFiles(step.files, sizes, roomOf(own));
  if (groups && groups.length > 1 && steps + groups.length - 1 <= MAX_STEPS) return { kind: 'split', seat: own, groups };
  const fit = smallestFit(all, need, roomOf);
  if (fit) return { kind: 'move', seat: fit, why: `its files hold ${n(need)} characters, more than ${own.label} can read in one step (about ${n(roomOf(own))}); ${fit.label} can take about ${n(roomOf(fit))}` };
  const big = biggest(all)!;
  const huge = step.files.filter(f => (sizes[f] ?? 0) > roomOf(big));
  return {
    kind: 'none',
    why: huge.length
      ? `${huge.map(f => `${f} holds ${n(sizes[f])} characters`).join(' and ')}: no worker here can read ${huge.length > 1 ? 'those files' : 'that file'} in one step (the most is about ${n(roomOf(big))}, on ${ctxWord(big)}). Split the file by hand into smaller files, give a model a bigger context (chat settings), or link a PC with a bigger one.`
      : `The files of this step hold ${n(need)} characters together, more than any worker here can take in one step (the most is about ${n(roomOf(big))}, on ${ctxWord(big)}), and splitting it would take the job past ${MAX_STEPS} steps. Name fewer files in the step, or give a model a bigger context.`,
  };
}

/** Splits, at plan time, the steps whose files already exist and do not fit their worker; `roomFor` gives a step's room (null: not known). */
export function sizePlan(steps: Step[], sizes: Record<string, number>, roomFor: (s: Step) => number | null): { steps: Step[]; split: { title: string; parts: number }[] } {
  const out: Step[] = [];
  const split: { title: string; parts: number }[] = [];
  steps.forEach((s, i) => {
    const room = roomFor(s);
    const need = s.files.reduce((t, f) => t + (sizes[f] ?? 0), 0);
    const groups = room !== null && need > room && !crossFile(s) ? groupFiles(s.files, sizes, room) : null;
    // Room for the parts: the steps still to come keep theirs.
    if (groups && groups.length > 1 && out.length + groups.length + (steps.length - i - 1) <= MAX_STEPS) {
      out.push(...splitStep(s, groups));
      split.push({ title: s.title, parts: groups.length });
    } else out.push(s);
  });
  return { steps: out, split };
}

/** What the planner is told about its workers: each one's limit per step, so it can size the steps. */
export function workersLine(lines: { who: string; seat: Seat; room: number }[]): string {
  if (!lines.length) return '';
  return [
    'Each worker reads all the files of its step (it writes short files back whole and changes a long one with edit blocks), so the files of one step must fit the worker who does it:',
    ...lines.map(l => `- ${l.who}: ${l.seat.label} (${n(l.seat.ctx)}-token context), at most about ${n(l.room)} characters of files in one step.`),
    'Give a long file a step of its own, and never put more files in one step than fit. A new file should stay well under the limit.',
  ].join('\n');
}

// ---- F1, F2, … against the Scope card ----

/** F-numbers in a text: "F2", "F1-F3", "F1–F5", "F2 and F4". */
export function fnsIn(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/\bF(\d{1,2})(?:\s*[-–]\s*F?(\d{1,2}))?\b/g)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let k = Math.min(a, b); k <= Math.min(Math.max(a, b), 30); k++) out.add(k);
  }
  return [...out].sort((x, y) => x - y);
}

/** The F-numbers on a Scope card: the lines that start with one ("F1. Add the bill", "F1-F3: …"). */
export const cardFns = (scope: string) => fnsIn(scope.split('\n').filter(l => /^\s*(?:[-*]\s*)?F\d/.test(l)).map(l => /^\s*(?:[-*]\s*)?(F\d{1,2}(?:\s*[-–]\s*F?\d{1,2})?)/.exec(l)![1]).join(' '));

const fnList = (xs: number[]) => xs.map(x => `F${x}`).join(', ');

/**
 * Plain checks, by code, that the plan and the Scope card agree: every F-number a step names is on the card, and every
 * F-number on the card is named by a step that is not skipped. Empty when they agree (or there is no card).
 */
export function fnCheck(steps: Step[], scope: string): string[] {
  const card = cardFns(scope);
  if (!card.length) return [];
  const out: string[] = [];
  const named = new Set<number>();
  steps.forEach((s, i) => {
    const fs = fnsIn(`${s.title} ${s.brief}`);
    if (s.status !== 'skipped') fs.forEach(f => named.add(f));
    const extra = fs.filter(f => !card.includes(f));
    if (extra.length) out.push(`Step ${i + 1} names ${fnList(extra)}, which ${extra.length > 1 ? 'are' : 'is'} not on the Scope card (it has ${fnList(card)}).`);
  });
  if (!named.size) return [`No step names ${fnList(card)} from the Scope card, so code cannot check that each one is planned. Read the plan against the card.`, ...out];
  const missing = card.filter(f => !named.has(f));
  if (missing.length) out.unshift(`${fnList(missing)} ${missing.length > 1 ? 'are' : 'is'} on the Scope card, but no step names ${missing.length > 1 ? 'them' : 'it'}: check the plan covers ${missing.length > 1 ? 'them' : 'it'}.`);
  return out.slice(0, 8);
}
