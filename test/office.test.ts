import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awardBehind, awardPeriods, buy, cleanAwards, cleanBought, DOING_WORDS, doingOf, phasesByWho, purseOf, SHOP, shopView, undoAward, winnerOf } from '../src/home.ts';
import { ByStaff } from '../src/meter.ts';

const at = (o: Partial<Parameters<typeof doingOf>[0]>) => doingOf({ state: 'on', away: false, remoteBusy: false, phase: null, picture: false, job: false, ...o });

test('what a hire is doing: their PC first, then their answer, then a project step, then resting', () => {
  assert.equal(at({ away: true, phase: 'writing' }), 'owner');
  assert.equal(at({ state: 'off' }), 'off');
  assert.equal(at({ state: 'none' }), 'nodesk');
  assert.equal(at({ picture: true, phase: 'writing' }), 'drawing');
  assert.equal(at({ phase: 'writing' }), 'typing');
  assert.equal(at({ phase: 'thinking' }), 'thinking');
  assert.equal(at({ phase: 'reading' }), 'researching');
  assert.equal(at({ phase: 'waiting' }), 'waiting');
  assert.equal(at({ remoteBusy: true }), 'waiting');
  assert.equal(at({ job: true }), 'working');
  assert.equal(at({ state: 'waking' }), 'arriving');
  // An answer asked while the model still loads: getting ready, not researching.
  assert.equal(at({ state: 'waking', phase: 'reading' }), 'arriving');
  assert.equal(at({ state: 'asleep' }), 'resting');
  assert.equal(at({}), 'resting');
  // Every state has its words, and none of them guesses a pronoun.
  for (const [k, words] of Object.entries(DOING_WORDS)) {
    assert.ok(words.length > 3, k);
    assert.doesNotMatch(words, /\b(he|she|his|her|him)\b/i, k);
  }
});

test('an answer is reading until it thinks or writes; waiting for the runner is said apart; the furthest one counts', () => {
  const m = phasesByWho([
    { who: 'staff:maya', waiting: false },
    { who: 'staff:otto', waiting: true },
    { who: 'staff:nora', waiting: false, phase: 'thinking' },
    { who: 'staff:nora', waiting: false, phase: 'writing' },
    { who: 'staff:clara', waiting: false, phase: 'writing' },
    { who: 'staff:clara', waiting: true },
    { who: '', waiting: false, phase: 'writing' },
  ]);
  assert.equal(m.get('staff:maya'), 'reading');
  assert.equal(m.get('staff:otto'), 'waiting');
  assert.equal(m.get('staff:nora'), 'writing');
  assert.equal(m.get('staff:clara'), 'writing');
  assert.equal(m.has(''), false);
});

test('the office page script is one closed function that adds only app.office, and reads the server words', async () => {
  const js = await readFile(new URL('../public/office.js', import.meta.url), 'utf8');
  const body = js.replace(/^(\/\/.*\n)*/, '').trim();
  assert.match(body, /^'use strict';\s*\n\s*\(\(\) => \{/);
  assert.match(body, /\}\)\(\);$/);
  assert.match(js, /app\.office = /);
  // Each state the server sends has a place in the office.
  for (const k of Object.keys(DOING_WORDS)) assert.match(js, new RegExp(`\\b${k}\\b`), k);
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('src="look.js"') < html.indexOf('src="office.js"'), 'office.js after look.js');
});

test('award periods: this month from the 1st, this week from Monday (a Sunday belongs to the week before it)', () => {
  const thu = awardPeriods(new Date(2026, 9, 8, 15, 0));
  assert.deepEqual([thu.month, thu.monthFrom, thu.weekFrom, thu.today], ['2026-10', '2026-10-01', '2026-10-05', '2026-10-08']);
  assert.equal(thu.monthName, 'October 2026');
  assert.equal(awardPeriods(new Date(2026, 9, 11, 23, 0)).weekFrom, '2026-10-05');
  assert.equal(awardPeriods(new Date(2026, 9, 12, 0, 5)).weekFrom, '2026-10-12');
  // A week over the turn of a month starts in the month before.
  assert.equal(awardPeriods(new Date(2026, 10, 1)).weekFrom, '2026-10-26');
});

test('employee of the month: one award a month (awarded again, the newer stands), the winner wrote something', () => {
  const kept = cleanAwards({ awards: [
    { month: '2026-09', id: 'maya', name: 'Maya', out: 900, at: 'x' },
    { month: '2026-10', id: 'otto', name: 'Otto', out: 10, at: 'x' },
    { month: '2026-10', id: 'nora', name: 'Nora', out: 50, at: 'y' },
    { month: 'October', id: 'bad' },
    'nonsense',
  ] });
  assert.deepEqual(kept.map(a => `${a.month} ${a.id}`), ['2026-09 maya', '2026-10 nora']);
  assert.deepEqual(cleanAwards(null), []);
  assert.equal(winnerOf([{ id: 'a', out: 0 }]), null);
  assert.equal(winnerOf([]), null);
  assert.deepEqual(winnerOf([{ id: 'b', out: 7 }, { id: 'a', out: 3 }]), { won: { id: 'b', out: 7 } });
});

