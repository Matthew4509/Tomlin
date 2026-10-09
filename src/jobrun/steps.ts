// One step: sized to its worker, run with checks and retries, saved, and read by the reviewer.
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import * as jobs from '../jobs.ts';
import type { Job } from '../jobs.ts';
import * as ws from '../workspace.ts';
import { syntaxCheck, type CheckResult } from '../checks.ts';
import { checkMessage, REFUSAL } from '../filter.ts';
import { roleOf, levelOf, type StaffMember } from '../staff.ts';
import * as home from '../home.ts';
import * as seats from '../seats.ts';
import type { Send } from './shared.ts';
import { brainForRef } from './who.ts';
import { workAs } from '../meter.ts';
import { lostOf } from './links.ts';
import { seatBrain, sizeStep, teamOf, whoDoes } from './sizing.ts';
import { addEvent, jobRoot, left, loadEvents, packetFront, saveHandoff, saveJob, webFiles } from './jobfiles.ts';
import type { Brain, StepResult } from '../jobrun.ts';

// ---- One step ----

/** One step, with the room told: who it was given to, which of his notes went with the brief, and what came back. */
export async function doStep(job: Job, i: number, send: Send, signal: AbortSignal): Promise<{ result: StepResult } | { error: string }> {
  // Sized first: the step may become parts (job.steps changes) or go to a bigger worker.
  const sized = await sizeStep(job, i, send);
  const step = job.steps[i];
  if ('error' in sized) {
    await addEvent(job.id, { type: 'failed', n: i, role: step.role, error: sized.error });
    return sized;
  }
  const notes = home.pendingNotes(await loadEvents(job.id), step.role);
  const ids = notes.map(x => x.id);
  const r = await runStep(job, i, send, signal, notes.map(x => x.text), worker => addEvent(job.id, { type: 'step', n: i, title: step.title, role: step.role, worker, notes: ids }), sized.seat);
  if ('error' in r) await addEvent(job.id, { type: 'failed', n: i, role: step.role, error: r.error });
  else await addEvent(job.id, { type: 'result', n: i, role: step.role, files: r.result.files.map(f => f.path), flags: r.result.problems.length + r.result.warnings.length, worker: r.result.worker, tries: r.result.tries, notes: ids });
  return r;
}

