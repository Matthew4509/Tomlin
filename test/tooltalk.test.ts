// Tools over the link (src/jobrun/tooltalk.ts): what goes over, what the model's PC accepts, how a call waits for its
// result, and that the asking PC runs each call once. The whole path with a real model is in
// docs/handoffs/tests-2026-11-10-real-models/tool-turn.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanWire, GUEST_SIDE_TOOLS, hostHandler, MAX_DEFS, MAX_HOST_CALLS, nodeBox, onlyTools, toWire, ToolWaits } from '../src/jobrun/tooltalk.ts';

const def = (name: string) => ({ type: 'function', function: { name, description: `does ${name}`, parameters: { type: 'object', properties: {} } } });

test('the tools go over as definitions, rounds and the names that may run side by side', () => {
  const wire = toWire({ defs: [def('read_file'), def('web_search')], rounds: 6, parallel: n => n === 'web_search' });
  assert.deepEqual(wire.parallel, ['web_search']);
  assert.equal(wire.rounds, 6);
  assert.equal(wire.defs.length, 2);
  assert.deepEqual(toWire({ defs: [def('a')], rounds: 2 }).parallel, []);
});

test('the model\'s PC takes only well-formed function definitions, capped', () => {
  assert.equal(cleanWire(null), null);
  assert.equal(cleanWire({ defs: 'x' }), null);
  assert.equal(cleanWire({ defs: [] , rounds: 3 }), null);
  const w = cleanWire({
    defs: [def('ok_one'), def('ok_one'), { type: 'function', function: { name: 'bad name!' } }, { type: 'other', function: { name: 'x' } }, def('ok_two'), 'junk', null],
    rounds: 999,
    parallel: ['ok_one', 'not_offered', 7],
  })!;
  assert.deepEqual((w.defs as any[]).map(d => d.function.name), ['ok_one', 'ok_two']);
  assert.equal(w.rounds, 24, 'rounds are capped');
  assert.deepEqual(w.parallel, ['ok_one'], 'only offered names may run side by side');
  const many = cleanWire({ defs: Array.from({ length: MAX_DEFS + 20 }, (_, i) => def(`t${i}`)), rounds: 1 })!;
  assert.equal(many.defs.length, MAX_DEFS);
  const huge = { type: 'function', function: { name: 'huge', description: 'x'.repeat(20_000) } };
  assert.equal(cleanWire({ defs: [huge], rounds: 1 }), null, 'an oversize definition is dropped');
});

test('a call waits for its result, a result for no call is refused, a stop or a timeout ends the wait in words', async () => {
  const waits = new ToolWaits();
  const live = new AbortController();
  const p = waits.wait('k|r|1-1', live.signal);
  assert.equal(waits.size, 1);
  assert.equal(waits.give('k|r|1-1', 'the result'), true);
  assert.equal(await p, 'the result');
  assert.equal(waits.size, 0);
  assert.equal(waits.give('k|r|1-1', 'again'), false, 'a second result for the same call has nothing to land on');
  assert.equal(waits.give('k|other|1-1', 'x'), false);

  const stopper = new AbortController();
  const q = waits.wait('k|r|2-2', stopper.signal);
  stopper.abort();
  assert.match(await q, /stopped before this tool finished/);
  assert.equal(waits.size, 0);

  const late = await waits.wait('k|r|3-3', new AbortController().signal, 20);
  assert.match(late, /did not give a result in time/);
  assert.equal(waits.size, 0);

  const huge = waits.wait('k|r|4-4', new AbortController().signal);
  waits.give('k|r|4-4', 'y'.repeat(300_000));
  assert.equal((await huge).length, 200_000, 'a result is capped');
});

test('the model\'s box sends each call back on the answer and waits for the asking PC', async () => {
  const waits = new ToolWaits();
  const sent: { event: string; data: Record<string, unknown> }[] = [];
  const box = nodeBox(cleanWire({ defs: [def('read_file'), def('list_files')], rounds: 4, parallel: ['list_files'] })!, (event, data) => sent.push({ event, data }), waits, 'link|rid|');
  assert.equal(box.rounds, 4);
  assert.equal(box.parallel!('list_files'), true);
  assert.equal(box.parallel!('read_file'), false);
  const ac = new AbortController();
  const running = box.run('read_file', '{"path":"a.txt"}', ac.signal, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'tool');
  assert.equal(sent[0].data.name, 'read_file');
  assert.equal(sent[0].data.args, '{"path":"a.txt"}');
  assert.equal(sent[0].data.round, 0);
  assert.equal(waits.give(`link|rid|${sent[0].data.id}`, 'file words'), true);
  assert.equal(await running, 'file words');
  // A name that was not offered is answered here and never sent.
  assert.match(await box.run('run_anything', '{}', ac.signal, 0), /There is no tool called "run_anything"/);
  assert.equal(sent.length, 1);
  // Two calls get two ids.
  const a = box.run('list_files', '{}', ac.signal, 1);
  const b = box.run('list_files', '{}', ac.signal, 1);
  assert.notEqual(sent[1].data.id, sent[2].data.id);
  waits.give(`link|rid|${sent[1].data.id}`, 'one');
  waits.give(`link|rid|${sent[2].data.id}`, 'two');
  assert.deepEqual(await Promise.all([a, b]), ['one', 'two']);
  // Another link's answers never meet this one's.
  assert.equal(waits.give(`other|rid|${sent[0].data.id}`, 'x'), false);
});

