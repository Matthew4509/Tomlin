// A job on disk: its plan, the step waiting for the person, its events (the room), and the packet each worker reads.
import { stamp } from '../folders.ts';
import { appendFile, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import * as jobs from '../jobs.ts';
import type { Job } from '../jobs.ts';
import * as ws from '../workspace.ts';
import * as home from '../home.ts';
import * as memory from '../memory.ts';
import * as seats from '../seats.ts';
import type { StaffMember } from '../staff.ts';
import { writeAtomic } from '../atomic.ts';
import { type NewEvent, d } from './shared.ts';
import { teamOf, teamWords } from './sizing.ts';
import type { Brain, StepResult } from '../jobrun.ts';

/** The folder a job's files are in: its project folder inside the workspace (made when missing), or the workspace. */
export async function jobRoot(job: { folder?: string } | null | undefined): Promise<string> {
  const w = await d.workspaceDir();
  const f = job?.folder ? jobs.cleanProjectFolder(job.folder) : null;
  if (!f) return w;
  const full = join(w, ...f.split('/'));
  await mkdir(full, { recursive: true });
  // A project folder that is a link (junction or symlink) to somewhere else would carry every write out of the workspace.
  const [base, real] = await Promise.all([realpath(w), realpath(full)]);
  if (real !== base && !real.startsWith(base + sep)) throw new Error(`The project folder "${f}" is a link to a folder outside the workspace, so nothing is read or saved there. Move the project into the workspace, or pick that folder as the workspace.`);
  return full;
}

// ---- The plan on disk ----

export async function loadJob(id: unknown): Promise<Job | null> {
  if (!jobs.validId(id)) return null;
  const r = await ws.read(await d.workspaceDir(), jobs.planPath(id));
  if ('error' in r) return null;
  try {
    const job = JSON.parse(r.text) as Job;
    return job && job.id === id && Array.isArray(job.steps) ? job : null;
  } catch {
    return null;
  }
}

export async function saveJob(job: Job): Promise<void> {
  job.updated = new Date().toISOString();
  const r = await ws.save(await d.workspaceDir(), jobs.planPath(job.id), JSON.stringify(job, null, 2));
  if ('error' in r) throw new Error(r.error);
}

// ---- A step that came back and waits for the person: kept on disk, so Home and the job still show it after a reload ----

const waitingFile = async (id: string) => join(await d.workspaceDir(), 'jobs', id, 'waiting.json');

export async function loadWaiting(id: string): Promise<{ n: number; at: string; result: StepResult } | null> {
  try {
    const w = JSON.parse(await readFile(await waitingFile(id), 'utf8'));
    return w && Number.isInteger(w.n) && w.result && Array.isArray(w.result.files) ? w : null;
  } catch {
    return null;
  }
}

export async function saveWaiting(id: string, n: number, result: StepResult): Promise<void> {
  const file = await waitingFile(id);
  await writeAtomic(file, JSON.stringify({ n, at: new Date().toISOString(), result }));
}

export const clearWaiting = async (id: string) => rm(await waitingFile(id), { force: true }).catch(() => undefined);

// ---- The job's events: appended by code as things happen; the job room is replayed from them ----

const eventsFile = async (id: string) => join(await d.workspaceDir(), 'jobs', id, 'events.jsonl');

export async function loadEvents(id: string): Promise<home.JobEvent[]> {
  const text = await readFile(await eventsFile(id), 'utf8').catch(() => '');
  const out: home.JobEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.type === 'string' && typeof e.at === 'string') out.push((e.type === 'step' || e.type === 'result' || e.type === 'review') && !Array.isArray(e.notes) ? { ...e, notes: [] } : e);
    } catch {
      // A line cut short by a crash is skipped; the rest of the room still shows.
    }
  }
  return out;
}

