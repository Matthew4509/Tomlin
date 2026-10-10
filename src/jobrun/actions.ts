// The job actions the page starts (plan, step, LETS GO!!! = run the rest, review, report, changes, tests), one at a time, and Home's lists.
import type { ServerResponse } from 'node:http';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as jobs from '../jobs.ts';
import type { Job } from '../jobs.ts';
import * as ws from '../workspace.ts';
import * as folders from '../folders.ts';
import { runTests, syntaxCheck } from '../checks.ts';
import { checkMessage, REFUSAL } from '../filter.ts';
import * as home from '../home.ts';
import * as seats from '../seats.ts';
import { log } from '../log.ts';
import { inScope } from '../meter.ts';
import { type Send, d } from './shared.ts';
import { chatHires, seatBrain, teamOf, workersFor } from './sizing.ts';
import { addEvent, allJobs, clearWaiting, jobView, left, jobRoot, loadEvents, loadJob, loadWaiting, packetFront, projectCards, saveJob, saveWaiting, webFiles } from './jobfiles.ts';
import { acceptStep, doStep, reviewStep } from './steps.ts';

let busy = false;
/** A job action is running here (a step, Run the rest, a plan, tests, or a change to a plan being saved). */
export const actionBusy = () => busy;
/** What the one running job action is doing, for "Working now" on Home. */
let running: home.Running | null = null;

// ---- Event streams ----

/** Takes the one job action (null when one runs): its events go to `write`, and Home reads the stage words from them. */
function begin(what: Omit<home.Running, 'stage' | 'startedAt'>, write: Send): { send: Send; end: () => void } | null {
  if (busy) return null;
  busy = true;
  const now: home.Running = { ...what, stage: '', startedAt: Date.now() };
  running = now;
  return {
    send: (event, data) => {
      // Home reads the stage words and the step from the same events the job window gets.
      const x = data as { text?: string; n?: number; title?: string };
      if (event === 'stage' && typeof x.text === 'string') now.stage = x.text;
      if (event === 'step' && typeof x.n === 'number') Object.assign(now, { n: x.n, title: String(x.title ?? ''), stage: '', startedAt: Date.now() });
      if (event === 'error') log.error('job', x.text);
      if (event === 'stopped') log.warn('job', (data as { reason?: string }).reason);
      write(event, data);
    },
    end: () => { busy = false; running = null; },
  };
}

/** "Another job action is still running", saying which: its job by its goal, and what it is doing. */
export function busyWordsFor(r: Pick<home.Running, 'kind' | 'jobId' | 'goal' | 'n'> | null): string {
  if (!r) return 'Another job action is still running. Wait for it, or press Stop.';
  const goal = r.goal.length > 80 ? `${r.goal.slice(0, 77)}…` : r.goal;
  const doing = { plan: 'making its plan', step: r.n === null ? 'working on a step' : `working on step ${r.n + 1}`, run: 'running', review: r.n === null ? 'checking a step' : `checking step ${r.n + 1}`, final: 'writing its report' }[r.kind];
  return r.jobId ? `Another job is still running: "${goal}" (${doing}). Wait for it, or open it and press Stop.` : `Another job is still running: "${goal}" (${doing}). Wait for it to finish, or press Stop under it.`;
}

/** Opens an event stream for a long job action; one at a time. Null (already answered) when busy. */
function stream(res: ServerResponse, what: Omit<home.Running, 'stage' | 'startedAt'>, busyWords = ''): { send: Send; signal: AbortSignal; end: () => void } | null {
  const was = running;
  const b = begin(what, (event, data) => { if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); });
  if (!b) {
    // LETS GO!!! while another project works: the page offers to add it to the queue (src/server/queue.ts). The job
    // that is working is named, and sent, so the page can offer to open it (its Stop is there).
    d.json(res, 409, { error: busyWords || busyWordsFor(was), ...(was?.jobId ? { running: { jobId: was.jobId, goal: was.goal } } : {}), ...(what.kind === 'run' ? { queue: true } : {}) });
    return null;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', ...d.headers });
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  return { send: b.send, signal: ac.signal, end: () => { b.end(); res.end(); } };
}

