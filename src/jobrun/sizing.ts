// The workers and what each can take in one step (seats), and each job's team: who plans, codes, writes and audits.
import * as jobs from '../jobs.ts';
import type { Job, Team } from '../jobs.ts';
import * as ws from '../workspace.ts';
import { TESTS } from '../checks.ts';
import * as brains from '../brains.ts';
import { nowModel, paramsB, roleOf, type StaffMember } from '../staff.ts';
import * as seats from '../seats.ts';
import { workAs } from '../meter.ts';
import { type Send, d } from './shared.ts';
import { hello, seen, sharedWhy } from './links.ts';
import { brainForRef, candidate, hireBrain } from './who.ts';
import { addEvent, jobRoot, jobView, packetFront, saveJob } from './jobfiles.ts';
import { shareView } from './node.ts';
import type { Brain } from '../jobrun.ts';

// ---- Workers and what each can take in one step (seats) ----

/**
 * One worker as it stands now, without loading anything: a model on this PC (its context from its run settings), a
 * linked PC (the context of the model it has loaded), or '' = the connected model (given as its own id). Null when it
 * cannot answer and this PC cannot load it. `cached`: what a linked PC said last, without asking it again.
 */
async function seatOf(ref: string, cached = false): Promise<seats.Seat | null> {
  const s = await d.store.settings();
  const b = brains.parseRef(ref);
  if (b.kind === 'none') {
    const v = d.chat.view;
    if (v.state !== 'connected' || !v.model) return null;
    return { ref: v.model, label: `${v.modelName ?? v.model} on this PC`, ctx: d.runNow().ctx, params: paramsB(v.modelName ?? v.model), ready: true };
  }
  if (b.kind === 'remote') {
    const r = s.remotes.find(x => x.id === b.pc);
    if (!r) return null;
    const h = cached ? seen.get(r.id) : await hello(r, 3000).catch(() => null);
    if (b.model) {
      const sh = h && !sharedWhy(r, h, b.model) ? h.models.find(x => x.id === b.model) : undefined;
      return sh ? { ref, label: `${sh.name} on ${r.name}`, ctx: sh.ctx, params: paramsB(sh.name), ready: sh.loaded } : null;
    }
    return h?.model ? { ref, label: `${h.model} on ${r.name}`, ctx: h.ctx, params: paramsB(h.model), ready: true } : null;
  }
  const entry = d.chatList().find(m => m.id === b.id);
  if (!entry) return null;
  if (!cached) {
    const c = await candidate(ref);
    if (!c.ready && !c.loadable) return null;
  }
  // Its own runner when it is loaded (two or more chat models can be), with the context it was started with.
  const r = d.runnerFor(b.id);
  const on = r?.view.state === 'connected';
  return { ref, label: `${entry.name} on this PC`, ctx: (on ? d.runOn(r!) : d.runOf(s, b.id)).ctx, params: paramsB(entry.name), ready: on };
}

/** Every worker jobs can use now: the connected model, each hire's own chat models, and every linked PC with a chat model loaded. */
async function workerPool(cached = false): Promise<seats.Seat[]> {
  const s = await d.store.settings();
  const chatIds = new Set(d.chatList().map(m => m.id));
  const refs = ['', ...chatHires().flatMap(m => brains.refsOf({ model: nowModel(m) ?? m.model, fallback: m.fallback })), ...s.remotes.filter(r => !r.backupsOnly).map(r => `remote:${r.id}`)];
  const got = await Promise.all([...new Set(refs.filter(r => r === '' || r.startsWith('remote:') || chatIds.has(r)))].map(r => seatOf(r, cached)));
  const out: seats.Seat[] = [];
  for (const x of got) if (x && !out.some(y => y.ref === x.ref)) out.push(x);
  return out;
}

// ---- The team of a job ----

/** The hires who chat (artists and designers draw; they are never a project manager, coder, writer or auditor). */
export const chatHires = (): StaffMember[] => d.staff.list().filter(m => !roleOf(m.role).kind);

/** A job's team as it stands: a hire who left goes back to the seat's default. */
export const teamOf = (job: { team?: Team } | null | undefined): Team => jobs.cleanTeam(job?.team ?? {}, chatHires().map(m => m.id));

const hireById = (id: string) => chatHires().find(m => m.id === id) ?? null;

/** The seat a hire works on now: the model that answers now first, as hireBrain picks. */
async function hireSeat(hire: StaffMember, cached = false): Promise<seats.Seat | null> {
  const refs = brains.refsOf({ model: nowModel(hire) ?? hire.model, fallback: hire.fallback });
  if (!refs.length) return seatOf('', cached);
  const xs = (await Promise.all(refs.map(r => seatOf(r, cached)))).filter((x): x is seats.Seat => !!x);
  return xs.find(x => x.ready) ?? xs[0] ?? null;
}