/** Adds one event. A failure to write it never stops the job: the room is a record, the plan file is the state. */
export async function addEvent(id: string, e: NewEvent): Promise<void> {
  try {
    const file = await eventsFile(id);
    await mkdir(join(file, '..'), { recursive: true });
    const full = { at: new Date().toISOString(), ...e };
    await appendFile(file, `${JSON.stringify(full)}\n`);
    d.onEvent?.(id, full as home.JobEvent);
  } catch {
    // ignored on purpose (see above)
  }
}

export const left = (job: Job) => job.steps.filter(s => s.status === 'todo').length;

/** Every job in the workspace, newest first, read once. */
export async function allJobs(): Promise<Job[]> {
  const names = await readdir(join(await d.workspaceDir(), 'jobs')).catch(() => [] as string[]);
  const out: Job[] = [];
  for (const id of names.filter(jobs.validId)) {
    const job = await loadJob(id);
    if (job) out.push(job);
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 30);
}

export async function listJobs() {
  return (await allJobs()).map(job => ({ id: job.id, name: job.name ?? '', folder: job.folder ?? '', goal: job.goal, steps: job.steps.length, done: job.steps.filter(s => s.status !== 'todo').length, updated: job.updated, hidden: job.hidden === true }));
}

/** The job folder's web files as they would be after saving `proposed`, for the cross-file check. */
export async function webFiles(root: string, proposed: { path: string; text: string }[] = []): Promise<Record<string, string>> {
  const web: Record<string, string> = {};
  for (const f of (await ws.list(root)).filter(f => /\.(html?|m?js|css)$/i.test(f.path) && !f.path.startsWith('jobs/')).slice(0, 40)) {
    const r = await ws.read(root, f.path);
    if (!('error' in r)) web[f.path] = r.text;
  }
  for (const f of proposed) web[f.path] = f.text;
  return web;
}

/** The plan plus how many model swaps the waiting steps need and about how long the loading takes. */
export async function jobView(job: Job) {
  const s = await d.store.settings();
  const team = teamOf(job);
  const doers = await teamWords(team);
  // Each kind of step's model on this PC when a hire does it (the strongest worker is left out: it is picked at the run).
  const local = (role: string) => {
    const m = whoModel(team, role);
    return m && !m.startsWith('remote:') && d.chatList().some(x => x.id === m) ? m : '';
  };
  // A model already loaded in a runner of its own (two or more chat models can be) needs no load.
  const swaps = jobs.swapCount(job.steps, d.chat.view.state === 'connected' ? d.chat.view.model : null, role => (d.runnerFor(local(role))?.view.state === 'connected' ? '' : local(role)));
  const seconds = swaps.loads.reduce((t, id) => t + (s.loadSeconds[`chat:${id}`] ?? Math.round((d.chatList().find(m => m.id === id)?.bytes ?? 0) / (150 * 2 ** 20)) + 4), 0);
  // The plan against the Scope card, by code: every F-number named is on the card, every one on the card is planned.
  const cards = await jobCards(job.id);
  return { job, team, doers, cards, swaps: swaps.swaps, swapSeconds: Math.round(seconds), names: swaps.loads.map(id => d.chatList().find(m => m.id === id)?.name ?? id), scopeChecks: cards ? seats.fnCheck(job.steps, cards.scope) : [] };
}

/** The first-choice model of the hire who does a kind of step on this team ('' for the strongest worker). */
function whoModel(team: jobs.Team, role: string): string {
  const seat = role === 'writer' ? team.writer : team.coder;
  const pick = seat === 'none' ? team.pm : seat === 'default' ? '' : seat;
  if (seat === 'none' && !pick) return '';
  const hire = d.staff.list().find(m => (pick ? m.id === pick : m.role === role)) ?? (seat === 'default' && team.pm ? d.staff.list().find(m => m.id === team.pm) : undefined);
  return hire?.model ?? '';
}

