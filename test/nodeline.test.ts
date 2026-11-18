// A node's line (src/nodeline.ts): first come, first served, the host's own links before guests (a setting), one
// request per guest, a place and an estimate for each, a stuck one let go, the caps on a guest's answer and prompt,
// and the rule that a guest's load never takes the place of a model the PC's owner is using. Plain functions; the line
// at a real node door is test/nodeline-door.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nl from '../src/nodeline.ts';

const T0 = 1_000_000;
let now = T0;
const line = (hostFirst = true, slots = 1) => new nl.NodeLine({ hostFirst: () => hostFirst, slots: () => slots, now: () => now });
const admin = (name: string) => ({ link: `admin-${name}`, name, guest: false, what: 'chat' as const, model: 'm1' });
const guest = (name: string) => ({ link: `guest-${name}`, name, guest: true, what: 'chat' as const, model: 'm1' });
const join = (l: nl.NodeLine, e: Parameters<nl.NodeLine['join']>[0]) => {
  now += 10;
  const r = l.join(e);
  assert.ok(!('error' in r), JSON.stringify(r));
  return r as nl.LineEntry;
};

test('first come, first served; the host\'s own links go before guests, first come among each', () => {
  const l = line();
  const g1 = join(l, guest('g1'));
  const a1 = join(l, admin('a1'));
  const g2 = join(l, guest('g2'));
  const a2 = join(l, admin('a2'));
  assert.deepEqual(l.waiting().map(x => x.name), ['a1', 'a2', 'g1', 'g2']);
  assert.equal(l.place(a1.id), 1);
  assert.equal(l.place(g2.id), 4);
  assert.equal(l.mayStart(a1.id), true);
  assert.equal(l.mayStart(g1.id), false, 'not its turn');
  void g2;
  void a2;
});

test('"Host goes first" off: one line for all, first come first served', () => {
  const l = line(false);
  join(l, guest('g1'));
  join(l, admin('a1'));
  join(l, guest('g2'));
  assert.deepEqual(l.waiting().map(x => x.name), ['g1', 'a1', 'g2']);
});

test('one at a time by default: the next starts when the one running ends; with more slots, that many', () => {
  const l = line();
  const a = join(l, admin('a'));
  const b = join(l, guest('b'));
  l.start(a.id);
  assert.equal(l.mayStart(b.id), false, 'a is running');
  assert.equal(l.place(b.id), 1);
  l.leave(a.id);
  assert.equal(l.mayStart(b.id), true);
  const two = line(true, 2);
  const x = join(two, admin('x'));
  const y = join(two, guest('y'));
  two.start(x.id);
  assert.equal(two.mayStart(y.id), true, 'a second slot is free');
});

test('one request in the line per guest (waiting or running); a host link may have several', () => {
  const l = line();
  const g = join(l, guest('g'));
  const again = l.join(guest('g'));
  assert.ok('error' in again);
  assert.match((again as { error: string }).error, /one request/);
  l.start(g.id);
  assert.ok('error' in l.join(guest('g')), 'running counts too');
  l.leave(g.id);
  assert.ok(!('error' in l.join(guest('g'))));
  join(l, admin('a'));
  assert.ok(!('error' in l.join(admin('a'))), 'a host link may have several');
});

test('cancelled or disconnected: it leaves the line; one waiting too long is let go', () => {
  const l = line();
  const a = join(l, admin('a'));
  const b = join(l, guest('b'));
  l.start(a.id);
  l.leave(b.id);
  assert.deepEqual(l.waiting(), []);
  const c = join(l, guest('c'));
  now += nl.LINE_WAIT_MS + 1;
  assert.deepEqual(l.stuck().map(x => x.id), [c.id]);
  assert.match(nl.STUCK_WORDS, /waited/);
});

test('its place, with an estimate from the measured time of that model\'s answers where known', () => {
  assert.equal(nl.ordinal(1), '1st');
  assert.equal(nl.ordinal(2), '2nd');
  assert.equal(nl.ordinal(3), '3rd');
  assert.equal(nl.ordinal(11), '11th');
  assert.equal(nl.ordinal(22), '22nd');
  const times = new nl.AnswerTimes();
  assert.equal(nl.lineWords(2, 1, times.average('m1')), '2nd in line. It starts when its turn comes (or press Stop).');
  times.note('m1', 20_000);
  times.note('m1', 20_000);
  assert.equal(times.average('m1'), 20_000);
  assert.equal(nl.lineWords(2, 1, times.average('m1')), '2nd in line, about 40 s. It starts when its turn comes (or press Stop).');
  assert.equal(nl.lineWords(1, 1, times.average('m1')), '1st in line, about 20 s. It starts when its turn comes (or press Stop).');
  assert.equal(nl.lineWords(3, 1, 60_000), '3rd in line, about 3 min. It starts when its turn comes (or press Stop).');
  for (let i = 0; i < 20; i++) times.note('m2', 1000 * (i + 1));
  assert.equal(times.average('m2'), 15_500, 'the last 10 count');
});

test('an older TOMLIN that does not know the line is told busy, as before, while anyone is in the line', () => {
  const l = line();
  assert.equal(l.busyForOld(), false);
  const a = join(l, admin('a'));
  assert.equal(l.busyForOld(), true);
  l.start(a.id);
  assert.equal(l.busyForOld(), true);
  l.leave(a.id);
  assert.equal(l.busyForOld(), false);
});