/** What a plan is made from: the project's cards (Start project, Home), or a goal typed in the Jobs window. */
async function planAsk(b: Record<string, unknown>): Promise<{ error: string } | { fromProject: Awaited<ReturnType<typeof projectCards>> | null; goal: string; team: jobs.Team; folder: string }> {
  const fromProject = b.project ? await projectCards(b.project) : null;
  if (fromProject && 'error' in fromProject) return { error: fromProject.error };
  const goal = fromProject ? fromProject.goal : String(b.goal ?? '').replace(/\r/g, '').trim().slice(0, 1500);
  if (!goal) return { error: 'Type the goal first: what should exist when the job is finished?' };
  const verdict = checkMessage(goal, { recent: [] });
  if (!verdict.ok) return { error: REFUSAL[verdict.reason] };
  // Who plans: the project's own pick (Home's Staff row), else this plan's (the Jobs window), else the strongest worker.
  const hires = chatHires().map(m => m.id);
  const team = jobs.cleanTeam(b.team ?? {}, hires, jobs.cleanTeam(fromProject?.team ?? {}, hires));
  return { fromProject, goal, team, folder: fromProject ? fromProject.folder : '' };
}

export async function plan(res: ServerResponse, b: Record<string, unknown>) {
  const a = await planAsk(b);
  if ('error' in a) return d.json(res, 400, { error: a.error });
  const st = stream(res, { kind: 'plan', jobId: null, goal: a.goal, n: null, title: '', role: 'planner' });
  if (!st) return;
  try {
    await planNow(a, st.send, st.signal);
  } finally {
    st.end();
  }
}

/** A project saved without a plan, from the queue: planned with no page open (then the queue runs its steps). */
export async function planQueued(id: string, signal: AbortSignal, write: Send): Promise<{ ok: true } | { error: string } | { busy: true }> {
  const a = await planAsk({ project: id });
  if ('error' in a) return a;
  const b = begin({ kind: 'plan', jobId: id, goal: a.goal, n: null, title: '', role: 'planner' }, write);
  if (!b) return { busy: true };
  try {
    let fault = '';
    await inScope({ project: id, queue: true }, () => planNow(a, (event, data) => {
      if (event === 'error') fault = String((data as { text?: unknown }).text ?? '');
      b.send(event, data);
    }, signal));
    return fault ? { error: fault } : { ok: true };
  } finally {
    b.end();
  }
}

