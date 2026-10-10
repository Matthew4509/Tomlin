import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awardBehind, awardPeriods, buy, cleanAwards, cleanBought, DOING_WORDS, doingOf, LOUNGE_SPOTS, phasesByWho, purseOf, roomsOf, SHOP, shopView, undoAward, winnerOf, type Bought } from '../src/home.ts';
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
  assert.deepEqual(SHOP.filter(i => ['coffee', 'donuts', 'gym'].includes(i.id)).map(i => [i.id, i.price]), [['coffee', 10_000], ['donuts', 25_000], ['gym', 500_000]]);
  // Too little: says the price and what there is, spends nothing.
  const short = buy('gym', 499_999, [], now);
  assert.ok('error' in short && /500,000/.test(short.error) && /499,999/.test(short.error), JSON.stringify(short));
  assert.ok('error' in buy('caviar', 1e9, [], now));
  let bought = cleanBought({});
  for (const item of ['coffee', 'coffee', 'donuts']) {
    const r = buy(item, 50_000, bought, now);
    assert.ok('bought' in r, item);
    bought = [...bought, r.bought];
  }
  assert.deepEqual(purseOf(50_000, bought), { earned: 50_000, spent: 45_000, left: 5_000 });
  // 5,000 left: no more coffee.
  assert.ok('error' in buy('coffee', 50_000, bought, now));
  const gym = buy('gym', 1_000_000, bought, now);
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

/** Buys each of `items` in turn with plenty of tokens; the purchases kept. */
function bought(...items: string[]): Bought[] {
  let list: Bought[] = [];
  for (const item of items) {
    const r = buy(item, 1e9, list, new Date(2026, 9, 10, 12));
    assert.ok('bought' in r, `${item}: ${'error' in r ? r.error : ''}`);
    list = [...list, r.bought];
  }
  return list;
}

test('every office starts empty: no boardroom, nothing in the lounge, no deck chairs, the kitchen only to rest in', () => {
  // Nothing bought (a new office, or one made before 2.0.50: nothing counts as owned already).
  const none = roomsOf(cleanBought({}));
  assert.deepEqual(none.boardroom, { table: false, chairs: 0, whiteboard: false });
  assert.deepEqual(none.lounge, { armchair: false, bookcase: false, sofa: false, tv: false, gym: false });
  assert.deepEqual(none.rest, ['coffee', 'vending', 'lunch']);
  // Away staff (their PC's owner is using it) wait by the lounge window while the lounge is empty.
  assert.deepEqual(none.away, ['window']);
  assert.equal(none.deckchairs, 0);
  // An office.json from before (awards only, or a gym bought) keeps what it had and nothing more.
  const old = roomsOf(cleanBought({ awards: [], bought: [{ item: 'gym', price: 100_000, at: '2026-10-09' }, { item: 'coffee', price: 2000, at: '2026-10-09' }] }));
  assert.equal(old.boardroom.table, false);
  assert.deepEqual(old.lounge, { armchair: false, bookcase: false, sofa: false, tv: false, gym: true });
  assert.deepEqual(old.rest, ['coffee', 'vending', 'lunch', 'treadmill', 'weights']);
  assert.deepEqual(old.away, ['treadmill', 'weights']);
});

test('what each room offers with some and with all of it bought', () => {
  // Some: a table and one pair of chairs; the armchair.
  const some = roomsOf(bought('table', 'chairs', 'armchair'));
  assert.deepEqual(some.boardroom, { table: true, chairs: 2, whiteboard: false });
  assert.deepEqual(some.rest, ['coffee', 'vending', 'lunch', 'nap']);
  assert.deepEqual(some.away, ['nap']);
  // All: three pairs (six chairs), the whiteboard, every lounge piece, the gym, six deck chairs.
  const all = roomsOf(bought('table', 'chairs', 'chairs', 'chairs', 'whiteboard', 'armchair', 'bookcase', 'sofa', 'tv', 'gym', ...Array(6).fill('deckchair')));
  assert.deepEqual(all.boardroom, { table: true, chairs: 6, whiteboard: true });
  assert.deepEqual(all.lounge, { armchair: true, bookcase: true, sofa: true, tv: true, gym: true });
  assert.deepEqual([...all.rest].sort(), ['chat', 'coffee', 'library', 'lunch', 'nap', 'treadmill', 'tv', 'vending', 'weights']);
  assert.ok(!all.away.includes('window'));
  assert.equal(all.deckchairs, 6);
  // Every lounge place the page draws needs a piece the shop sells.
  for (const [spot, item] of Object.entries(LOUNGE_SPOTS)) assert.ok(SHOP.some(i => i.id === item && i.room === 'lounge'), spot);
});