/**
 * Who does a seat's work: a hire, or (hire null) the strongest worker available. The project manager is the hire picked,
 * else the strongest worker; the coder and the writer are the hire picked, the hire in that role on Default, else the
 * project manager; auditing is the hire picked, else the strongest worker. Null: nobody (auditing not assigned).
 */
export function whoDoes(team: Team, seat: 'pm' | 'coder' | 'writer' | 'audit'): { hire: StaffMember | null; pm: boolean } | null {
  const pm = () => ({ hire: team.pm ? hireById(team.pm) : null, pm: true });
  if (seat === 'pm') return pm();
  const v = team[seat];
  if (seat === 'audit') return v === 'none' ? null : { hire: v === 'default' ? null : hireById(v), pm: false };
  if (v === 'none') return pm();
  if (v !== 'default') return { hire: hireById(v), pm: false };
  const own = chatHires().find(m => m.role === seat);
  return own ? { hire: own, pm: false } : pm();
}

/** The seat of whoever does it (see whoDoes), without loading anything. */
async function doerSeat(team: Team, seat: 'pm' | 'coder' | 'writer' | 'audit', cached = false): Promise<seats.Seat | null> {
  const who = whoDoes(team, seat);
  if (!who) return null;
  return who.hire ? hireSeat(who.hire, cached) : seats.strongest(await workerPool(cached));
}

/** The worker a step in this role belongs to (coder or writer), with the hire when it is one. */
async function ownSeat(team: Team, role: string, cached = false): Promise<seats.Seat | null> {
  return doerSeat(team, role === 'writer' ? 'writer' : 'coder', cached);
}

/**
 * The brain for a seat of a job, loading its model when it must: a hire answers on their own brains (with their
 * fallback), the strongest worker on its model. `forWhat` names it in the messages ("the project manager").
 */
export async function seatBrain(team: Team, seat: 'pm' | 'coder' | 'writer' | 'audit', forWhat: string, stage: (text: string) => void, signal: AbortSignal): Promise<{ brain: Brain; hire: StaffMember | null; intern: boolean }> {
  const who = whoDoes(team, seat);
  if (!who) throw new Error('Nobody is assigned to auditing on this job. Pick who audits under Roles, Auditing (in the job\'s Overview), then try again.');
  // What the seat's model answers from here on counts for the hire in it (or for nobody: the strongest worker).
  workAs(who.hire?.id);
  if (who.hire) {
    const got = await hireBrain(who.hire, stage, signal);
    return { brain: got.brain, hire: who.hire, intern: got.intern };
  }
  const best = seats.strongest(await workerPool());
  if (!best) throw new Error(`Nobody can be ${forWhat} now: no hire has a model that answers or fits, no chat model is connected and no linked PC answers. Hire staff (Settings, Set up, Staff) or connect a model, then try again.`);
  const got = await brainForRef(best.ref, forWhat, 'in the job\'s Overview (Roles)', stage, signal);
  stage(`${forWhat[0].toUpperCase()}${forWhat.slice(1)} is ${best.label}: the strongest worker available.`);
  return { brain: got.brain, hire: null, intern: false };
}

/** The doer of each seat in words, for the job's Overview: nothing is asked or loaded. */
export async function teamWords(team: Team): Promise<Record<'pm' | 'coder' | 'writer' | 'audit', string>> {
  const out = {} as Record<'pm' | 'coder' | 'writer' | 'audit', string>;
  for (const seat of ['pm', 'coder', 'writer', 'audit'] as const) {
    const who = whoDoes(team, seat);
    if (!who) { out[seat] = 'Nobody: no review and no end-of-job report on this job.'; continue; }
    const at = await doerSeat(team, seat, true);
    const name = who.hire ? who.hire.name.split(/\s+/)[0] : null;
    const pmToo = seat !== 'pm' && seat !== 'audit' && who.pm;
    out[seat] = `${pmToo ? 'The project manager: ' : ''}${name ? `${name}${at ? ` (${at.label})` : ' (no model answers now)'}` : at ? `${at.label}, the strongest worker available` : 'nobody yet: hire staff or connect a model'}.`;
  }
  return out;
}

async function fileSizes(job: Job, files: string[]): Promise<Record<string, number>> {
  const root = await jobRoot(job);
  const out: Record<string, number> = {};
  for (const f of files) {
    const r = await ws.read(root, f);
    out[f] = 'error' in r ? 0 : r.text.length;
  }
  return out;
}

/**
 * Sizes a step to its worker before it runs: a step that fits runs as it is; one too big is split into parts (saved
 * in the plan; the first part runs now) or moved to a worker it fits. `seat` is set when the step runs on another
 * worker than its own.
 */