async function planNow(a: { fromProject: Awaited<ReturnType<typeof projectCards>> | null; goal: string; team: jobs.Team; folder: string }, send: Send, signal: AbortSignal): Promise<void> {
  const fromProject = a.fromProject && !('error' in a.fromProject) ? a.fromProject : null;
  const { goal, team, folder } = a;
  const st = { send, signal };
  try {
    const got = await seatBrain(team, 'pm', 'the project manager', text => st.send('stage', { text }), st.signal);
    const brain = got.brain;
    const all = (await ws.list(await jobRoot({ folder }))).filter(f => (folder || !f.path.startsWith('jobs/')) && !folders.keptFromModels(f.path));
    // The specialists' handed-in work is read from their folders, newest first (src/folders.ts); the rest as before.
    const handed = folders.handedIn(all);
    const listed = all.filter(f => !handed.some(h => h.path === f.path) && !f.path.endsWith('.bak'));
    const cards = fromProject ? fromProject.cards : null;
    const front = await packetFront('', brain.ctx, got.hire, goal, cards);
    // Every worker's limit per step and every file's size, so the planner can size the steps.
    const workers = await workersFor(fromProject ? fromProject.id : '', goal, cards, team);
    // A Scope card with functions (Start project) has them planned in order; one made on Home holds the person's own words.
    const fns = cards && /^F\d+\./m.test(cards.scope);
    const ask = `${front.text ? `${front.text}\n\n` : ''}The goal: ${goal}${fns ? '\nPlan the functions F1, F2, … in order, name the F-number in each step\'s title, and follow the design brief for every page.' : cards ? '\nFollow the design brief for every page.' : ''}`;
    const text = await brain.ask(jobs.planSystem(listed.map(f => `${f.path} (${f.bytes.toLocaleString()} characters)`), workers.text, folders.handedInLines(handed)), ask, 1500, t => st.send('text', { text: t }), st.signal);
    // A writer's new text files go in specialists/writer, named with the date and time, by code (small models forget).
    const parsed = folders.writerHandIn(jobs.parsePlan(text), new Set(all.map(f => f.path))).steps;
    if (!parsed.length) throw new Error('The model did not give a plan in steps. Try again, say the goal more plainly, or choose a bigger model for the planner.');
    // Steps whose files already exist and are too big for their worker are split now, by code.
    const sizes = Object.fromEntries(listed.map(f => [f.path, f.bytes]));
    const sized = seats.sizePlan(parsed, sizes, s => {
      const r = jobs.workerRole(s);
      return r ? workers.rooms[r] ?? null : null;
    });
    const steps = sized.steps;
    const now = new Date();
    const job: Job = { id: fromProject ? fromProject.id : jobs.jobId(now), goal, created: now.toISOString(), updated: '', notes: '', steps, team, ...(fromProject?.name ? { name: fromProject.name } : {}), ...(folder ? { folder } : {}) };
    await saveJob(job);
    await addEvent(job.id, { type: 'plan', steps: steps.length, worker: brain.label, ...(sized.split.length ? { split: sized.split } : {}) });
    st.send('done', { ...(await jobView(job)), planner: brain.label });
  } catch (e) {
    st.send('error', { text: (e as Error).message });
  }
}

export async function step(res: ServerResponse, b: Record<string, unknown>) {
  const job = await loadJob(b.id);
  if (!job) return d.json(res, 404, { error: 'There is no such job in this workspace.' });
  const i = Number(b.n);
  if (job.steps[i]?.status !== 'todo') return d.json(res, 409, { error: 'That step is not waiting to be done.' });
  const st = stream(res, { kind: 'step', jobId: job.id, goal: job.goal, n: i, title: job.steps[i].title, role: job.steps[i].role });
  if (!st) return;
  try {
    await clearWaiting(job.id);
    const r = await doStep(job, i, st.send, st.signal);
    if ('error' in r) st.send('error', { text: r.error });
    else {
      await saveWaiting(job.id, i, r.result);
      st.send('done', r.result);
    }
  } catch (e) {
    // A file that could not be written ends the step with words, not a window left half way.
    st.send('error', { text: `The step could not be saved: ${(e as Error).message}. Nothing was changed in your files: press Save again, or run the step again.` });
  } finally {
    st.end();
  }
}

/** How a run of the waiting steps ended: all done, stopped at a step (that needs the person, or a fault), or at a picture. */
export type RunOutcome = ({ kind: 'finished' } | { kind: 'stopped'; n: number; reason: string; needs: boolean } | { kind: 'picture'; n: number; title: string; brief: string; role: string } | { kind: 'error'; text: string }) & { saved: number };

/** Runs the waiting steps one after another, saving each one whose checks all pass, and stops at the first that needs the person. */
export async function runRest(res: ServerResponse, b: Record<string, unknown>) {
  const first = await loadJob(b.id);
  if (!first) return d.json(res, 404, { error: 'There is no such job in this workspace.' });
  const st = stream(res, { kind: 'run', jobId: first.id, goal: first.goal, n: null, title: '', role: null }, 'Another project is working now. Add this one to the queue: it starts by itself when that one is done.');
  if (!st) return;
  try {
    await runSteps(first.id, b.review === true, st.send, st.signal, false);
  } finally {
    st.end();
  }
}

/**
 * LETS GO!!! for the queue (src/server/queue.ts): the same run with no page open. A picture step ends the run (the
 * queue draws it, marks the step done and runs the project again). `busy`: another job action runs now.
 */