test('furniture is bought once (chairs a pair at a time to six, deck chairs to six), the chairs after the table, never past the purse', () => {
  const now = new Date(2026, 9, 10, 12);
  // Twice: refused, with where it stands.
  const twice = buy('table', 1e9, bought('table'), now);
  assert.ok('error' in twice && /already/.test(twice.error) && /boardroom/.test(twice.error), JSON.stringify(twice));
  const tv = buy('tv', 1e9, bought('tv'), now);
  assert.ok('error' in tv && /the TV already/.test(tv.error), JSON.stringify(tv));
  // Chairs before the table: refused, and it says to buy the table first.
  const early = buy('chairs', 1e9, [], now);
  assert.ok('error' in early && /table first/.test(early.error), JSON.stringify(early));
  // A fourth pair: refused (six round the table).
  const fourth = buy('chairs', 1e9, bought('table', 'chairs', 'chairs', 'chairs'), now);
  assert.ok('error' in fourth && /six chairs/.test(fourth.error), JSON.stringify(fourth));
  const seventh = buy('deckchair', 1e9, bought(...Array(6).fill('deckchair')), now);
  assert.ok('error' in seventh && /6 deck chairs/.test(seventh.error), JSON.stringify(seventh));
  // Short of tokens: refused with the price and what there is.
  const short = buy('sofa', 59_999, [], now);
  assert.ok('error' in short && /60,000/.test(short.error) && /59,999/.test(short.error), JSON.stringify(short));
  // The shop's view: how many, all bought, waiting for the table.
  const view = shopView(bought('table', 'chairs'));
  assert.deepEqual(view.find(i => i.id === 'chairs'), { ...SHOP.find(i => i.id === 'chairs'), have: 1, owned: false, waits: false });
  assert.equal(view.find(i => i.id === 'table')?.owned, true);
  assert.equal(shopView([]).find(i => i.id === 'chairs')?.waits, true);
  // Each piece is paid for: the purse goes down by its price.
  assert.equal(purseOf(200_000, bought('table', 'chairs', 'whiteboard')).left, 200_000 - 75_000 - 25_000 - 40_000);
});

test('furniture kept on the list for good, however many treats are bought after it', () => {
  const list = [...bought('table', 'deckchair'), ...Array.from({ length: 1200 }, (_, i) => ({ item: 'coffee' as const, price: 10_000, at: String(i) }))];
  const kept = cleanBought({ bought: list });
  assert.equal(kept.filter(b => b.item === 'coffee').length, 1000);
  assert.equal(roomsOf(kept).boardroom.table, true);
  assert.equal(roomsOf(kept).deckchairs, 1);
});

test('the office page reads what is bought from the server, and says On a break and PC off apart', async () => {
  const js = await readFile(new URL('../public/office.js', import.meta.url), 'utf8');
  // Drawn from `rooms` (GET /api/office), not from a first-start flag.
  assert.match(js, /d\.rooms/);
  assert.doesNotMatch(js, /firstStart|first_start/);
  // A long think needs the table: without it they stay at the desk.
  assert.match(js, /\(s\.doing === 'thinking' && \(!longThink \|\| !table\)\)/);
  // The two beach states have their own words and marks.
  assert.match(js, /'On a break'/);
  assert.match(js, /'PC off'/);
  assert.match(js, /powerMark/);
  assert.match(js, /cupMark/);
  // The picture menu: its headings, and how tokens are earned said truly (not "completed work").
  for (const words of ['Look after the team', 'Treat the team', 'Improve the office', 'Gain tokens from work done']) assert.ok(js.includes(words), words);
  assert.doesNotMatch(js, /completed work/i);
  // Coffee is delivered to each of them by a courier (no cart outside to walk to); the menu's words sit at its foot.
  assert.match(js, /kind: 'coffee', who:/);
  assert.doesNotMatch(js, /coffee cart|CART_SPOTS/);
  assert.match(js, /shopTiles, fullSaid\)/);
  // Every lounge place the server names is a REST spot on the page (and the window).
  for (const spot of [...Object.keys(LOUNGE_SPOTS), 'window']) assert.match(js, new RegExp(`id: '${spot}'`), spot);
});
