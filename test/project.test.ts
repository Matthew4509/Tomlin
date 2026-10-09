import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanAnswers, cleanDesign, designBrief, DESIGN_DEFAULT, LAYOUTS, PALETTES, QUESTIONS, sayBack, scopeCard, suggestHires, TYPE_STYLES, wishLine, type Answers, type Candidate } from '../src/project.ts';

test('rounds hold at most four questions, each skippable one has its answer already picked', () => {
  for (const r of [1, 2]) assert.ok(QUESTIONS.filter(q => q.round === r).length <= 4);
  for (const q of QUESTIONS.filter(q => q.kind === 'choice')) assert.ok(q.choices!.some(c => c.id === q.recommended), q.id);
});

test('a skipped or unknown answer is the recommended one, marked Assumed; what is required', () => {
  assert.ok('error' in cleanAnswers({ what: '  ' }));
  const a = cleanAnswers({ what: 'a tip calculator', who: 'customers', why: 'nonsense', when: 'today', assumed: ['where'], must: ['A diner can type the bill', '', 'A diner can pick 10, 15 or 20 per cent'] }) as Answers;
  assert.equal(a.who, 'customers');
  assert.equal(a.why, 'time');
  assert.equal(a.where, 'pc');
  assert.deepEqual(a.must, ['A diner can type the bill', 'A diner can pick 10, 15 or 20 per cent']);
  assert.deepEqual(a.assumed.sort(), ['how', 'where', 'why']);
  assert.equal(a.statement, 'A tip calculator, for my customers, to save time; first, a diner can type the bill.');
});

test('the idea is said back in one line by code', () => {
  assert.equal(sayBack({ what: 'a booking page.', who: 'public', why: 'customers', must: [] }), 'A booking page, for anyone who finds it, to bring in customers.');
});

test('a wish nobody can promise gets one kind line; ordinary words do not', () => {
  assert.match(wishLine('make $1b with a todo app')!, /^Nobody can promise an amount of money/);
  assert.match(wishLine('it should earn a million')!, /money/);
  assert.match(wishLine('make no mistakes')!, /no mistakes/);
  assert.match(wishLine('guaranteed sales')!, /guarantee/);
  assert.match(wishLine('it must go viral')!, /other people/);
  assert.equal(wishLine('a page that lists a million rows quickly'), null);
  assert.equal(wishLine('a perfect tip calculator for 10, 15 or 20 per cent'), null);
});

test('Scope card and design brief together stay near 2,000 characters even with every field full', () => {
  const long = 'x'.repeat(500);
  const a = cleanAnswers({ what: long, statement: long, must: [long, long, long, long, long, long], who: 'staff', why: 'sell', when: 'week', where: 'phones', how: 'pages' }) as Answers;
  const card = scopeCard(a, long);
  for (const t of TYPE_STYLES) for (const p of PALETTES) for (const l of LAYOUTS) {
    const total = card.length + designBrief(cleanDesign({ type: t.id, palette: p.id, layout: l.id, size: 'large', weight: '300' })).length;
    assert.ok(total <= 2200, `${t.id}/${p.id}/${l.id}: ${total}`);
  }
  assert.match(card, /^SCOPE CARD\nStatement: /);
  assert.match(card, /F5\. x+\nWhat:/);
  assert.doesNotMatch(card, /F6/);
});

test('the Scope card lists what was assumed', () => {
  const card = scopeCard(cleanAnswers({ what: 'a tip calculator', assumed: ['who', 'when'] }) as Answers);
  assert.match(card, /F1-F3: the planner picks/);
  assert.match(card, /Assumed \(not answered; change any before planning\): Who = Just me; Must do; Why = Save me time; When = No date; Where = Opens on this PC; How = One page/);
});

test('the design brief names fonts, sizes, every colour role and the layout parts; unknown picks fall back to defaults', () => {
  const d = cleanDesign({ type: 'nope', palette: 'calm', layout: 'split' });
  assert.equal(d.type, DESIGN_DEFAULT.type);
  const b = designBrief(d);
  assert.match(b, /Headings Inter bold 700, body Inter 400/);
  assert.match(b, /h1 60px, h2 40px, h3 24px, body 16px/);
  assert.match(b, /page #F2F7F6, card #FFFFFF, ink #1F3A3A, muted #4F6B6A, brand #2F7F7A, text on brand #FFFFFF, accent #B9852F/);
  assert.match(b, /Form left, result right\): Title, Form \(6\/12\), Result \(6\/12\), Small footer/);
});

const c = (x: Partial<Candidate>): Candidate => ({ kind: 'chat', hire: null, role: null, model: 'Qwen3.5 2B', where: 'This PC', sizeB: 2, ctx: 8192, fit: 'ok', ...x });

test('suggested hires: hired people first, longest context plans, a node artist keeps this PC free', () => {
  const s = suggestHires([
    c({ hire: 'Sam', role: 'coder', model: 'Qwen3.5 2B' }),
    c({ model: 'Gemma 2 9B', sizeB: 9, ctx: 32768, fit: 'tight' }),
    c({ model: 'Llama 70B', sizeB: 70, ctx: 131072, fit: 'no' }),
    c({ kind: 'image', model: 'DreamShaper 8 LCM', sizeB: 0, ctx: 0 }),
    c({ kind: 'image', hire: 'Clara', role: 'artist', model: 'DreamShaper 8 LCM', where: 'Test Node', sizeB: 0, ctx: 0 }),
  ]);
  const by = Object.fromEntries(s.map(x => [x.work, x]));
  assert.equal(by.plan.who, 'Gemma 2 9B');
  assert.match(by.plan.reason, /32K tokens/);
  assert.equal(by.code.who, 'Sam (Qwen3.5 2B)');
  assert.match(by.code.reason, /Sam is your coder, on this PC/);
  assert.equal(by.write.who, 'Gemma 2 9B');
  assert.match(by.write.reason, /nobody is hired as the writer yet\. Only needed for help text/);
  assert.equal(by.pictures.who, 'Clara (DreamShaper 8 LCM)');
  assert.match(by.pictures.reason, /Draws on "Test Node", so this PC stays free/);
});

test('suggested hires with nothing installed say what to get', () => {
  const s = suggestHires([]);
  assert.equal(s.length, 4);
  assert.ok(s.every(x => x.who === null));
  assert.match(s[0].reason, /No chat model fits yet/);
  assert.match(s[3].reason, /Nobody can draw yet/);
});