async function runStep(job: Job, i: number, send: Send, signal: AbortSignal, ownerNotes: string[], started: (worker: string) => Promise<void>, seat: seats.Seat | null = null): Promise<{ result: StepResult } | { error: string }> {
  const step = job.steps[i];
  const role = jobs.workerRole(step);
  const kind = roleOf(step.role);
  if (!role) return { error: `Step ${i + 1} is a picture for the ${kind.name.toLowerCase()}: draw it in an artist's chat (brief: ${step.brief}), then press Mark done.` };
  const verdict = checkMessage(`${step.title}\n${step.brief}`, { recent: [] });
  if (!verdict.ok) return { error: REFUSAL[verdict.reason] };
  // Who does it is the job's team (Roles in its Overview): a hire runs on their own brain; else the strongest worker.
  const team = teamOf(job);
  let hire: StaffMember | null = whoDoes(team, role)?.hire ?? null;
  let brain: Brain;
  try {
    // `seat`: the step was moved to another worker (too big for its own).
    if (seat) {
      brain = (await brainForRef(seat.ref, `step ${i + 1}`, 'in the job\'s Overview (Roles)', text => send('stage', { text }), signal)).brain;
      hire = null;
      workAs(null);
    } else {
      const got = await seatBrain(team, role, `the ${role} for step ${i + 1}`, text => send('stage', { text }), signal);
      // A smaller backup (an intern) writes drafts, never a step across several files: that waits for the hire.
      if (got.hire && got.intern && step.files.length > 1) {
        const first = got.hire.name.split(/\s+/)[0];
        return { error: `${first}'s backup is a smaller model (an intern), and step ${i + 1} changes ${step.files.length} files together: that waits for ${first}. Pick a bigger backup in ${first}'s chat, or wait for ${first}'s PC, then press Run step ${i + 1} again.` };
      }
      brain = got.brain;
      hire = got.hire;
    }
  } catch (e) {
    return { error: (e as Error).message };
  }
  const root = await jobRoot(job);
  const texts: Record<string, string | null> = {};
  let size = 0;
  for (const f of step.files) {
    const r = await ws.read(root, f);
    texts[f] = 'error' in r ? null : r.text;
    size += texts[f]?.length ?? 0;
  }
  const front = await packetFront(job.id, brain.ctx, hire ?? null, `${step.title} ${step.brief}`);
  const b = jobs.budget(brain.ctx, front.text.length);
  // Sized before it ran (sizeStep); this stays as the last guard (a linked PC may have changed its model since).
  const room = seats.stepRoom(brain.ctx, front.text.length);
  if (size > room) return { error: `The files for step ${i + 1} hold ${size.toLocaleString()} characters, more than ${brain.label} can read in one go with a ${brain.ctx.toLocaleString()}-token context (about ${room.toLocaleString()}). Give that model a bigger context (chat settings), name fewer files in the step, or split the file first.` };
  // Files too long to write out whole in the answer are changed by edit blocks that code checks (PLAN F10 G2).
  const edit = jobs.editFiles(step.files, texts, Math.floor(b.answer * 2.2));
  if (edit.length) send('stage', { text: `${edit.join(' and ')} ${edit.length > 1 ? 'are' : 'is'} too long to write out whole: the ${role} changes ${edit.length > 1 ? 'them' : 'it'} with find-and-replace blocks, checked before anything is saved.` });
  const system = jobs.workerSystem(`${kind.prompt}${hire ? ` ${levelOf(hire.level).style}` : ''}`, job, step, i + 1, front.text, edit);
  const first = jobs.workerUser(step, texts, job.notes, ownerNotes, edit);
  await saveHandoff(job, i, brain, front.parts, system, first);
  await started(brain.label);
  let user = first;
  let parsed: jobs.Result = { files: [], summary: '', dropped: [] };
  let raw = '';
  let checks: CheckResult[] = [];
  let problems: string[] = [];
  let tries = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    tries = attempt + 1;
    if (attempt) send('stage', { text: `Check failed: ${problems[0]} Asking the ${role} to fix it (try ${attempt + 1} of 3).` });
    try {
      raw = await brain.ask(system, user, b.answer, text => send('text', { text }), signal);
    } catch (e) {
      // The linked PC carries on and keeps the result: running the step again collects it instead of doing it again.
      if (lostOf(e)) return { error: `${(e as Error).message} Press Run step ${i + 1} again once that PC is back: its finished work is collected, not done again.` };
      return { error: (e as Error).message };
    }
    parsed = jobs.parseResult(raw, step.files, edit);
    // Edit blocks become whole files here, by code; a block that does not match one place is refused.
    const editProblems: string[] = [];
    for (const f of edit) {
      if (parsed.files.some(x => x.path === f)) continue;
      const mine = (parsed.edits ?? []).filter(e => e.path === f);
      if (!mine.length) continue;
      const r = jobs.applyEdits(f, texts[f] ?? '', mine);
      if ('problems' in r) editProblems.push(...r.problems);
      else parsed.files.push({ path: f, text: r.text });
    }
    checks = await syntaxCheck(parsed.files);
    problems = [...editProblems, ...checks.filter(c => !c.ok).map(c => `${c.path} (${c.tool}): ${c.message.split('\n').slice(0, 3).join(' ')}`)];
    // A long file sent back as a fragment would lose the rest if saved.
    problems.push(...jobs.shrunk(texts, parsed.files));
    // An answer stopped by its length limit may end part way through a file that still passes the checks.
    if (brain.cut) problems.push('The answer was cut off at its length limit, so a file may be unfinished. Send the files again, shorter: change only what the step needs.');
    if (step.files.length && !parsed.files.length && !editProblems.length) problems.push(edit.length ? `No change came back: give EDIT blocks for ${edit[0]} in the "=== EDIT: ${edit[0]} ===" form.` : `No file came back in the "=== FILE: ${step.files[0]} ===" form.`);
    // A small model often sends the files back as they were and says it fixed them.
    if (parsed.files.length && parsed.files.every(f => texts[f.path] != null && texts[f.path]!.replace(/\s+$/, '') === f.text.replace(/\s+$/, ''))) problems.push('The answer changed nothing: every file came back exactly as it was.');
    if (!problems.length) break;
    user = `${first}\n\n${jobs.fixMessage(problems, step.files, edit)}`;
  }
  const warnings = jobs.crossCheck(await webFiles(root, parsed.files));
  return { result: { ...parsed, raw, checks, problems, warnings, base: Object.fromEntries(step.files.map(f => [f, textHash(texts[f] ?? null)])), exists: Object.fromEntries(step.files.map(f => [f, texts[f] != null])), tries, worker: brain.label } };
}

