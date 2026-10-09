import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChat, cleanNote, fitLines, frontCap, isScope, jobFront, Notebooks, olderSummary, pickLines, rememberCommand, takeSuggestion, type NoteLine } from '../src/memory.ts';
import { budget, workerSystem, type Job, type Step } from '../src/jobs.ts';
import { Store, type ChatLine } from '../src/store.ts';

const note = (text: string, i = 0): NoteLine => ({ id: `n${i}`, text, at: '2026-10-04T10:00:00Z', from: 'owner' });
const line = (role: 'user' | 'assistant', content: string): ChatLine => ({ role, content, at: '2026-10-04T10:00:00Z' });

test('"remember: ..." is a command; "remember for the team" goes to the team; ordinary talk is not', () => {
  assert.deepEqual(rememberCommand('remember: the shop closes on Mondays'), { team: false, text: 'the shop closes on Mondays' });
  assert.deepEqual(rememberCommand('Remember that my name is Sam'), { team: false, text: 'my name is Sam' });
  assert.deepEqual(rememberCommand('remember for the team: prices include VAT'), { team: true, text: 'prices include VAT' });
  assert.equal(rememberCommand('Do you remember what I said?'), null);
  // A question that starts "remember that" is answered, not kept; a comma is talk, not a command.
  assert.equal(rememberCommand('Remember that film? What was it called?'), null);
  assert.equal(rememberCommand('Remember, you said the shop shuts at five'), null);
  assert.deepEqual(rememberCommand('remember - the van is booked on Fridays'), { team: false, text: 'the van is booked on Fridays' });
  assert.equal(rememberCommand('remember:   '), null);
  assert.equal(cleanNote('x'.repeat(500)).length, 300);
});

test('a REMEMBER line comes off the answer as a suggestion only', () => {
  assert.deepEqual(takeSuggestion('Got it, Mondays off.\nREMEMBER: The shop closes on Mondays.'), { answer: 'Got it, Mondays off.', suggest: 'The shop closes on Mondays.' });
  assert.deepEqual(takeSuggestion('**REMEMBER:** Sam likes short answers'), { answer: '', suggest: 'Sam likes short answers' });
  assert.deepEqual(takeSuggestion('No line here.'), { answer: 'No line here.', suggest: null });
});

test('notebook names: team or staff:<id>, nothing else (no private notebook)', () => {
  assert.ok(isScope('team'));
  assert.ok(isScope('staff:theo'));
  assert.ok(!isScope('partner'));
  assert.ok(!isScope('staff:../x'));
});

test('when the lines do not fit, the ones on the topic are kept, in notebook order', () => {
  const lines = [note('The shop closes on Mondays', 1), note('Invoices go out on the first of the month', 2), note('The logo is navy and gold', 3), note('Sam prefers short answers', 4)];
  assert.equal(pickLines(lines, 'anything', 1000).left, 0);
  const got = pickLines(lines, 'what colour is the logo on invoices?', 80);
  assert.deepEqual(got.lines.map(l => l.id), ['n2', 'n3']);
  assert.equal(got.left, 2);
});

test('the older chat is summed up by code: first sentence each, newest kept when short of room', () => {
  const s = olderSummary([line('user', 'Hello there. I run a bakery.'), line('assistant', 'Nice to meet you! What can I do?'), line('user', 'I need a price list.')], 'Theo', 1000);
  // A first sentence under 12 characters ("Hello there.") takes the next one with it.
  assert.equal(s, '- They: Hello there. I run a bakery.\n- Theo: Nice to meet you!\n- They: I need a price list.');
  const short = olderSummary([line('user', 'Number one is here.'), line('user', 'Number two is here.'), line('user', 'Number three is here.')], 'Theo', 80);
  assert.match(short, /^\(1 older message before this not shown\)\n- They: Number two is here\.\n- They: Number three is here\.$/);
});

test('one builder, every context size: card first, notebooks, summary, recent; always inside the room', () => {
  const card = 'You are Theo, the coder.';
  const history: ChatLine[] = [];
  for (let i = 0; i < 400; i++) history.push(line(i % 2 ? 'assistant' : 'user', `Message ${i}. ${'word '.repeat(60)}`));
  const team = Array.from({ length: 150 }, (_, i) => note(`Team fact ${i} about ${i % 3 ? 'prices' : 'the logo'} and more words here`, i));
  for (const ctx of [4096, 8192, 32768, 131072, 262144]) {
    const c = buildChat({ ctx, maxAnswer: 2048, card, rules: 'RULE', team, own: [note('Theo likes tabs')], name: 'Theo', history, message: 'What about the logo?' });
    assert.ok(c.used <= c.room, `${ctx}: ${c.used} > ${c.room}`);
    assert.ok(c.answerTokens <= ctx / 4);
    assert.equal(c.turns[0].role, 'system');
    assert.ok(c.turns[0].content.startsWith(card));
    assert.equal(c.turns.at(-1)!.content, 'What about the logo?');
    assert.deepEqual(c.parts.map(p => p.key), ['card', 'team', 'own', 'summary', 'recent', 'message']);
    // A bigger model reads more of the chat.
    if (ctx === 4096) assert.equal(c.parts.find(p => p.key === 'summary')!.state, 'cut');
  }
  const small = buildChat({ ctx: 4096, maxAnswer: 2048, card, team, own: null, name: 'Theo', history, message: 'hi' });
  const big = buildChat({ ctx: 262144, maxAnswer: 2048, card, team, own: null, name: 'Theo', history, message: 'hi' });
  assert.ok(big.turns.length > small.turns.length);
  assert.equal(big.parts.find(p => p.key === 'team')!.state, 'whole');
  assert.equal(small.parts.find(p => p.key === 'team')!.state, 'cut');
});