export async function runQueued(id: string, review: boolean, signal: AbortSignal, write: Send): Promise<RunOutcome | { busy: true }> {
  const job = await loadJob(id);
  if (!job) return { kind: 'error', text: 'That project is not in this workspace any more.', saved: 0 };
  const b = begin({ kind: 'run', jobId: job.id, goal: job.goal, n: null, title: '', role: null }, write);
  if (!b) return { busy: true };
  try {
    return await inScope({ project: job.id, queue: true }, () => runSteps(job.id, review, b.send, signal, true));
  } finally {
    b.end();
  }
}

async function runSteps(id: string, review: boolean, send: Send, signal: AbortSignal, queued: boolean): Promise<RunOutcome> {
  let saved = 0;
  try {
    await clearWaiting(id);
    for (let guard = 0; guard < jobs.MAX_STEPS; guard++) {
      const job = await loadJob(id);
      if (!job) return { kind: 'error', text: 'That project is not in this workspace any more.', saved };
      const i = jobs.nextIndex(job);
      if (i < 0) {
        send('finished', await jobView(job));
        return { kind: 'finished', saved };
      }
      const s = job.steps[i];
      if (running) running.role = s.role;
      send('step', { n: i, title: s.title });
      if (!jobs.workerRole(s)) {
        if (queued) return { kind: 'picture', n: i, title: s.title, brief: s.brief, role: s.role, saved };
        const last = (await loadEvents(job.id)).at(-1);
        if (!(last?.type === 'picture' && last.n === i)) await addEvent(job.id, { type: 'picture', n: i, title: s.title, role: s.role });
        send('stopped', { n: i, reason: `Step ${i + 1} is a picture: draw it in an artist's chat, press Mark done, then LETS GO!!! again.`, ...(await jobView(job)) });
        return { kind: 'stopped', n: i, reason: `Step ${i + 1} is a picture.`, needs: true, saved };
      }
      const r = await doStep(job, i, send, signal);
      if ('error' in r) {
        send('stopped', { n: i, reason: r.error, ...(await jobView(job)) });
        return { kind: 'stopped', n: i, reason: r.error, needs: false, saved };
      }
      const result = r.result;
      const blockers = [...result.problems, ...result.warnings];
      if (review && !blockers.length) {
        const rv = await reviewStep(job, i, result.files, [], send, signal);
        if ('error' in rv) {
          await saveWaiting(job.id, i, result);
          send('stopped', { n: i, reason: rv.error, result, ...(await jobView(job)) });
          return { kind: 'stopped', n: i, reason: rv.error, needs: true, saved };
        }
        result.review = rv;
        if (rv.ok !== true) blockers.push(...(rv.ok === null ? ['The reviewer did not give a clear OK.'] : rv.problems.map(p => `Reviewer: ${p}`)));
      }
      if (blockers.length) {
        await saveWaiting(job.id, i, result);
        const reason = `Step ${i + 1} needs you: ${blockers.length === 1 ? blockers[0] : `${blockers.length} things to look at.`}`;
        send('stopped', { n: i, reason, result, blockers, ...(await jobView(job)) });
        return { kind: 'stopped', n: i, reason, needs: true, saved };
      }
      const kept = await acceptStep(job, i, result.files, result.summary, true, result.base);
      if ('error' in kept) {
        await saveWaiting(job.id, i, result);
        send('stopped', { n: i, reason: kept.error, result, ...(await jobView(job)) });
        return { kind: 'stopped', n: i, reason: kept.error, needs: true, saved };
      }
      saved++;
      send('saved', { n: i, title: job.steps[i].title, files: result.files.map(f => f.path), summary: result.summary, tries: result.tries, worker: result.worker, ...(await jobView(kept.job)) });
    }
    return { kind: 'error', text: `Stopped after ${jobs.MAX_STEPS} steps.`, saved };
  } catch (e) {
    send('error', { text: (e as Error).message });
    return { kind: 'error', text: (e as Error).message, saved };
  }
}

