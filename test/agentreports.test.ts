// N5 (27 Nov agents plan): Read reports and the Morning brief. read_report gives only the jobs the recipe's Reads
// names, the last 24 hours only, a failed run said as failed; Reads is checked against the jobs on save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentKit, type FoundReport } from '../src/agenttools.ts';
import { checkAgainst, readRecipe, recipeText, STARTERS } from '../src/recipe.ts';

const NOW = Date.parse('2026-11-27T07:00:00Z');
const text = 'Name: Morning brief\nAgent: Robin\nWhen: Every weekday at 07:00\nTask: Sum up the others.\nReads: Robin\'s price watch, Website check\nTools: read reports, working notes';

function kit(found: Record<string, FoundReport | null>) {
  const recipe = readRecipe(text).recipe;
  const asked: string[] = [];
  const k = new AgentKit({ recipe, root: mkdtempSync(join(tmpdir(), 'tomlin-reports-')), runDir: 'run', search: { provider: 'duckduckgo' }, perCall: 4000, total: 40_000, deadline: NOW + 600_000, now: () => NOW, reports: async n => { asked.push(n); return found[n] ?? null; } });
  return { k, asked };
}

test('Reads is read, written back and checked against the jobs here', () => {
  const r = readRecipe(text);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.recipe.reads, ['Robin\'s price watch', 'Website check']);
  assert.match(recipeText(r.recipe), /Reads:\s+Robin's price watch, Website check/);
  const jobs = [{ name: 'Price watch', agentName: 'Robin' }, { name: 'Website check', agentName: 'Sam' }];
  assert.deepEqual(checkAgainst(r.recipe, { agents: [{ id: 'robin', name: 'Robin' }], pcs: [], jobs }).problems, []);
  assert.match(checkAgainst(r.recipe, { agents: [{ id: 'robin', name: 'Robin' }], pcs: [], jobs: jobs.slice(0, 1) }).problems.join(' '), /"Website check" in Reads is not a standing job here/);
  assert.match(readRecipe(text.replace('read reports, ', '')).problems.join(' '), /no "read reports" tool/);
  assert.match(readRecipe(text.replace(/Reads: .*\n/, '')).problems.join(' '), /no job is named/);
  assert.ok(STARTERS.some(s => s.name === 'Morning brief' && /Tools: read reports/.test(s.text)));
});

test('only the jobs named in Reads are read; another is held', async () => {
  const { k, asked } = kit({});
  assert.ok(k.names().includes('read_report'));
  const out = await k.run('read_report', JSON.stringify({ job: 'Secret payroll' }), new AbortController().signal);
  assert.match(out, /^HELD: /);
  assert.equal(asked.length, 0);
  assert.match(k.held[0].what, /not a job named in its Reads/);
});

test('a report older than 24 hours is said as "no report since"; a failed run as failed; a fresh one is given and counts as read', async () => {
  const { k } = kit({
    'Robin\'s price watch': { name: 'Price watch', state: 'done', line: 'Summary: up.', at: '2026-11-25T07:00:00Z', text: 'old' },
    'Website check': { name: 'Website check', state: 'failed', line: 'Failed: the site did not open.', at: '2026-11-27T06:00:00Z', text: '' },
  });
  assert.match(await k.run('read_report', JSON.stringify({ job: 'robins price watch' }), new AbortController().signal), /no report since .*only the last 24 hours/);
  assert.match(await k.run('read_report', JSON.stringify({ job: 'Website check' }), new AbortController().signal), /its last run failed .*the site did not open/);
  const { k: k2 } = kit({ 'Website check': { name: 'Website check', state: 'done', line: 'Summary: two links broken.', at: '2026-11-27T05:00:00Z', text: '# Website check\nSummary: two links broken.' } });
  const fresh = await k2.run('read_report', JSON.stringify({ job: 'Website check' }), new AbortController().signal);
  assert.match(fresh, /two links broken/);
  assert.equal(k2.read.length, 1);
  const none = kit({});
  assert.match(await none.k.run('read_report', JSON.stringify({ job: 'Website check' }), new AbortController().signal), /there is no report from it yet/);
});