/** A file's text as a short fingerprint (null: no file), kept with a step's result to see a change made after it ran. */
export const textHash = (text: string | null): string => (text == null ? 'none' : createHash('sha256').update(text).digest('hex').slice(0, 32));

/** Saves a step's files (only the step's own) and marks it done; the names in the files go into the notes. */
export async function acceptStep(job: Job, i: number, files: { path?: unknown; text?: unknown }[], summary: unknown, auto = false, base?: Record<string, string>): Promise<{ job: Job } | { error: string; status: number }> {
  const step = job.steps[i];
  if (!step || step.status !== 'todo') return { status: 409, error: 'That step is not waiting to be done.' };
  if (step.files.length && !files.length) return { status: 400, error: 'There are no files to save for this step. Run it again, or press Mark done if you made the files yourself.' };
  for (const f of files) {
    const path = ws.cleanPath(f?.path);
    if (!path || !step.files.includes(path) || typeof f.text !== 'string') return { status: 400, error: `This step may not write ${String(f?.path)}.` };
  }
  const root = await jobRoot(job);
  // Every file is checked before any is saved, and each one's text now is kept: a later file that fails puts the earlier
  // ones back, so a step never leaves a project half changed.
  const before: { path: string; text: string | null }[] = [];
  for (const f of files) {
    const path = ws.cleanPath(f.path)!;
    if (!(await ws.inside(root, path))) return { status: 400, error: `${path}: that is not a file this step can save inside the project.` };
    if (Buffer.byteLength(String(f.text)) > ws.MAX_BYTES) return { status: 400, error: `${path}: that is over 1 MB, too big to save here. Nothing was saved.` };
    const now = await ws.read(root, path);
    const text = 'error' in now ? null : now.text;
    // Changed since the step read it (an editor, a chat, another step): saving would lose that change.
    if (base && path in base && base[path] !== textHash(text)) return { status: 409, error: `${path} has changed since this step was written, so saving would lose that change. Nothing was saved. Run the step again so it starts from the file as it is now.` };
    before.push({ path, text });
  }
  const wrote: string[] = [];
  for (const f of files) {
    const r = await ws.save(root, f.path, f.text);
    if ('error' in r) {
      for (const b of before.filter(x => wrote.includes(x.path))) {
        if (b.text != null) await ws.save(root, b.path, b.text);
        else {
          const full = await ws.inside(root, b.path);
          if (full) await rm(full, { force: true });
        }
      }
      return { status: 400, error: `${String(f.path)}: ${r.error}${wrote.length ? ` Nothing was kept: ${wrote.join(', ')} ${wrote.length > 1 ? 'were' : 'was'} put back as before.` : ''}` };
    }
    wrote.push(r.path);
  }
  step.status = 'done';
  step.summary = String(summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  step.wrote = wrote;
  job.notes = jobs.addNote(job.notes, i + 1, step.title, step.summary, files.map(f => jobs.factsOf(ws.cleanPath(f.path)!, String(f.text))));
  await saveJob(job);
  await addEvent(job.id, { type: 'saved', n: i, files: wrote, auto, left: left(job) });
  return { job };
}

/** The reviewer reads one step's proposed files against its brief and the names in the other files. */
export async function reviewStep(job: Job, i: number, files: { path: string; text: string }[], findings: string[], send: Send, signal: AbortSignal): Promise<{ ok: boolean | null; problems: string[]; text: string } | { error: string }> {
  let brain: Brain;
  try {
    brain = (await seatBrain(teamOf(job), 'audit', 'the auditor', text => send('stage', { text }), signal)).brain;
  } catch (e) {
    return { error: (e as Error).message };
  }
  send('stage', { text: `The reviewer (${brain.label}) is reading step ${i + 1}…` });
  const notes = home.pendingNotes(await loadEvents(job.id), 'reviewer');
  const front = await packetFront(job.id, brain.ctx, null, `${job.steps[i].title} ${job.steps[i].brief}`);
  try {
    const text = await brain.ask(jobs.REVIEW_SYSTEM, jobs.reviewUser(job, job.steps[i], files, findings, jobs.budget(brain.ctx, front.text.length).input, notes.map(x => x.text), front.text), 500, t => send('review-text', { text: t }), signal);
    const rv = jobs.parseReview(text);
    await addEvent(job.id, { type: 'review', n: i, ok: rv.ok, problems: rv.problems.length, notes: notes.map(x => x.id) });
    return { ...rv, text };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
