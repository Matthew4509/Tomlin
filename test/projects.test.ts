// "Lets create a project" on Home, a job's team (the project manager and the roles), the project folder, the strongest
// worker and Home's recent projects: the plain parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanProjectFolder, cleanTeam, folderStamp, jobReviewUser, TEAM_DEFAULT, type Job, type Step } from '../src/jobs.ts';
import { cleanQuick, quickScope, wishLine } from '../src/project.ts';
import { strongest, type Seat } from '../src/seats.ts';
import { activityOf, recentProjects } from '../src/home.ts';
import { Chats } from '../src/chats.ts';
import { Store } from '../src/store.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const step = (title: string, status: Step['status'] = 'todo'): Step => ({ title, role: 'coder', files: ['app.js'], brief: title, check: '', status, summary: '', wrote: [] });
const job = (id: string, steps: Step[], extra: Partial<Job> = {}): Job => ({ id, goal: 'a tip calculator page', created: '2026-10-07T10:00:00Z', updated: '2026-10-07T10:30:00Z', notes: '', steps, ...extra });

test('the default project folder is the date and the time, and sorts in order', () => {
  assert.equal(folderStamp(new Date(2026, 9, 7, 9, 5)), '2026-10-07-0905');
  assert.ok(folderStamp(new Date(2026, 9, 7, 9, 5)) < folderStamp(new Date(2026, 9, 7, 11, 16)));
});

test('a project folder is a plain name inside the workspace, never outside it or over the jobs', () => {
  assert.equal(cleanProjectFolder('tip-calculator'), 'tip-calculator');
  assert.equal(cleanProjectFolder(' clients\\acme\\site\\ '), 'clients/acme/site');
  for (const bad of ['', '..', '../x', 'a/../b', 'C:\\Users\\x', 'C:x', 'jobs', 'jobs/x', '.git', 'name.', 'a/b/c/d', 'con', 'what?', 'node_modules']) assert.equal(cleanProjectFolder(bad), null, bad);
});

test('a team keeps only hires on the team, the three seat words and one line of expectations', () => {
  const hires = ['sam', 'rosa'];
  assert.deepEqual(cleanTeam({}, hires), TEAM_DEFAULT);
  assert.deepEqual(cleanTeam({ pm: 'rosa', coder: 'sam', writer: 'none', audit: 'nobody', expect: '  works on a phone\n no mistakes ' }, hires),
    { pm: 'rosa', coder: 'sam', writer: 'none', audit: 'default', expect: 'works on a phone no mistakes' });
  // A hire who left: the seat goes back to its default.
  assert.deepEqual(cleanTeam({}, ['rosa'], { pm: 'sam', coder: 'sam', writer: 'rosa', audit: 'sam', expect: 'x' }), { pm: '', coder: 'default', writer: 'rosa', audit: 'default', expect: 'x' });
  // A change keeps the rest of what was there.
  assert.deepEqual(cleanTeam({ audit: 'none' }, hires, { ...TEAM_DEFAULT, pm: 'sam' }), { ...TEAM_DEFAULT, pm: 'sam', audit: 'none' });
});

test('the final audit is told what the person expects of it', () => {
  const j = job('20261007-1000-abcd', [step('Write app.js', 'done')], { team: { ...TEAM_DEFAULT, expect: 'works on a phone.' } });
  assert.match(jobReviewUser(j, [], ['app.js']), /What the person expects of this final audit: works on a phone\. Say plainly/);
  assert.doesNotMatch(jobReviewUser(job('20261007-1000-abcd', [step('Write app.js', 'done')]), [], []), /expects/);
});

test('Lets create a project: the prompt is needed (or a description), and the name defaults to the folder', () => {
  assert.deepEqual(cleanQuick({ prompt: '  ', about: '' }, '2026-10-07-1116'), { error: 'Type the prompt first: what should exist when it is finished?' });
  assert.deepEqual(cleanQuick({ prompt: 'A tip calculator', about: '', name: '' }, '2026-10-07-1116'), { name: 'Project 2026-10-07-1116', folder: '2026-10-07-1116', about: '', prompt: 'A tip calculator' });
  assert.equal((cleanQuick({ name: '  Tips\n page ', prompt: 'x' }, 'f') as { name: string }).name, 'Tips page');
});