test('the guest caps: answer length clamped, a prompt over the cap refused, both shown; the owner may change them', () => {
  assert.deepEqual(nl.GUEST_CAPS, { answer: 2000, prompt: 32000 });
  assert.deepEqual(nl.cleanCaps({ answer: '4000', prompt: 9_999_999 }), { answer: 4000, prompt: 200_000 });
  assert.deepEqual(nl.cleanCaps({ answer: 10, prompt: 'x' }), { answer: 256, prompt: 32000 });
  assert.deepEqual(nl.cleanCaps(undefined), nl.GUEST_CAPS);
  const caps = { answer: 2000, prompt: 100 };
  assert.equal(nl.capAnswer(8000, caps), 2000);
  assert.equal(nl.capAnswer(500, caps), 500);
  assert.equal(nl.promptRefusal({ system: 'x'.repeat(40), user: 'y'.repeat(60) }, caps), null);
  assert.match(nl.promptRefusal({ system: '', user: 'y'.repeat(101) }, caps)!, /100 characters/);
  assert.match(nl.promptRefusal({ turns: [{ role: 'user', content: 'z'.repeat(60) }, { role: 'assistant', content: 'z'.repeat(60) }] }, caps)!, /guest/);
  assert.equal(nl.capsWords(caps), 'answers up to 2000 tokens, prompts up to 100 characters');
});

test('a guest\'s tool definitions count in its prompt; its tools run few rounds and calls, and what they give back counts against its cap', async () => {
  const def = { type: 'function', function: { name: 'read_file', description: 'd'.repeat(3000), parameters: { type: 'object' } } };
  const caps = { answer: 2000, prompt: 2000 };
  assert.equal(nl.promptRefusal({ user: 'hi' }, caps), null);
  assert.match(nl.promptRefusal({ user: 'hi', tools: { defs: [def], rounds: 24, parallel: [] } }, caps)!, /2000 characters/, 'a short message with a long tool list is over the cap');
  assert.ok(nl.promptSize({ user: 'hi', tools: { defs: [def], rounds: 1, parallel: [] } }) > 3000);
  // The tools: 24 rounds asked, 4 given; results count against the room left, then are cut, then not run at all.
  let ran = 0;
  const box = nl.guestBox({ defs: [def], rounds: 24, run: async () => (ran++, 'r'.repeat(600)) }, 1000);
  assert.equal(box.rounds, nl.GUEST_TOOL_ROUNDS);
  const ac = new AbortController();
  assert.equal((await box.run('read_file', '{}', ac.signal, 0)).length, 600);
  assert.match(await box.run('read_file', '{}', ac.signal, 0), /^r{400}\n\[The rest was left out/);
  assert.match(await box.run('read_file', '{}', ac.signal, 1), /full, so this tool was not run/);
  assert.equal(ran, 2, 'a tool past the room is not run');
  // And no more than GUEST_TOOL_CALLS calls in one answer, however short the results.
  const many = nl.guestBox({ defs: [def], rounds: 2, run: async () => 'ok' }, 1_000_000);
  const said: string[] = [];
  for (let i = 0; i < nl.GUEST_TOOL_CALLS + 2; i++) said.push(await many.run('read_file', '{}', ac.signal, 0));
  assert.equal(said.filter(s => s === 'ok').length, nl.GUEST_TOOL_CALLS);
  assert.match(said.at(-1)!, /times at most/);
  assert.equal(many.rounds, 2, 'fewer rounds asked stay fewer');
});

test('a guest\'s load waits for the owner: never in place of a model answering, or one the owner used in the last 5 minutes', () => {
  assert.equal(nl.OWNER_IDLE_MS, 5 * 60_000);
  const base = { placeError: null, busy: false, loadedOrBusy: true, guest: true, replaces: null, name: 'Big model', pc: 'Office node' };
  assert.equal(nl.chatTurn(base, T0), 'go');
  assert.match((nl.chatTurn({ ...base, busy: true }, T0) as { wait: string }).wait, /answering/);
  // The owner's model, used 1 minute ago: a guest waits; a model loaded for linked PCs may make way.
  const owners = { forLinked: false, busy: false, usedAt: T0 - 60_000 };
  assert.match((nl.chatTurn({ ...base, replaces: owners }, T0) as { wait: string }).wait, /owner/);
  assert.equal(nl.chatTurn({ ...base, replaces: { ...owners, usedAt: T0 - 6 * 60_000 } }, T0), 'go', 'idle 5 minutes: it may make way');
  assert.equal(nl.chatTurn({ ...base, replaces: { ...owners, forLinked: true } }, T0), 'go');
  assert.equal(nl.chatTurn({ ...base, guest: false, replaces: owners }, T0), 'go', 'the host\'s own link: as before');
});

test('a model that does not fit now waits its turn for room; one that can never fit there is refused, said for the asker', () => {
  const base = { placeError: 'Big model needs about 40 GB with its context, and only 12 GB is free. Close other programs (or drop a model with Drop in the top bar), or choose a smaller model or context.', busy: false, guest: true, replaces: null, name: 'Big model', pc: 'Office node' };
  assert.match((nl.chatTurn({ ...base, loadedOrBusy: true }, T0) as { wait: string }).wait, /room/);
  const no = nl.chatTurn({ ...base, loadedOrBusy: false }, T0) as { refuse: string };
  assert.match(no.refuse, /^Big model is too big for "Office node" even with nothing else loaded there/);
  assert.doesNotMatch(no.refuse, /Drop in the top bar|Close other programs/, 'no words meant for the owner of that PC');
});