export async function sizeStep(job: Job, i: number, send: Send): Promise<{ seat: seats.Seat | null } | { error: string }> {
  const step = job.steps[i];
  if (!jobs.workerRole(step)) return { seat: null };
  const team = teamOf(job);
  const own = await ownSeat(team, step.role);
  // No worker can answer now: the usual messages say why when the step asks for its brain.
  if (!own) return { seat: null };
  const pool = await workerPool();
  const hire = whoDoes(team, step.role === 'writer' ? 'writer' : 'coder')?.hire ?? null;
  const rooms = new Map<string, number>();
  for (const x of [own, ...pool]) if (!rooms.has(x.ref)) rooms.set(x.ref, seats.stepRoom(x.ctx, (await packetFront(job.id, x.ctx, hire, `${step.title} ${step.brief}`)).text.length));
  // "Big reading jobs" is retired (Auditing took its place): a fix across files stays with its own worker when it fits.
  const fit = seats.fitStep(step, await fileSizes(job, step.files), own, pool, x => rooms.get(x.ref) ?? 0, 'picked', job.steps.length);
  if (fit.kind === 'fits') return { seat: null };
  if (fit.kind === 'none') return { error: fit.why };
  if (fit.kind === 'move') {
    send('stage', { text: `Step ${i + 1} goes to ${fit.seat.label}: ${fit.why}.` });
    await addEvent(job.id, { type: 'moved', n: i, role: step.role, from: own.label, to: fit.seat.label, why: fit.why });
    return { seat: fit.seat };
  }
  job.steps.splice(i, 1, ...seats.splitStep(step, fit.groups));
  await saveJob(job);
  await addEvent(job.id, { type: 'split', n: i, parts: fit.groups.length, files: fit.groups, worker: own.label, room: rooms.get(own.ref) ?? 0 });
  send('stage', { text: `Step ${i + 1} is too big for ${own.label} in one go, so it is now ${fit.groups.length} steps (${fit.groups.map(g => g.join(' + ')).join('; ')}). Running the first.` });
  send('resized', await jobView(job));
  return { seat: null };
}

/** Where a worker runs, for the queue (src/queue.ts): 'pc:<id>' for a linked PC, else 'here'. */
export const laneOfRef = (ref: string) => {
  const b = brains.parseRef(ref);
  return b.kind === 'remote' ? `pc:${b.pc}` : 'here';
};

/**
 * The PC a job's next waiting step runs on, from what linked PCs said last (nothing is asked or loaded): null for a
 * picture step (the queue draws it) or when no step is left. `skip`: a step counted as done already (its picture came
 * back; the queue marks it done as the project goes on).
 */
export async function nextLane(job: Job, skip = -1): Promise<string | null> {
  const i = job.steps.findIndex((s, k) => s.status === 'todo' && k !== skip);
  if (i < 0 || !jobs.workerRole(job.steps[i])) return null;
  const seat = await ownSeat(teamOf(job), job.steps[i].role, true);
  return seat ? laneOfRef(seat.ref) : 'here';
}

/** The PC a project's plan is made on (its project manager's), from what linked PCs said last: nothing is asked or loaded. */
export async function planLane(rawTeam: unknown): Promise<string> {
  const seat = await doerSeat(jobs.cleanTeam(rawTeam ?? {}, chatHires().map(m => m.id)), 'pm', true);
  return seat ? laneOfRef(seat.ref) : 'here';
}

/** What the planner is told about the workers: the coder's and the writer's limit per step. */
export async function workersFor(id: string, goal: string, cards: { scope: string; design: string } | null, team: Team): Promise<{ text: string; rooms: Record<string, number> }> {
  const lines: { who: string; seat: seats.Seat; room: number }[] = [];
  const rooms: Record<string, number> = {};
  for (const role of ['coder', 'writer'] as const) {
    const own = await ownSeat(team, role);
    if (!own) continue;
    const hire = whoDoes(team, role)?.hire ?? null;
    const room = seats.stepRoom(own.ctx, (await packetFront(id, own.ctx, hire, goal, cards)).text.length);
    rooms[role] = room;
    lines.push({ who: `The ${role}${hire ? ` (${hire.name.split(/\s+/)[0]})` : ''}`, seat: own, room });
  }
  return { text: seats.workersLine(lines), rooms };
}

// ---- What the Jobs window needs to draw the team, and the worker PCs ----

export async function setup() {
  return {
    tests: Object.entries(TESTS).map(([id, t]) => ({ id, label: t.label })),
    share: shareView(),
    // The hires who can take a seat (the Project manager, Coder, Writer, Auditing): their id, name and role.
    staff: chatHires().map(m => ({ id: m.id, name: m.name, role: roleOf(m.role).name })),
  };
}
