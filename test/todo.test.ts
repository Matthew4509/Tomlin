// The To Do (src/todo.ts): Today / This week / This month, sizes, carry-over, done rows and quick checks, and its file.
// Every date is set by the test, so the results never depend on the day it runs. Projects are made up.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as T from '../src/todo.ts';

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const fresh = () => T.normalize(null);
const MON = '2026-10-26';
const TUE = '2026-10-27';
const WED = '2026-10-28';
const A = 'folder:alpha-1a2b3c';
const B = 'folder:beta-4d5e6f';
const G = 'job:gamma-777777';
const names: Record<string, string> = { [A]: 'Alpha', [B]: 'Beta', [G]: 'Gamma' };
const ok = (r: { ok: boolean }) => assert.equal(r.ok, true, JSON.stringify(r));
const added = (r: T.Result) => { ok(r); return (r as { item: T.Item }).item; };

test('add: a row goes in its part with its size and note; Today\'s sizes add up against the day', () => {
  const s = fresh();
  ok(T.add(s, { project: A, name: 'Alpha', size: 120, note: 'fix the header', zone: 'today' }, MON));
  ok(T.add(s, { project: B, name: 'Beta', size: 15, zone: 'today' }, MON));
  ok(T.add(s, { project: G, name: 'Gamma', size: 480, zone: 'month' }, MON));
  const v = T.view(s, MON, names);
  assert.deepEqual(v.zones.map(z => z.items.map(i => i.name)), [['Alpha', 'Beta'], [], ['Gamma']]);
  assert.equal(v.zones[0].items[0].note, 'fix the header');
  assert.equal(v.zones[2].items[0].type, 'job', 'a TOMLIN project says so (it can be opened)');
  assert.equal(v.zones[0].items[0].type, 'folder');
  assert.equal(v.total.todayMin, 135);
  assert.equal(v.total.text, 'Today 2 h 15 of 8 h');
  assert.equal(v.open, 2);
});

test('over the day: said plainly, never refused', () => {
  const s = fresh();
  for (const size of [480, 60]) ok(T.add(s, { project: A, size, zone: 'today' }, MON));
  assert.equal(T.view(s, MON, names).total.text, 'Today 9 h of 8 h: 1 h over');
  ok(T.setSettings(s, { dayHours: 12 }));
  assert.equal(T.view(s, MON, names).total.text, 'Today 9 h of 12 h');
  assert.equal(T.setSettings(s, { dayHours: 20 }).ok, false, 'a day is 1-16 h');
  assert.equal(T.setSettings(s, { checksPerDay: 3 }).ok, false, 'quick checks come 1 or 2 a day');
});

test('nothing drops off: an unfinished Today row is still in Today the next day, marked with its day', () => {
  const s = fresh();
  T.add(s, { project: A, zone: 'today' }, MON);
  const v = T.view(s, WED, names);
  assert.equal(v.zones[0].items.length, 1);
  assert.equal(v.zones[0].items[0].from, 'Mon 26');
  assert.equal(T.view(s, MON, names).zones[0].items[0].from, null, 'not marked on the day it came in');
});

test('move: between parts and before another row; into Today it takes today\'s date', () => {
  const s = fresh();
  const a = added(T.add(s, { project: A, zone: 'week' }, MON));
  const b = added(T.add(s, { project: B, zone: 'today' }, MON));
  ok(T.move(s, a.id, 'today', b.id, WED));
  const v = T.view(s, WED, names);
  assert.deepEqual(v.zones[0].items.map(i => i.name), ['Alpha', 'Beta']);
  assert.equal(v.zones[0].items[0].from, null, 'moved in today: not carried');
  assert.equal(v.zones[0].items[1].from, 'Mon 26');
  assert.equal(T.move(s, a.id, 'someday', null, WED).ok, false, 'an unknown part is refused');
  assert.equal(T.move(s, 'deadbeef00', 'today', null, WED).ok, false, 'an unknown row is refused');
});

