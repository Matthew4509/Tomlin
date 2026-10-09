import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentions, noteReply, pendingNotes, roomLines, roomRow, type JobEvent } from '../src/home.ts';
import { reviewUser, workerUser, type Job, type Step } from '../src/jobs.ts';

const step = (title: string, role: string, status: Step['status'] = 'todo'): Step => ({ title, role, files: role === 'artist' ? [] : ['app.js'], brief: title, check: '', status, summary: '', wrote: [] });
const job = (steps: Step[]): Job => ({ id: '20261003-1200-abcd', goal: 'a tip calculator page', created: '2026-10-03T12:00:00Z', updated: '2026-10-03T12:30:00Z', notes: '', steps });
const staff = [{ id: 'rowan', name: 'Rowan Hale', role: 'coder' }, { id: 'jen', name: 'Jen', role: 'writer' }, { id: 'max', name: 'Max', role: 'pm' }, { id: 'ana', name: 'Ana', role: 'artist' }];
const at = '2026-10-03T13:00:00Z';

test('@Name finds a hire by first or whole name, and @role a role with nobody named; each once, in order', () => {
  assert.deepEqual(mentions('@rowan use a <form>, and @Jen keep it short. @RowanHale again', staff), [
    { staffId: 'rowan', name: 'Rowan Hale', role: 'coder' },
    { staffId: 'jen', name: 'Jen', role: 'writer' },
  ]);
  assert.deepEqual(mentions('@reviewer check the totals', staff), [{ staffId: null, name: 'the reviewer', role: 'reviewer' }]);
  assert.deepEqual(mentions('@Max plan less', staff), [{ staffId: 'max', name: 'Max', role: 'planner' }]);
  // A role word with someone hired in it is that person.
  assert.deepEqual(mentions('@writer friendly tone', staff), [{ staffId: 'jen', name: 'Jen', role: 'writer' }]);
  assert.deepEqual(mentions('@Jen and @writer', staff), [{ staffId: 'jen', name: 'Jen', role: 'writer' }]);
  assert.deepEqual(mentions('mail me at a@b.com, @nobody here', staff), []);
});

test('a note waits for the next step in its role and is used once a step came back with it', () => {
  const to = mentions('@Rowan use a form', staff);
  const events: JobEvent[] = [{ at, type: 'note', id: 'n1', text: '@Rowan use a form', to }];
  assert.deepEqual(pendingNotes(events, 'coder'), [{ id: 'n1', text: '@Rowan use a form' }]);
  assert.deepEqual(pendingNotes(events, 'writer'), []);
  // A step that failed did not use it.
  events.push({ at, type: 'failed', n: 0, role: 'coder', error: 'The model stopped part-way.' });
  assert.equal(pendingNotes(events, 'coder').length, 1);
  events.push({ at, type: 'result', n: 0, role: 'coder', files: ['app.js'], flags: 0, worker: 'Qwen3.5 2B', tries: 1, notes: ['n1'] });
  assert.deepEqual(pendingNotes(events, 'coder'), []);
});

