// The standing jobs and their runs (src/agents.ts) and the run's report (src/agentreport.ts).
process.env.TZ = 'Australia/Sydney';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterRuns, agentHomeLines, agentKnown, allowTool, approvedNow, clockTick, cleanFile, fileRoom, FILE_BY, FILE_RUNS_HOUR, mayRun, skipLine, type AgentsFile, type Job, type Run } from '../src/agents.ts';
import { collectedPath, homeText, reportMarkdown, toCollect, toPrune } from '../src/agentreport.ts';
import { readRecipe, recipeHash } from '../src/recipe.ts';
import type { RunResult } from '../src/agentrun.ts';

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

function job(id: string, text: string, o: Partial<Job> = {}): Job {
  const r = readRecipe(`Name: ${id}\nAgent: robin\nTask: t\n${text}`).recipe;
  return { id, recipe: r, approved: recipeHash(r), paused: false, next: [], seen: {}, made: '', changed: '', ...o };
}
const run = (o: Partial<Run>): Run => ({ id: 'r1', job: 'a', name: 'Price check', agent: 'robin', agentName: 'Robin Hart', by: 'Run now', state: 'done', added: '2026-11-26T07:00:00.000Z', line: '2 prices changed.', held: [], ...o });

test('a job runs only while approved for exactly this recipe and not paused; a change needs approving again', () => {
  const j = job('a', 'When: Every day at 07:00');
  assert.ok(approvedNow(j) && mayRun(j));
  assert.ok(!mayRun({ ...j, paused: true }));
  const changed = { ...j, recipe: { ...j.recipe, task: 'something else' } };
  assert.ok(!approvedNow(changed));
  // Allow next time: the tool is added and that press approves it.
  const allowed = allowTool(changed, 'search');
  assert.ok(allowed.recipe.tools.includes('search') && approvedNow(allowed));
});

test('the clock starts one run per job when due, none for a paused or changed job, and none while one is in line', () => {
  const at = local(2026, 11, 30, 7, 0);
  const f: AgentsFile = { jobs: [job('a', 'When: Every day at 07:00', { next: [at] }), job('b', 'When: Every day at 07:00', { next: [at], paused: true }), job('c', 'When: Every day at 07:00', { next: [at], approved: 'old' }), job('d', 'When: Every day at 07:00; Every weekday at 07:00', { next: [at, at] }), job('e', 'When: Every day at 07:00', { next: [at] })], runs: [run({ job: 'e', state: 'waiting' })], collected: {} };
  const t = clockTick(f, at + 10_000);
  assert.deepEqual(t.start.map(s => s.job), ['a', 'd']);
  // The paused one's time still moves on (missed while paused: not run on Resume).
  assert.equal(new Date(t.next.b[0]!).getDate(), 1);
  // A job with no time saved yet gets one and does not fire.
  const fresh: AgentsFile = { jobs: [job('a', 'When: Every day at 07:00')], runs: [], collected: {} };
  assert.deepEqual(clockTick(fresh, at).start, []);
});

test('After triggers follow a finished run (not a failed one), by job or agent name', () => {
  const f: AgentsFile = { jobs: [job('a', 'When: By hand'), job('b', "When: After Robin's price check"), job('c', 'When: After Fern')], runs: [], collected: {} };
  assert.deepEqual(afterRuns(f, run({ job: 'a' })), ['b']);
  assert.deepEqual(afterRuns(f, run({ job: 'a', state: 'failed' })), []);
});

test('Home: one line per run, runs that found nothing new folded into one, failed and skipped said as such', () => {
  const f: AgentsFile = { jobs: [], collected: {}, runs: [run({ id: 'r1' }), run({ id: 'r2', line: 'Nothing new.' }), run({ id: 'r3', line: 'nothing changed since last run.', name: 'Brief' }), run({ id: 'r4', state: 'failed', line: 'Failed: the model stopped.' }), run({ id: 'r5', state: 'held', held: [{ what: 'x', tool: 'search' }] }), run({ id: 'r6', seen: true }), run({ id: 'r7', state: 'running' })] };
  const lines = agentHomeLines(f, r => homeText(r.agentName, r.name, r.state, r.line));
  assert.deepEqual(lines.map(l => l.kind), ['agent', 'failed', 'agent', 'agent-quiet']);
  assert.equal(lines[0].text, "Robin's price check: 2 prices changed.");
  assert.equal(lines[1].text, "Robin's price check: did not finish: the model stopped.");
  assert.equal(lines[2].detail, 'Held 1 thing.');
  assert.equal(lines[3].text, '2 agent runs found nothing new.');
  assert.deepEqual(lines[3].runs, ['r2', 'r3']);
});

test('the file as saved is read back checked: unknown parts dropped, a bad state failed', () => {
  const f = cleanFile({ jobs: [{ id: 'a', recipe: { name: 'x', agent: 'r', task: 't' } }, { id: '../bad' }], runs: [{ id: 'r1', job: 'a', state: 'weird' }, { nope: 1 }], collected: { pc1: ['r1', 5] } });
  assert.equal(f.jobs.length, 1);
  assert.equal(f.runs[0].state, 'failed');
  assert.deepEqual(f.collected, { pc1: ['r1'] });
});

const result = (o: Partial<RunResult> = {}): RunResult => ({ state: 'done', line: '2 prices changed.', report: 'Summary: 2 prices changed.\nThe kettle is $45.', plan: '1. Open.\n2. Report.', notes: ['kettle 45'], held: [], proposals: [], uses: [{ name: 'open_page', input: 'https://shop.example/a', ok: true, said: 'Kettle' }], check: { quotes: 1, missing: [], mended: false }, wordsRead: 1234, saved: [], flagged: '', spent: '', nothingNew: false, ...o });