test('the asking PC runs each call once and posts its result, again for a call sent again, and a failing tool gives words', async () => {
  const ran: string[] = [];
  const said: string[] = [];
  const posted: [string, string][] = [];
  const handle = hostHandler({
    defs: [def('read_file'), def('boom')],
    rounds: 4,
    run: async (name, args, _s, round) => {
      ran.push(`${name}:${args}:${round}`);
      if (name === 'boom') throw new Error('disk gone');
      return `result of ${name}`;
    },
    onCall: (name) => said.push(name),
  }, new AbortController().signal, async (id, result) => { posted.push([id, result]); });
  handle({ id: '0-1', name: 'read_file', args: '{"path":"x"}', round: 0 });
  handle({ id: '0-1', name: 'read_file', args: '{"path":"x"}', round: 0 });
  handle({ id: '0-2', name: 'boom', args: '{}', round: 0 });
  handle({ id: '', name: 'nothing' });
  handle({ name: 'no_id' });
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(ran, ['read_file:{"path":"x"}:0', 'boom:{}:0'], 'a call sent twice runs once');
  assert.deepEqual(said, ['read_file', 'boom']);
  assert.deepEqual(posted.filter(([id]) => id === '0-1'), [['0-1', 'result of read_file'], ['0-1', 'result of read_file']], 'the result is posted again for the call sent again');
  assert.deepEqual(posted.find(([id]) => id === '0-2'), ['0-2', 'The tool failed: disk gone']);
});

test('the asking PC runs only tools it offered, counts the rounds itself, and stops at its cap of calls', async () => {
  const ran: string[] = [];
  const posted = new Map<string, string>();
  const handle = hostHandler({ defs: [def('web_search')], rounds: 2, run: async (name, _a, _s, round) => (ran.push(`${name}:${round}`), 'ok') }, new AbortController().signal, async (id, result) => void posted.set(id, result));
  // A name it never offered (its own file tool) is not run, whatever the other PC says.
  handle({ id: 'x-1', name: 'read_file', args: '{"path":"C:/secret.txt"}', round: 900 });
  // The round number sent is not believed: 900 is the first round here, then 0 the second, 5 a third (past the 2 offered).
  handle({ id: 'a', name: 'web_search', args: '{}', round: 900 });
  handle({ id: 'b', name: 'web_search', args: '{}', round: 900 });
  handle({ id: 'c', name: 'web_search', args: '{}', round: 0 });
  handle({ id: 'd', name: 'web_search', args: '{}', round: 5 });
  await new Promise(r => setTimeout(r, 30));
  assert.match(posted.get('x-1')!, /no tool called "read_file"/);
  assert.match(posted.get('d')!, /no more than 2 rounds/);
  assert.deepEqual(ran, ['web_search:0', 'web_search:0', 'web_search:1'], 'run with the round counted here');
  // However many calls come in one round, no more than MAX_HOST_CALLS run.
  const many: string[] = [];
  const flood = hostHandler({ defs: [def('web_search')], rounds: 1, run: async () => (many.push('x'), 'ok') }, new AbortController().signal, async () => undefined);
  for (let i = 0; i < MAX_HOST_CALLS + 30; i++) flood({ id: `f${i}`, name: 'web_search', args: '{}', round: 0 });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(many.length, MAX_HOST_CALLS);
});

test('a flood of calls by names never offered, or in ever new rounds, is not answered without end', async () => {
  let posts = 0;
  const handle = hostHandler({ defs: [def('web_search')], rounds: 2, run: async () => 'ok' }, new AbortController().signal, async () => void posts++);
  const t0 = Date.now();
  for (let i = 0; i < 50_000; i++) handle({ id: `n${i}`, name: 'not_offered', args: '', round: i });
  await new Promise(r => setTimeout(r, 50));
  assert.ok(posts <= MAX_HOST_CALLS * 2, `${posts} answers posted back for calls never offered`);
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  // A call it sent before still has its answer posted again when asked again.
  const again = hostHandler({ defs: [def('web_search')], rounds: 1, run: async () => 'ok' }, new AbortController().signal, async () => void posts++);
  again({ id: 'a1', name: 'web_search', args: '{}', round: 0 });
  for (let i = 0; i < 500; i++) again({ id: `z${i}`, name: 'nope', args: '', round: 0 });
  await new Promise(r => setTimeout(r, 20));
  posts = 0;
  again({ id: 'a1', name: 'web_search', args: '{}', round: 0 });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(posts, 1);
});

test('a PC that is only a guest on the other offers it none of its file tools', async () => {
  const names = ['read_file', 'save_file', 'list_files', 'run_command', 'git_read', 'read_document', 'find_in_text', 'table_stats', 'keep_note', 'screen_look', 'click', 'web_search', 'open_page', 'calculate'];
  const all = { defs: names.map(def), rounds: 6, run: async (name: string, _a: string, _s: AbortSignal, _r: number) => `ran ${name}` };
  const guest = onlyTools(all, GUEST_SIDE_TOOLS)!;
  assert.deepEqual(guest.defs.map((d: any) => d.function.name), ['web_search', 'open_page', 'calculate']);
  assert.match(await guest.run('read_file', '{}', new AbortController().signal, 0), /no tool called/);
  assert.equal(await guest.run('calculate', '{}', new AbortController().signal, 0), 'ran calculate');
  assert.equal(onlyTools({ defs: [def('read_file')], rounds: 1, run: all.run }, GUEST_SIDE_TOOLS), null, 'nothing left: no tools offered');
  // The link uses it when its hello says this PC is a guest there.
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../src/jobrun/links.ts', import.meta.url), 'utf8'), /allTools && h\.guest \? onlyTools\(allTools, GUEST_SIDE_TOOLS\)/);
});