test('employee of the month: the most wins in any order, and a shared most is no one winner', () => {
  // Not sorted (a hire who wrote nothing first, the leader last): the order of the board does not pick the winner.
  assert.deepEqual(winnerOf([{ id: 'otto', out: 0 }, { id: 'nora', out: 3 }, { id: 'wendy', out: 123 }]), { won: { id: 'wendy', out: 123 } });
  assert.deepEqual(winnerOf([{ id: 'nora', out: 50 }, { id: 'otto', out: 50 }, { id: 'maya', out: 2 }]), { tied: [{ id: 'nora', out: 50 }, { id: 'otto', out: 50 }] });
});

test('employee of the month: an award given early in the month says when someone has written more since', () => {
  const awards = cleanAwards({ awards: [
    { month: '2026-09', id: 'maya', name: 'Maya', out: 900, at: 'x' },
    { month: '2026-10', id: 'nora', name: 'Nora', out: 3, at: 'y' },
  ] });
  // The stored October award (Nora, 3) while Wendy has written 123 since: Wendy leads now.
  assert.equal(awardBehind(awards, '2026-10', [{ id: 'wendy', out: 123 }, { id: 'nora', out: 3 }])?.id, 'wendy');
  assert.equal(awardBehind(awards, '2026-10', [{ id: 'nora', out: 130 }, { id: 'wendy', out: 123 }]), null);
  // Level now: nobody is ahead of the award yet.
  assert.equal(awardBehind(awards, '2026-10', [{ id: 'nora', out: 9 }, { id: 'wendy', out: 9 }]), null);
  // No award this month: nothing to fall behind.
  assert.equal(awardBehind(awards, '2026-11', [{ id: 'wendy', out: 5 }]), null);
});

test("Undo award takes off only that month's award, and finds none to undo after", () => {
  const awards = cleanAwards({ awards: [
    { month: '2026-09', id: 'maya', name: 'Maya', out: 900, at: 'x' },
    { month: '2026-10', id: 'nora', name: 'Nora', out: 3, at: 'y' },
  ] });
  const u = undoAward(awards, '2026-10');
  assert.equal(u?.undone.id, 'nora');
  assert.deepEqual(u?.awards.map(a => a.month), ['2026-09']);
  assert.equal(awards.length, 2, 'the list given is not changed');
  assert.equal(undoAward(u!.awards, '2026-10'), null);
  assert.equal(undoAward([], '2026-10'), null);
});

test('tokens written are counted per hire per day, and a board covers only the days asked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-office-'));
  try {
    const by = new ByStaff(join(dir, 'usage-staff.json'));
    const used = (out: number) => ({ in: 100, cached: 0, out, ms: 10 });
    by.add('maya', used(40), new Date(2026, 8, 30, 12));
    by.add('maya', used(5), new Date(2026, 9, 6, 12));
    by.add('otto', used(20), new Date(2026, 9, 7, 12));
    by.add('otto', used(1), new Date(2026, 9, 8, 9));
    assert.deepEqual(by.writtenBetween('2026-10-01', '2026-10-08'), [{ id: 'otto', out: 21 }, { id: 'maya', out: 5 }]);
    assert.deepEqual(by.writtenBetween('2026-09-01', '2026-09-30'), [{ id: 'maya', out: 40 }, { id: 'otto', out: 0 }]);
    // The all-time tally is unchanged by the per-day count.
    assert.equal(by.of('maya').tally.out, 45);
    // The office shop's money: everything everyone wrote.
    assert.equal(by.totalWritten(), 66);
    await by.flush();
    const again = await new ByStaff(join(dir, 'usage-staff.json')).load();
    assert.deepEqual(again.writtenBetween('2026-10-01', '2026-10-08'), [{ id: 'otto', out: 21 }, { id: 'maya', out: 5 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the office shop is paid from the tokens written: treats again and again, the gym once, never past the purse', () => {
  const now = new Date(2026, 9, 9, 21);
  assert.deepEqual(SHOP.map(i => [i.id, i.price]), [['coffee', 2000], ['donuts', 5000], ['gym', 100000]]);
  // Too little: says the price and what there is, spends nothing.
  const short = buy('gym', 99_999, [], now);
  assert.ok('error' in short && /100,000/.test(short.error) && /99,999/.test(short.error), JSON.stringify(short));
  assert.ok('error' in buy('caviar', 1e9, [], now));
  let bought = cleanBought({});
  for (const item of ['coffee', 'coffee', 'donuts']) {
    const r = buy(item, 10_000, bought, now);
    assert.ok('bought' in r, item);
    bought = [...bought, r.bought];
  }
  assert.deepEqual(purseOf(10_000, bought), { earned: 10_000, spent: 9_000, left: 1_000 });
  // 1,000 left: no more coffee.
  assert.ok('error' in buy('coffee', 10_000, bought, now));
  const gym = buy('gym', 200_000, bought, now);
  assert.ok('bought' in gym);
  bought = [...bought, gym.bought];
  assert.equal(shopView(bought).find(i => i.id === 'gym')?.owned, true);
  assert.equal(shopView(bought).find(i => i.id === 'coffee')?.owned, false);
  // Bought once, kept: not again, however rich.
  assert.ok('error' in buy('gym', 1e9, bought, now));
  // Kept as JSON and read back; junk is dropped; the purse never goes below 0.
  assert.deepEqual(cleanBought(JSON.parse(JSON.stringify({ bought: [...bought, { item: 'yacht', price: 1 }, null] }))), bought);
  assert.equal(purseOf(5, bought).left, 0);
});