export async function review(res: ServerResponse, b: Record<string, unknown>) {
  const job = await loadJob(b.id);
  if (!job) return d.json(res, 404, { error: 'There is no such job in this workspace.' });
  const i = Number(b.n);
  const s = job.steps[i];
  if (!s) return d.json(res, 404, { error: 'There is no such step.' });
  const files = (Array.isArray(b.files) ? b.files : []).map(f => ({ path: ws.cleanPath((f as Record<string, unknown>)?.path), text: String((f as Record<string, unknown>)?.text ?? '') })).filter((f): f is { path: string; text: string } => !!f.path && s.files.includes(f.path));
  const st = stream(res, { kind: 'review', jobId: job.id, goal: job.goal, n: i, title: s.title, role: 'reviewer' });
  if (!st) return;
  try {
    const findings = [...jobs.crossCheck(await webFiles(await jobRoot(job), files)), ...(await syntaxCheck(files)).filter(c => !c.ok).map(c => `${c.path} (${c.tool}): ${c.message.split('\n')[0]}`)];
    const rv = await reviewStep(job, i, files, findings, st.send, st.signal);
    if ('error' in rv) st.send('error', { text: rv.error });
    else {
      // The reviewer's answer is kept with the waiting result, so it is still there after a reload.
      const w = await loadWaiting(job.id);
      if (w && w.n === i) await saveWaiting(job.id, i, { ...w.result, review: rv });
      st.send('done', rv);
    }
  } catch (e) {
    st.send('error', { text: `The review stopped: ${(e as Error).message}. Press Review again.` });
  } finally {
    st.end();
  }
}

/** The end-of-job report, written by the reviewer from the plan, the notes and every check; saved as jobs/<id>/review.md. */
export async function finalReview(res: ServerResponse, b: Record<string, unknown>) {
  const job = await loadJob(b.id);
  if (!job) return d.json(res, 404, { error: 'There is no such job in this workspace.' });
  const st = stream(res, { kind: 'final', jobId: job.id, goal: job.goal, n: null, title: '', role: 'reviewer' });
  if (!st) return;
  try {
    const root = await jobRoot(job);
    const wrote = [...new Set(job.steps.flatMap(s => s.wrote))];
    const texts: { path: string; text: string }[] = [];
    for (const p of wrote) {
      const r = await ws.read(root, p);
      if (!('error' in r)) texts.push(r);
    }
    const checks = await syntaxCheck(texts);
    const findings = [
      ...jobs.crossCheck(await webFiles(root)),
      ...checks.filter(c => !c.ok).map(c => `${c.path} (${c.tool}) fails: ${c.message.split('\n')[0]}`),
      ...checks.filter(c => c.ok).map(c => `${c.path} passes ${c.tool}`),
      ...(job.tests ? [`Tests (${job.tests.label}) ${job.tests.ok ? 'passed' : 'failed'} on ${job.tests.at.slice(0, 16).replace('T', ' ')}`] : ['No tests were run.']),
    ];
    const brain = (await seatBrain(teamOf(job), 'audit', 'the auditor', text => st.send('stage', { text }), st.signal)).brain;
    st.send('stage', { text: `The auditor (${brain.label}) is writing the report…` });
    const listed = (await ws.list(root)).filter(f => !f.path.startsWith('jobs/') && !f.path.endsWith('.bak') && !folders.keptFromModels(f.path));
    const handed = folders.handedIn(listed);
    const files = listed.map(f => f.path).filter(p => !handed.some(h => h.path === p));
    const front = await packetFront(job.id, brain.ctx, null, job.goal);
    const text = await brain.ask(jobs.JOB_REVIEW_SYSTEM, jobs.jobReviewUser(job, findings, files, front.text, folders.handedInLines(handed)), 700, t => st.send('text', { text: t }), st.signal);
    const report = `# Job report\n\nGoal: ${job.goal}\n\nWritten by ${brain.label} on ${new Date().toISOString().slice(0, 16).replace('T', ' ')}. A model wrote this: check it against the files.\n\n${text.trim()}\n\n## Checks made by code\n\n${findings.map(f => `- ${f}`).join('\n')}\n`;
    const path = `jobs/${job.id}/review.md`;
    const saved = await ws.save(await d.workspaceDir(), path, report);
    if ('error' in saved) throw new Error(saved.error);
    await addEvent(job.id, { type: 'report', path });
    st.send('done', { text, findings, path });
  } catch (e) {
    st.send('error', { text: (e as Error).message });
  } finally {
    st.end();
  }
}