test('the owner note goes into the worker brief and the reviewer brief', () => {
  const s = step('Write app.js', 'coder');
  assert.match(workerUser(s, { 'app.js': null }, '', ['@Rowan use a <form>']), /Owner's note for this step \(follow it as part of the brief\):\n- @Rowan use a <form>/);
  assert.doesNotMatch(workerUser(s, { 'app.js': null }), /Owner's note/);
  // Still before the last line, which a small model follows most.
  assert.match(workerUser(s, { 'app.js': null }, '', ['x']), /End with the SUMMARY line\.$/);
  assert.match(reviewUser(job([s]), s, [], [], 10000, ['totals must round', 'tax is 15%']), /Owner's notes for this step[^\n]*\n- totals must round\n- tax is 15%/);
});

test('the room is written by code from the events, with "to" tags and the lines that need him marked', () => {
  const j = job([step('Write index.html', 'coder', 'done'), step('Write the help text', 'writer'), step('Draw the logo', 'artist')]);
  const events: JobEvent[] = [
    { at, type: 'plan', steps: 3, worker: 'Qwen3.5 2B' },
    { at, type: 'step', n: 0, title: 'Write index.html', role: 'coder', worker: 'Qwen3.5 2B', notes: [] },
    { at, type: 'result', n: 0, role: 'coder', files: ['index.html'], flags: 2, worker: 'Qwen3.5 2B', tries: 2, notes: [] },
    { at, type: 'saved', n: 0, files: ['index.html'], auto: false, left: 2 },
    { at, type: 'note', id: 'n1', text: '@Jen friendly words please', to: mentions('@Jen friendly words please', staff) },
    { at, type: 'picture', n: 2, title: 'Draw the logo', role: 'artist' },
    { at, type: 'failed', n: 1, role: 'writer', error: 'Stopped.' },
  ];
  const lines = roomLines(events, j, staff);
  assert.deepEqual(lines.map(l => [l.from, l.to, l.text]), [
    ['Max', 'You', 'Made a plan in 3 steps (Qwen3.5 2B). Read it and change anything before it runs.'],
    ['TOMLIN', 'Rowan Hale', 'Assigning step 1 of 3 (Write index.html) to Rowan Hale.'],
    ['Rowan Hale', null, 'On it. (Qwen3.5 2B)'],
    ['Rowan Hale', 'You', 'Finished step 1, please review. Wrote index.html · 2 checks to look at · 2 tries.'],
    ['You', null, 'Saved step 1 (index.html).'],
    ['You', 'Jen', '@Jen friendly words please'],
    ['TOMLIN', null, 'Jen will read this with step 2 (Write the help text).'],
    ['TOMLIN', 'Ana', "Step 3 needs a picture from Ana: Draw the logo. Draw it in an artist's chat, then mark the step done."],
    ['You', null, 'Stopped step 2.'],
  ]);
  assert.deepEqual(lines.filter(l => l.needs).map(l => l.from), ['Max', 'Rowan Hale', 'TOMLIN']);
});

test('saving the last step says the job is done; a role with nobody hired is named by the role', () => {
  const j = job([step('Write app.js', 'coder', 'done')]);
  const lines = roomLines([{ at, type: 'saved', n: 0, files: ['app.js'], auto: true, left: 0 }, { at, type: 'review', n: 0, ok: false, problems: 2, notes: [] }], j, []);
  assert.deepEqual(lines.map(l => l.text), [
    'Saved step 1: every check passed. (app.js)',
    'All 1 steps are done. Please review the result: run the tests or ask for the end-of-job report.',
    'Read step 1: found 2 problems. See the step in Jobs.',
  ]);
  assert.equal(lines[2].from, 'The reviewer');
});

test('a job made before rooms gets its room from the plan file', () => {
  const s = step('Write app.js', 'coder', 'done');
  s.summary = 'Added calc() and the #bill box.';
  const lines = roomLines([], job([s, step('Polish', 'coder', 'skipped'), step('Docs', 'writer')]), staff);
  assert.equal(lines.length, 3);
  assert.match(lines[0].text, /has 3 steps\. This job was made before job rooms/);
  assert.equal(lines[1].text, 'Step 1 done: Added calc() and the #bill box.');
  assert.equal(lines[1].from, 'Rowan Hale');
  assert.equal(lines[2].text, 'Step 2 was skipped: Polish.');
});

test('once a step has read a note, the reply under it says so, even after the job moved on', () => {
  const j = job([step('Write app.js', 'coder', 'done')]);
  const to = mentions('@Rowan use a form', staff);
  const lines = roomLines([
    { at, type: 'note', id: 'n1', text: '@Rowan use a form', to },
    { at, type: 'result', n: 0, role: 'coder', files: ['app.js'], flags: 0, worker: 'Qwen3.5 2B', tries: 1, notes: ['n1'] },
  ], j, staff);
  assert.equal(lines[1].text, 'Rowan Hale read this with step 1.');
});

test('the manager says honestly who will read a note', () => {
  const j = job([step('Write app.js', 'coder', 'done'), step('Docs', 'writer')]);
  assert.match(noteReply([], j), /Nobody reads the room by themselves/);
  assert.equal(noteReply(mentions('@Rowan', staff), j), 'Rowan Hale has no step waiting in this job: the note goes into their next step if one is added.');
  assert.equal(noteReply(mentions('@reviewer', staff), j), 'The reviewer will read this the next time a step is reviewed.');
  assert.equal(noteReply([{ staffId: 'r', name: 'Rita', role: null }], j), 'Rita has no steps in jobs, so nobody will read this.');
});

test('a room row shows the newest line and how many lines there are', () => {
  const j = job([step('Write app.js', 'coder')]);
  const r = roomRow(j, [{ at, type: 'plan', steps: 1, worker: 'Qwen3.5 2B' }], staff);
  assert.equal(r.last, 'Max: Made a plan in 1 step (Qwen3.5 2B). Read it and change anything befor…');
  assert.equal(r.lines, 1);
  assert.equal(r.needs, true);
  assert.equal(r.total, 1);
});