test('done today shows and counts in the day; earlier done rows show for this week, this month, or are hidden', () => {
  const s = fresh();
  const a = added(T.add(s, { project: A, zone: 'today', size: 60 }, MON));
  T.add(s, { project: B, zone: 'today', size: 120 }, MON);
  T.done(s, a.id, true, TUE);
  let v = T.view(s, TUE, names);
  assert.deepEqual(v.zones[0].items.map(i => i.name), ['Beta'], 'a done row leaves its part');
  assert.deepEqual(v.doneToday.map(i => i.name), ['Alpha'], 'done today shows');
  assert.equal(v.total.text, 'Today 3 h of 8 h · 1 h done', 'the day counts what was done today and what is left');
  const q = added(T.add(s, { project: G, zone: 'today', size: 15 }, TUE));
  T.done(s, q.id, true, TUE);
  assert.equal(T.view(s, TUE, names).total.text, 'Today 3 h 15 of 8 h · 1 h 15 done');
  T.remove(s, q.id);
  const quick = fresh();
  T.done(quick, added(T.add(quick, { project: A, zone: 'today', size: 15 }, TUE)).id, true, TUE);
  assert.equal(T.view(quick, TUE, names).total.text, 'Today 15 min of 8 h · 15 min done', 'under an hour in minutes, not "0 h 15"');
  v = T.view(s, WED, names);
  assert.equal(v.doneToday.length, 0);
  assert.deepEqual(v.doneEarlier.items.map(i => i.name), ['Alpha'], 'the next day: earlier this week');
  assert.equal(v.doneEarlier.name, 'Done earlier this week');
  assert.equal(T.view(s, '2026-11-03', names).doneEarlier.items.length, 0, 'next week: no longer listed');
  T.setSettings(s, { doneShow: 'month' });
  assert.deepEqual(T.view(s, '2026-10-30', names).doneEarlier.items.map(i => i.name), ['Alpha'], 'this month');
  assert.equal(T.view(s, '2026-11-03', names).doneEarlier.items.length, 0, 'a new month: no longer listed');
  T.setSettings(s, { doneShow: 'hide' });
  v = T.view(s, WED, names);
  assert.ok(v.doneEarlier.items.length === 0 && v.doneEarlier.hidden === 1, 'hidden, and how many is said');
  assert.equal(T.setSettings(s, { doneShow: 'year' }).ok, false);
  T.done(s, a.id, false, WED);
  v = T.view(s, WED, names);
  assert.deepEqual(v.zones[0].items.map(i => i.name).sort(), ['Alpha', 'Beta'], 'unticked: back in its part');
  T.done(s, a.id, true, WED);
  assert.equal(T.tidy(s, '2026-11-30'), 0, '33 days on: kept');
  assert.equal(T.tidy(s, '2026-12-05'), 1, '38 days on: gone');
});

test('quick checks: 1 a day comes into Today, the longest overdue first, and none is skipped', () => {
  const s = fresh();
  T.setCheck(s, A, 'week', 'Alpha', MON);
  T.setCheck(s, B, 'week', 'Beta', MON);
  s.checks[B].next = '2026-10-20'; // Beta has waited longer
  T.setCheck(s, G, 'month', 'Gamma', MON);
  s.checks[G].next = '2026-11-15'; // not due yet
  assert.equal(T.pullChecks(s, MON), 1);
  let today = T.view(s, MON, names).zones[0].items;
  assert.deepEqual(today.map(i => [i.name, i.check, i.size]), [['Beta', 'week', 15]]);
  assert.equal(T.pullChecks(s, MON), 0, 'one a day: no second one the same day');
  T.done(s, today[0].id, true, MON);
  assert.equal(s.checks[B].next, '2026-11-02', 'ticked: due again a week on');
  assert.equal(T.pullChecks(s, MON), 0, 'still one a day after the tick');
  assert.equal(T.pullChecks(s, TUE), 1);
  today = T.view(s, TUE, names).zones[0].items;
  assert.deepEqual(today.map(i => i.name), ['Alpha'], 'the next day: the other one due');
});

test('quick checks: 2 a day when set; an open check is not added twice; untick puts its date back', () => {
  const s = fresh();
  T.setSettings(s, { checksPerDay: 2 });
  for (const k of Object.keys(names)) T.setCheck(s, k, 'week', names[k], MON);
  assert.equal(T.pullChecks(s, MON), 2);
  assert.equal(T.pullChecks(s, TUE), 1, 'the third one due; the first two are still open, so not again');
  const v = T.view(s, TUE, names).zones[0].items;
  assert.equal(v.length, 3);
  const first = v[0];
  T.done(s, first.id, true, TUE);
  assert.equal(s.checks[first.project].next, '2026-11-03');
  T.done(s, first.id, false, TUE);
  assert.equal(s.checks[first.project].next, MON, 'unticked: back to when it was due');
});

