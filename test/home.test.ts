import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStuck, jobItem, pcState, sortItems, staffState, whoFor, workerName, workingLine, type HomeItem, type Waiting } from '../src/home.ts';
import type { Job, Step } from '../src/jobs.ts';

const step = (title: string, role: string, status: Step['status'] = 'todo'): Step => ({ title, role, files: role === 'artist' ? [] : ['app.js'], brief: title, check: '', status, summary: '', wrote: [] });
const job = (steps: Step[], extra: Partial<Job> = {}): Job => ({ id: '20261003-1200-abcd', goal: 'a tip calculator page', created: '2026-10-03T12:00:00Z', updated: '2026-10-03T12:30:00Z', notes: '', steps, ...extra });
const staff = [{ id: 'rowan', name: 'Rowan', role: 'coder' }, { id: 'jen', name: 'Jen', role: 'writer' }, { id: 'max', name: 'Max', role: 'pm' }];
const waiting = (n: number, flags = 0): Waiting => ({ n, at: '2026-10-03T13:00:00Z', worker: 'Qwen3.5 2B', files: ['app.js'], flags });

test('the person who does a role is the first hire in it, else the role by name', () => {
  assert.deepEqual(whoFor('coder', staff), { name: 'Rowan', id: 'rowan' });
  assert.deepEqual(whoFor('planner', staff), { name: 'Max', id: 'max' });
  assert.deepEqual(whoFor('designer', staff), { name: 'the graphic designer', id: null });
  assert.deepEqual(whoFor(null, []), { name: 'the worker', id: null });
});

test('a step that came back is the first thing waiting, named after who did it', () => {
  const it = jobItem(job([step('Write app.js', 'coder', 'done'), step('Write the help text', 'writer')]), waiting(1, 2), false, false, staff)!;
  assert.equal(it.kind, 'result');
  assert.equal(it.text, 'Jen finished step 2 of 2 (Write the help text). Please review.');
  assert.match(it.detail, /Wrote app\.js · by Qwen3\.5 2B · 2 checks to look at/);
  assert.equal(it.staffId, 'jen');
  assert.equal(it.action, 'Review');
});

test('a waiting result for a step already done is ignored (it was saved another way)', () => {
  const it = jobItem(job([step('Write app.js', 'coder', 'done'), step('Polish', 'coder')]), waiting(0), false, false, staff)!;
  assert.equal(it.kind, 'paused');
});

test('a picture step, failed tests, then all done without a report, each say what is needed', () => {
  assert.equal(jobItem(job([step('Draw a lighthouse', 'artist')]), null, false, false, staff)!.kind, 'picture');
  assert.match(jobItem(job([step('Draw a lighthouse', 'artist')]), null, false, false, staff)!.text, /needs a picture from the artist/);
  const failed = job([step('a', 'coder', 'done')], { tests: { label: 'node --test', ok: false, at: '2026-10-03T12:40:00Z', output: '', seconds: 2 } });
  assert.equal(jobItem(failed, null, false, false, staff)!.kind, 'tests');
  const done = job([step('a', 'coder', 'done'), step('b', 'writer', 'skipped')]);
  assert.equal(jobItem(done, null, false, false, staff)!.text, 'All 2 steps are done. Please review the result.');
  assert.equal(jobItem(done, null, true, false, staff), null, 'finished with its report: nothing to do');
});

test('a running job is not waiting for anyone; a job between steps is paused', () => {
  const j = job([step('Write app.js', 'coder', 'done'), step('Write style.css', 'coder')]);
  assert.equal(jobItem(j, null, false, true, staff), null);
  const p = jobItem(j, null, false, false, staff)!;
  assert.equal(p.text, 'Paused before step 2 of 2: Write style.css.');
  assert.equal(p.detail, '1 of 2 done. Next: Rowan.');
  const fresh = jobItem(job([step('Write app.js', 'coder')]), null, false, false, staff)!;
  assert.equal(fresh.text, 'Not started. Step 1 of 1: Write app.js.');
  assert.equal(fresh.kind, 'ready', 'a job never started is not paused');
});

test('worker names drop the folder, .gguf, the quantisation and -it; plain words stay', () => {
  assert.equal(workerName('*/Qwen3.5-0.8B-Q4_K_M.gguf'), 'Qwen3.5 0.8B');
  assert.equal(workerName('gemma-3-1b-it-Q4_K_M'), 'gemma 3 1b');
  assert.equal(workerName('C:\\models\\Mistral-Nemo-12B-IQ4_XS.gguf'), 'Mistral Nemo 12B');
  assert.equal(workerName('model-F16.gguf'), 'model');
  assert.equal(workerName('laptop 0.8B'), 'laptop 0.8B');
  assert.equal(workerName('Qwen3.5 2B'), 'Qwen3.5 2B');
});