test('a short chat is sent whole; no notebook lines means the part says empty', () => {
  const c = buildChat({ ctx: 8192, maxAnswer: 2048, card: 'card', team: [], own: null, name: 'TOMLIN', history: [line('user', 'hi'), line('assistant', 'hello')], message: 'and?' });
  assert.equal(c.turns.length, 4);
  assert.equal(c.parts.find(p => p.key === 'summary')!.state, 'none');
  assert.equal(c.parts.find(p => p.key === 'team')!.state, 'none');
  assert.equal(c.parts.find(p => p.key === 'own'), undefined);
});

test('a fault kept in the chat (a turn that failed before any answer) is never sent to the model', () => {
  const failed: ChatLine = { ...line('assistant', 'Qwen needs about 23.5 GB with its context, and only 19.1 GB is free.'), failed: true };
  const c = buildChat({ ctx: 8192, maxAnswer: 2048, card: 'card', team: [], own: null, name: 'TOMLIN', history: [line('user', 'write a story'), failed], message: 'try again' });
  assert.equal(c.turns.length, 3);
  assert.ok(!c.turns.some(t => t.content.includes('23.5 GB')));
});

test('job packets: Scope card and design brief come first, whole at 8K, cut at 4K, never past the cap', () => {
  const scope = `SCOPE CARD\nStatement: a tip calculator\nMust do on day one:\nF1. Type the bill\nF2. Pick a tip\n${'Who: x · Why: y\n'.repeat(80)}`.slice(0, 1300);
  const design = `DESIGN BRIEF\nType: Warm Editorial\nSizes: h1 48px\nColours: page #fff\nLayout: one card`;
  const at8 = jobFront(8192, { scope, design }, [note('Prices include VAT')], [note('Theo uses tabs')], 'tip');
  assert.ok(at8.text.startsWith('SCOPE CARD'));
  assert.ok(at8.text.includes(design));
  assert.ok(at8.text.includes('Prices include VAT') && at8.text.includes('Theo uses tabs'));
  const at4 = jobFront(4096, { scope, design }, [note('Prices include VAT')], null, 'tip');
  assert.ok(at4.text.length <= frontCap(4096) + 10, String(at4.text.length));
  assert.ok(at4.text.startsWith('SCOPE CARD\nStatement: a tip calculator\nMust do on day one:\nF1. Type the bill'));
  assert.ok(at4.text.includes('DESIGN BRIEF\nType: Warm Editorial'));
  assert.equal(at4.parts.find(p => p.key === 'scope')!.state, 'cut');
  // No project and empty notebooks: nothing in front, the budget is as before.
  assert.equal(jobFront(8192, null, [], null, '').text, '');
  assert.deepEqual(budget(8192, 0), budget(8192));
  assert.ok(budget(8192, 2400).input < budget(8192).input);
});

test('fitLines keeps whole lines and says how many were left out', () => {
  assert.equal(fitLines('a\nb', 10), 'a\nb');
  assert.match(fitLines('first line here\nsecond line here\nthird line here', 47), /^first line here\n\[… 2 more lines left out: no room in this model\]$/);
  assert.ok(fitLines(`${'x'.repeat(500)}\nb`, 100).length <= 100);
});

test('the front goes first in the worker packet', () => {
  const step: Step = { title: 'Make the page', role: 'coder', files: ['index.html'], brief: 'b', check: '', status: 'todo', summary: '', wrote: [] };
  const job: Job = { id: '20261004-1000-abcd', goal: 'g', created: '', updated: '', notes: '', steps: [step] };
  assert.ok(workerSystem('You are a coder.', job, step, 1, 'SCOPE CARD\nx').startsWith('SCOPE CARD'));
  assert.ok(workerSystem('You are a coder.', job, step, 1).startsWith('You are a coder.'));
});

test('notebooks on disk: add, no repeats, edit, delete, nothing for a bad name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-memory-'));
  try {
    const books = new Notebooks(new Store(dir));
    const a = await books.add('staff:theo', 'Theo uses tabs', 'owner');
    assert.ok(!('error' in a));
    await books.add('staff:theo', 'theo uses TABS', 'pin');
    assert.equal((await books.read('staff:theo')).length, 1);
    assert.equal((await books.read('team')).length, 0);
    const e = await books.edit('staff:theo', (a as NoteLine).id, 'Theo uses two spaces');
    assert.equal((e as NoteLine).text, 'Theo uses two spaces');
    assert.ok('error' in (await books.edit('staff:theo', (a as NoteLine).id, '   ')));
    assert.ok(await books.remove('staff:theo', (a as NoteLine).id));
    assert.equal((await books.read('staff:theo')).length, 0);
    assert.ok('error' in (await books.add('partner', 'x', 'owner')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