test('quick checks over 30 days: 6 weekly checks at 1 a day each come up every week, none waits more than 6 days', () => {
  const s = fresh();
  const ks = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'].map(k => `folder:${k}-000000`);
  for (const k of ks) T.setCheck(s, k, 'week', k, '2026-11-01');
  const last: Record<string, string> = {};
  for (let i = 0; i < 30; i++) {
    const day = T.dayOf(new Date(2026, 10, 1 + i, 12));
    T.pullChecks(s, day);
    for (const it of s.items.filter(x => x.kind === 'check' && !x.done && x.pulledOn === day)) { T.done(s, it.id, true, day); last[it.project] = day; }
  }
  for (const k of ks) assert.ok(last[k] && last[k] >= '2026-11-24', `${k} was last checked ${last[k]}`);
});

test('monthly: the same day next month; the 31st becomes the month\'s last day', () => {
  assert.equal(T.nextDate('2026-10-15', 'month'), '2026-11-15');
  assert.equal(T.nextDate('2026-01-31', 'month'), '2026-02-28');
  assert.equal(T.nextDate('2026-12-20', 'month'), '2027-01-20');
  assert.equal(T.nextDate('2026-12-29', 'week'), '2027-01-05');
  assert.equal(T.weekStart('2026-11-01'), '2026-10-26', 'a Sunday belongs to the week from Monday');
});

test('a project that is gone keeps its row and name, and its quick check does not come in', () => {
  const s = fresh();
  T.add(s, { project: A, name: 'Alpha', zone: 'today' }, MON);
  T.setCheck(s, B, 'week', 'Beta', MON);
  assert.equal(T.pullChecks(s, MON, k => k !== B), 0);
  const it = T.view(s, MON, {}).zones[0].items[0];
  assert.ok(it.gone && it.name === 'Alpha');
});

test('text from the page is one line, without control or direction characters, at most 120', () => {
  assert.equal(T.cleanText('fix\nthe\u202Eheader\u0007  now', 120), 'fix the header now');
  assert.equal(T.cleanText('x'.repeat(500), 120).length, 120);
});

test('only a project of TOMLIN (job:) or a project folder (folder:) is taken, by its id', () => {
  const s = fresh();
  for (const bad of ['alpha', 'folder:', 'folder:../x', 'job:a/b', 'file:alpha', `folder:${'x'.repeat(100)}`]) {
    assert.equal(T.add(s, { project: bad, zone: 'today' }, MON).ok, false, bad);
  }
  ok(T.add(s, { project: 'job:2026-10-27-tip-calc', zone: 'today' }, MON));
});

test('normalize: rows and checks of the wrong shape are dropped, the rest kept', () => {
  const s = T.normalize({
    items: [{ id: 'abcdef0123', project: A, name: 'A', size: 60, zone: 'today', added: MON },
      { id: 'abcdef0123', project: A, size: 60, zone: 'today' }, // the same id again
      { id: 'zz', project: A, size: 60, zone: 'today' }, { id: 'abcdef0124', project: 'folder:../x', size: 60, zone: 'today' },
      { id: 'abcdef0125', project: B, size: 61, zone: 'today' }, { id: 'abcdef0126', project: B, size: 60, zone: 'later' }],
    checks: { [A]: { every: 'week', next: MON }, '__proto__': { every: 'week', next: MON }, [B]: { every: 'day', next: MON } },
    settings: { dayHours: 99, checksPerDay: 5 },
  });
  assert.deepEqual(s.items.map(i => i.id), ['abcdef0123']);
  assert.deepEqual(Object.keys(s.checks), [A]);
  assert.deepEqual(s.settings, { dayHours: 8, checksPerDay: 1, doneShow: 'week' });
});

test('the file: a fresh read writes nothing; changes are saved; a damaged file is set aside, not lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-todo-'));
  made.push(dir);
  const file = join(dir, 'todo.json');
  const st = new T.TodoStore(file, () => MON);
  assert.equal((await st.view(names)).open, 0);
  assert.equal(existsSync(file), false, 'a read writes no file');
  ok(await st.add({ project: A, name: 'Alpha', size: 120, zone: 'today' }));
  const again = new T.TodoStore(file, () => MON);
  assert.equal((await again.view(names)).zones[0].items[0].name, 'Alpha', 'read back from the file');
  assert.equal((await st.add({ project: '' })).ok, false);
  writeFileSync(file, '{"items": [ cut short');
  assert.equal((await again.view(names)).open, 0);
  const aside = readdirSync(dir).filter(f => f.startsWith('todo.json.damaged-'));
  assert.equal(aside.length, 1, 'the damaged file was set aside');
  assert.equal(readFileSync(join(dir, aside[0]), 'utf8'), '{"items": [ cut short');
});