test('waiting items come before paused ones, by weight then newest first', () => {
  const mk = (kind: HomeItem['kind'], at: string): HomeItem => ({ job: kind + at, goal: '', kind, text: '', detail: '', action: '', at, staffId: null });
  const { waiting: w, paused, ready } = sortItems([mk('paused', '3'), mk('ready', '4'), mk('report', '9'), mk('result', '1'), mk('result', '5'), mk('picture', '2')]);
  assert.deepEqual(w.map(x => x.job), ['result5', 'result1', 'picture2', 'report9']);
  assert.deepEqual(paused.map(x => x.job), ['paused3']);
  assert.deepEqual(ready.map(x => x.job), ['ready4']);
});

test('the working line names the person, the step and how far the job is', () => {
  const j = job([step('Write app.js', 'coder', 'done'), step('Write style.css', 'coder'), step('Help text', 'writer')]);
  const w = workingLine({ kind: 'run', jobId: j.id, goal: j.goal, n: 1, title: 'Write style.css', role: 'coder', stage: 'Loading Qwen', startedAt: 1000 }, j, staff, 31_000);
  assert.equal(w.text, 'Rowan is on step 2 of 3: Write style.css.');
  assert.equal(w.done, 1);
  assert.equal(w.total, 3);
  assert.equal(w.seconds, 30);
  assert.equal(w.staffId, 'rowan');
  assert.equal(workingLine({ kind: 'plan', jobId: null, goal: 'x', n: null, title: '', role: 'planner', stage: '', startedAt: 0 }, null, staff, 0).text, 'Max is making a plan.');
  assert.equal(workingLine({ kind: 'final', jobId: j.id, goal: 'x', n: null, title: '', role: 'reviewer', stage: '', startedAt: 0 }, j, [], 0).text, 'The reviewer is writing the end-of-job report.');
});

test('staff states: on, waking, asleep with a load time, and not set up', () => {
  const pane = (state: string, model: string | null) => ({ state, model });
  assert.deepEqual(staffState('qwen', pane('connected', 'qwen'), true, 20), { state: 'on', text: 'On' });
  assert.deepEqual(staffState('qwen', pane('loading', 'qwen'), true, 20), { state: 'waking', text: 'Waking up' });
  assert.deepEqual(staffState('qwen', pane('connected', 'gemma'), true, 19.6), { state: 'asleep', text: 'Asleep: not loaded. Connect wakes it in about 20 s' });
  assert.equal(staffState('qwen', pane('disconnected', null), false, 20).text, 'Model not on this PC');
  assert.equal(staffState(null, pane('connected', 'qwen'), true, 20).state, 'none');
});

test('a worker PC is on with a model, asleep without one, off when it does not answer', () => {
  assert.equal(pcState({ ok: true, model: 'qwen' }).state, 'on');
  assert.equal(pcState({ ok: true, model: null }).state, 'asleep');
  // A PC with only a picture model loaded is On: it can draw for this one.
  assert.equal(pcState({ ok: true, model: null, image: { name: 'DreamShaper 8 LCM' } }).state, 'on');
  assert.equal(pcState({ ok: true, model: null, image: { name: null } }).state, 'asleep');
  assert.equal(pcState({ ok: false }).text, 'Off: not answering');
});

test('stuck waiting for him: a step stopped on a fault, or failed tests, as the last thing (notes aside); a Stop is not', () => {
  const at = '2026-10-04T12:00:00Z';
  const failed = { type: 'failed', at, n: 0, role: 'coder', error: 'The model ran out of room.' } as never;
  assert.equal(isStuck([failed]), true);
  assert.equal(isStuck([failed, { type: 'note', at, id: 'a1b2c3d4', text: 'hi', to: [] } as never]), true);
  assert.equal(isStuck([{ type: 'failed', at, n: 0, role: 'coder', error: 'Stopped.' } as never]), false);
  assert.equal(isStuck([{ type: 'tests', at, ok: false, label: 'npm test' } as never]), true);
  assert.equal(isStuck([failed, { type: 'tests', at, ok: true, label: 'npm test' } as never]), false);
  assert.equal(isStuck([]), false);
});