/** A change to a plan: one at a time, and never while a step runs (each would save the plan over the other's). */
export async function change(b: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (busy) return { status: 409, body: { error: 'A step is running. Wait for it, or press Stop, then change the plan.' } };
  busy = true;
  try {
    return await changeNow(b);
  } finally {
    busy = false;
  }
}

async function changeNow(b: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const job = await loadJob(b.id);
  if (!job) return { status: 404, body: { error: 'There is no such job in this workspace.' } };
  const i = Number(b.n);
  const step = job.steps[i];
  if (b.action === 'edit') {
    const steps = jobs.applyEdit(job, b.steps);
    if ('error' in steps) return { status: 400, body: steps };
    job.steps = steps;
    // The step numbers may have moved: a waiting result no longer belongs to its step.
    await clearWaiting(job.id);
    await addEvent(job.id, { type: 'edit', steps: steps.length });
  } else if (b.action === 'accept') {
    const w = await loadWaiting(job.id);
    const r = await acceptStep(job, i, Array.isArray(b.files) ? (b.files as { path?: unknown; text?: unknown }[]) : [], b.summary, false, w?.n === i ? w.result.base : undefined);
    if (!('error' in r)) await clearWaiting(job.id);
    return 'error' in r ? { status: r.status, body: { error: r.error } } : { status: 200, body: await jobView(r.job) };
  } else if (b.action === 'discard') {
    const w = await loadWaiting(job.id);
    await clearWaiting(job.id);
    if (w) await addEvent(job.id, { type: 'discard', n: w.n });
    return { status: 200, body: await jobView(job) };
  } else if (b.action === 'mark') {
    if (!step) return { status: 404, body: { error: 'There is no such step.' } };
    if ((await loadWaiting(job.id))?.n === i) await clearWaiting(job.id);
    const to = b.status === 'done' || b.status === 'skipped' ? b.status : 'todo';
    if (to !== 'todo' && step.status !== 'todo') return { status: 409, body: { error: 'That step is already finished.' } };
    step.status = to;
    if (to === 'todo') job.notes = jobs.dropNote(job.notes, i + 1);
    if (to === 'done') {
      step.summary = String(b.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
      job.notes = jobs.addNote(job.notes, i + 1, step.title, step.summary || 'done by hand.');
    }
    await addEvent(job.id, { type: 'mark', n: i, status: to, left: left(job) });
  } else if (b.action === 'delete') {
    // For good: the job's own folder goes (its plan, room, notes, handoffs and review). Files its steps wrote elsewhere
    // in the workspace stay: they are the person's work, not the job's.
    if (running?.jobId === job.id) return { status: 409, body: { error: 'This job is running. Press Stop first, then delete it.' } };
    await rm(join(await d.workspaceDir(), 'jobs', job.id), { recursive: true, force: true });
    return { status: 200, body: { deleted: job.id } };
  } else if (b.action === 'hide') {
    // Hidden, not deleted: the job's folder and the files its steps wrote stay in the workspace.
    if (running?.jobId === job.id) return { status: 409, body: { error: 'This job is running. Press Stop first, then hide it.' } };
    job.hidden = b.hidden !== false;
    if (!job.hidden) delete job.hidden;
  } else if (b.action === 'team') {
    // The job's Overview: the project manager, the three roles and the final audit's expectations.
    job.team = jobs.cleanTeam(b.team ?? {}, chatHires().map(m => m.id), teamOf(job));
  } else if (b.action === 'addfix') {
    if (!job.tests || job.tests.ok) return { status: 409, body: { error: 'There is no failed test run to fix.' } };
    if (job.steps.length >= jobs.MAX_STEPS) return { status: 409, body: { error: `A job has at most ${jobs.MAX_STEPS} steps. Remove a finished one's plan entry by starting a new job for the fix.` } };
    const root = await jobRoot(job);
    const files = (await ws.list(root)).map(f => f.path);
    // The failing test files' text, to find the code they test.
    const texts: Record<string, string> = {};
    for (const f of files.filter(f => !f.startsWith('jobs/') && job.tests!.output.includes(f.split('/').pop()!))) {
      const r = await ws.read(root, f);
      if (!('error' in r)) texts[f] = r.text;
    }
    job.steps.push(jobs.testFixStep(job, job.tests.label, job.tests.output, files, texts));
    await addEvent(job.id, { type: 'addfix', n: job.steps.length - 1 });
  } else return { status: 400, body: { error: 'TOMLIN does not know that job action: it is older than this page (it was updated while running). Close its window, start it again with Start TOMLIN.cmd, then try again.' } };
  await saveJob(job);
  return { status: 200, body: await jobView(job) };
}

export async function tests(b: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const job = await loadJob(b.id);
  if (!job) return { status: 404, body: { error: 'There is no such job in this workspace.' } };
  if (busy) return { status: 409, body: { error: 'A step is running. Wait for it before running the tests.' } };
  busy = true;
  try {
    const r = await runTests(String(b.test), await jobRoot(job));
    if ('error' in r) return { status: 400, body: r };
    job.tests = { label: r.label, ok: r.ok, at: new Date().toISOString(), output: r.output, seconds: r.seconds };
    await saveJob(job);
    await addEvent(job.id, { type: 'tests', ok: r.ok, label: r.label });
    return { status: 200, body: { ...(await jobView(job)), tests: job.tests } };
  } finally {
    busy = false;
  }
}

// ---- Home ----

/** Projects saved (Start project, or "Lets create a project" on Home) whose plan was never made: newest first. */
export async function unplanned(): Promise<{ id: string; name: string; goal: string; at: string }[]> {
  const root = await d.workspaceDir();
  const out: { id: string; name: string; goal: string; at: string }[] = [];
  for (const id of (await readdir(join(root, 'jobs')).catch(() => [] as string[])).filter(jobs.validId)) {
    if (await stat(join(root, 'jobs', id, 'plan.json')).then(() => true, () => false)) continue;
    const p = await readFile(join(root, 'jobs', id, 'project.json'), 'utf8').then(t => JSON.parse(t) as Record<string, unknown> & { answers?: { statement?: unknown } }, () => null);
    if (!p) continue;
    out.push({ id, name: String(p.name ?? ''), goal: String(p.prompt || p.about || p.answers?.statement || ''), at: String(p.created ?? '') });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** What Home shows about jobs: what needs the person, what is running now, and the recent projects. Every line is written by code. */
export async function homeJobs(staff: home.Person[]) {
  const items: home.HomeItem[] = [];
  const all: Job[] = [];
  const root = await d.workspaceDir();
  for (const job of await allJobs()) {
    if (job.hidden) continue;
    all.push(job);
    const w = await loadWaiting(job.id);
    const waiting: home.Waiting | null = w ? { n: w.n, at: w.at, worker: w.result.worker, files: w.result.files.map(f => f.path), flags: (w.result.problems?.length ?? 0) + (w.result.warnings?.length ?? 0) + (w.result.review?.ok === false ? w.result.review.problems.length : 0) } : null;
    const hasReport = await stat(join(root, 'jobs', job.id, 'review.md')).then(s => s.isFile(), () => false);
    const item = home.jobItem(job, waiting, hasReport, running?.jobId === job.id, staff);
    if (item) items.push(item);
  }
  const now = running;
  const working = now ? home.workingLine(now, now.jobId ? await loadJob(now.jobId) : null, staff) : null;
  const sorted = home.sortItems(items);
  // Recent projects: the ones not already on Home (waiting for you, part done), newest first, and any never planned.
  const shown = new Set([...sorted.waiting, ...sorted.paused].map(x => x.job));
  const recent = home.recentProjects(all.filter(j => !shown.has(j.id)), await unplanned(), now?.jobId ?? null);
  return { waiting: sorted.waiting, paused: sorted.paused, recent, working };
}