test('the report says what it did, what it held, what the check found, what it read and what it proposes', () => {
  const md = reportMarkdown({ job: 'Price check', agentName: 'Robin', pc: 'this PC', by: 'Run now', started: '2026-11-26T07:00:00.000Z', ended: '2026-11-26T07:03:00.000Z', model: 'Qwen3 8B' }, result({ state: 'held', held: [{ what: 'use web search (not in its tools)', tool: 'search' }, { what: 'delete files (x): never allowed', never: true }], proposals: ['The shop moved to /prices-2026'], check: { quotes: 2, missing: ['made up words here please'], mended: true } }));
  assert.match(md, /^# Price check: /);
  assert.match(md, /Took 3 min · 1 tool call · 1,234 words read/);
  assert.match(md, /Ended: Done, with things it was not allowed to do/);
  assert.match(md, /## Held \(not done\)\n\n- Wanted to use web search \(not in its tools\)\. Allow next time on the Agents page\.\n- Wanted to delete files \(x\): never allowed\./);
  assert.match(md, /2 quoted passages looked for in what it read: 1 not found even after it was asked to mend them:\n- "made up words here please" \(not checked\)/);
  assert.match(md, /## Quotes checked\n\n2 quoted passages/);
  assert.match(md, /Only words in quote marks are looked for: figures and claims written without them are not checked\./);
  assert.match(md, /## Read\n\n- https:\/\/shop\.example\/a/);
  assert.match(md, /## Proposed for memory \(waiting in Robin's Inbox\)/);
  assert.match(reportMarkdown({ job: 'x', agentName: 'R', pc: 'p', by: 'b', started: 'a', ended: 'b', model: '' }, result({ state: 'budget', spent: 'words' })), /used up its budget.*\(words read\)/);
});

test('keep the last N runs; collect only new reports, oldest first; two PCs never mix', () => {
  const runs = ['2026-11-20-0700', '2026-11-21-0700', '2026-11-21-0700 2', '2026-11-22-0700', 'inbox', 'notes.md'];
  assert.deepEqual(toPrune(runs, 2), ['2026-11-20-0700', '2026-11-21-0700']);
  assert.deepEqual(toPrune(runs, 30), []);
  assert.deepEqual(toCollect([{ id: 'b', started: '2' }, { id: 'a', started: '1' }, { id: 'c', started: '3' }], new Set(['b'])), ['a', 'c']);
  const rel = 'agents/robin/price-check/2026-11-26-0700/report.md';
  assert.equal(collectedPath('Z820', rel), 'agents/from Z820/robin/price-check/2026-11-26-0700/report.md');
  assert.notEqual(collectedPath('Worker PC', rel), collectedPath('Z820', rel));
  assert.equal(collectedPath('PC: one/two', rel).split('/')[1], 'from PC one two');
});

test('a node knows its Agent by id, whole name or first name, split on spaces (not on the letter s)', () => {
  const here = [{ id: 'jess-smith', name: 'Jess Smith' }, { id: 'robin', name: 'Robin Hood' }];
  assert.ok(agentKnown('Jess', here));
  assert.ok(agentKnown('jess smith', here));
  assert.ok(agentKnown('Robin', here));
  assert.ok(agentKnown('robin', here));
  assert.ok(agentKnown('jess-smith', here));
  assert.equal(agentKnown('Je', here), false);
  assert.equal(agentKnown('Smith', here), false);
  assert.equal(agentKnown('', here), false);
});

test('a run skipped after waiting says it waited behind another agent\'s run when that was the cause', () => {
  const waiting = run({ id: 'w', state: 'waiting' });
  const f: AgentsFile = { jobs: [], runs: [waiting, run({ id: 'x', job: 'b', name: 'Weekly status', agentName: 'Fern', state: 'running' })], collected: {} };
  assert.equal(skipLine(f, waiting, 60), "Skipped: it waited 60 minutes behind Fern's Weekly status.");
  assert.equal(skipLine({ ...f, runs: [waiting] }, waiting, 60), 'Skipped: its PC was busy for 60 minutes.');
});

test('a file trigger starts a run only with room: none in line for the job, and fewer than 6 file runs in the last hour', () => {
  const t = Date.parse('2026-11-26T08:00:00.000Z');
  const ago = (min: number) => new Date(t - min * 60_000).toISOString();
  const fileRun = (id: string, min: number) => run({ id, job: 'a', by: `${FILE_BY} inbox`, added: ago(min) });
  const empty: AgentsFile = { jobs: [], runs: [], collected: {} };
  assert.ok(fileRoom(empty, 'a', t));
  assert.equal(fileRoom({ ...empty, runs: [run({ job: 'a', state: 'waiting' })] }, 'a', t), false);
  const full = Array.from({ length: FILE_RUNS_HOUR }, (_, i) => fileRun(`f${i}`, 5 + i));
  assert.equal(fileRoom({ ...empty, runs: full }, 'a', t), false);
  assert.ok(fileRoom({ ...empty, runs: full }, 'b', t));
  assert.ok(fileRoom({ ...empty, runs: full.map((r, i) => (i === 0 ? { ...r, added: ago(61) } : r)) }, 'a', t));
  assert.ok(fileRoom({ ...empty, runs: full.map(r => ({ ...r, by: 'Run now' })) }, 'a', t));
});