test('the Scope card from Home holds the words as typed; a wish in the description is a hope, not the statement', () => {
  const plain = quickScope({ name: 'Tips', folder: 'tips', about: 'A tip calculator for my cafe', prompt: 'One page: a bill box and 10, 15 or 20 per cent.' });
  assert.match(plain, /^SCOPE CARD\nProject: Tips\nStatement: A tip calculator for my cafe\nWhat is asked:\nOne page/);
  const about = 'billion dollar saas make no mistake';
  assert.ok(wishLine(about));
  const wish = quickScope({ name: 'Big', folder: 'big', about, prompt: 'A booking page for a salon.' }, about);
  assert.match(wish, /^SCOPE CARD\nProject: Big\nWhat is asked:\nA booking page for a salon\./);
  assert.doesNotMatch(wish, /Statement/);
  // Without a description the prompt is said once, not twice.
  assert.equal(quickScope({ name: 'Tips', folder: 'tips', about: '', prompt: 'A tip calculator.' }), 'SCOPE CARD\nProject: Tips\nWhat is asked:\nA tip calculator.');
  assert.match(wish, /Hope, not promised: billion dollar saas make no mistake$/);
  // No F-lines: the planner is not told to plan F1, F2, … from it.
  assert.doesNotMatch(wish, /^F\d+\./m);
});

test('the strongest worker: most parameters, then most context, then one that answers now', () => {
  const s = (ref: string, params: number | null, ctx: number, ready = false): Seat => ({ ref, label: ref, ctx, params, ready });
  assert.equal(strongest([]), null);
  assert.equal(strongest([s('small', 1, 32768, true), s('big', 9, 8192), s('unknown', null, 65536)])!.ref, 'big');
  assert.equal(strongest([s('a', 4, 8192), s('b', 4, 16384)])!.ref, 'b');
  assert.equal(strongest([s('a', 4, 8192), s('b', 4, 8192, true)])!.ref, 'b');
});

test('recent projects: newest first, each with how far it is, and a project never planned', () => {
  const list = [
    job('20261007-0900-aaaa', [step('a', 'done'), step('b')], { name: 'Half done', updated: '2026-10-07T09:30:00Z' }),
    job('20261007-1000-bbbb', [step('a'), step('b'), step('c')], { updated: '2026-10-07T10:30:00Z' }),
    job('20261007-1100-cccc', [step('a', 'done')], { name: 'Finished', updated: '2026-10-07T11:30:00Z' }),
  ];
  const r = recentProjects(list, [{ id: '20261007-1200-dddd', name: 'Not planned', goal: 'a booking page', at: '2026-10-07T12:00:00Z' }], '20261007-0900-aaaa');
  assert.deepEqual(r.map(x => [x.name, x.detail, x.action]), [
    ['Not planned', 'No plan yet', 'Make the plan'],
    ['Finished', 'All 1 step done', 'Open'],
    ['a tip calculator page', 'Not started · 3 steps planned', 'Open'],
    ['Half done', 'Working on it now · 1 of 2 steps done', 'Open'],
  ]);
  assert.equal(r[0].plan, true);
  assert.equal(recentProjects(list, [], null, 2).length, 2);
});

test('the dot on a hire: red when the owner uses their PC, grey offline, yellow busy (or waking), else green', () => {
  assert.equal(activityOf({ state: 'off', busy: false, away: true }), 'owner');
  assert.equal(activityOf({ state: 'off', busy: false, away: false }), 'offline');
  assert.equal(activityOf({ state: 'none', busy: false, away: false }), 'offline');
  assert.equal(activityOf({ state: 'on', busy: true, away: false }), 'busy');
  assert.equal(activityOf({ state: 'waking', busy: false, away: false }), 'busy');
  assert.equal(activityOf({ state: 'asleep', busy: false, away: false }), 'available');
  assert.equal(activityOf({ state: 'on', busy: false, away: false }), 'available');
});

test('a chat goes into a project and back to Default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-chatproj-'));
  try {
    const chats = new Chats(new Store(dir));
    const c = await chats.create('staff:sam');
    assert.equal((await chats.setProject(c.id, '20261007-1000-abcd'))?.project, '20261007-1000-abcd');
    assert.equal((await chats.get(c.id))?.project, '20261007-1000-abcd');
    assert.equal('project' in (await chats.setProject(c.id, ''))!, false);
    assert.equal(await chats.setProject('000000000000', 'x'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