/** A project saved by Start project or made on Home: its cards go to the planner first; the plan keeps its id, name, folder and team. */
export async function projectCards(id: unknown): Promise<{ id: string; goal: string; cards: { scope: string; design: string }; name: string; folder: string; team: unknown } | { error: string }> {
  if (!jobs.validId(id)) return { error: 'There is no such project in this workspace.' };
  const root = await d.workspaceDir();
  if (!('error' in (await ws.read(root, jobs.planPath(id))))) return { error: 'This project already has a plan: open it in Jobs.' };
  const [scope, design, meta] = await Promise.all(['scope.md', 'design.md', 'project.json'].map(f => ws.read(root, `jobs/${id}/${f}`)));
  if ('error' in scope || 'error' in design || 'error' in meta) return { error: 'That project is missing its Scope card or design brief: start it again from Home.' };
  let p: Record<string, unknown> & { answers?: { statement?: unknown } };
  try {
    p = JSON.parse(meta.text);
  } catch {
    return { error: 'That project\'s project.json is damaged: start it again from Home.' };
  }
  // Made on Home: the prompt is the goal; from Start project: the idea said back in one line.
  const goal = String(p.prompt || p.about || p.answers?.statement || '').slice(0, 1500);
  return { id, goal, cards: { scope: scope.text, design: design.text }, name: String(p.name ?? ''), folder: jobs.cleanProjectFolder(p.folder) ?? '', team: p.team ?? null };
}

/** A job's Scope card and design brief, when it came from Start project (the job folder is the project folder). */
async function jobCards(id: string): Promise<{ scope: string; design: string } | null> {
  const root = await d.workspaceDir();
  const [scope, design] = await Promise.all(['scope.md', 'design.md'].map(f => ws.read(root, `jobs/${id}/${f}`)));
  return 'error' in scope || 'error' in design ? null : { scope: scope.text, design: design.text };
}

/**
 * The front of a job packet, sized to the model that receives it: the Scope card and design brief first, then the
 * team notebook and (for a step a hire runs) that hire's own notebook.
 */
export async function packetFront(id: string, ctx: number, hire: StaffMember | null, topic: string, cards?: { scope: string; design: string } | null): Promise<memory.Front> {
  const [c, team, own] = await Promise.all([cards !== undefined ? cards : jobCards(id), d.notebooks.read('team'), hire ? d.notebooks.read(`staff:${hire.id}`) : null]);
  return memory.jobFront(ctx, c, team, own, topic, hire ? `${hire.name.split(/\s+/)[0]}'s memory` : undefined);
}

/**
 * The handoff card: what the worker of a step is given, written by code before the step runs and saved in the job
 * folder (jobs/<id>/<date and time> handoff-step-<n>.md, so they sort by time), so anyone can open the folder and see it. The file texts are shown as
 * their sizes only (the files themselves are in the workspace).
 */
/** "2026-10-04 11:50" in this PC's own time. */
function localStamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

export async function saveHandoff(job: Job, i: number, brain: Brain, parts: memory.Part[], system: string, user: string): Promise<void> {
  const step = job.steps[i];
  const body = user.replace(/=== FILE: (.+?) ===\n([\s\S]*?)\n=== END FILE ===/g, (_m, path: string, text: string) => `=== FILE: ${path} === [the current file, ${text.length.toLocaleString()} characters] === END FILE ===`);
  const table = parts.length ? parts.map(p => `| ${p.label} | ${p.chars.toLocaleString()} | ${p.state}${p.note ? ` (${p.note})` : ''} |`).join('\n') : '| Nothing (no project cards, notebooks empty) | 0 | none |';
  const card = [
    `# Handoff card: step ${i + 1} of ${job.steps.length}, ${step.title}`,
    `Written by TOMLIN (by code, not by a model) on ${localStamp()}, for ${brain.label} (context ${brain.ctx.toLocaleString()} tokens). Below is what the worker reads; the worker keeps nothing after the step.`,
    `## The front of the packet\n\n| Part | Characters | Sent |\n|---|---|---|\n${table}`,
    `## The instructions (system)\n\n${system}`,
    `## The step (message)\n\n${body}`,
  ].join('\n\n');
  await ws.save(await d.workspaceDir(), `jobs/${job.id}/${stamp()} handoff-step-${i + 1}.md`, `${card}\n`).catch(() => undefined);
}
