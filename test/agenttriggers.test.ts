// The triggers' times are local wall-clock times: these tests run in Sydney's time zone (daylight saving in October and
// April), set before any date is made.
process.env.TZ = 'Australia/Sydney';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterMatches, dueNow, filesDue, nextTime, parseTrigger, timeOf, triggerWords, type Trigger } from '../src/agenttriggers.ts';

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const show = (ms: number | null) => (ms === null ? null : new Date(ms).toString().slice(0, 21));

test('When lines are read in plain words, and written back the same way', () => {
  const cases: Array<[string, Trigger]> = [
    ['Every weekday at 07:00', { kind: 'daily', at: '07:00', days: [1, 2, 3, 4, 5] }],
    ['Every day at 7:30 pm', { kind: 'daily', at: '19:30', days: [0, 1, 2, 3, 4, 5, 6] }],
    ['Daily at 6', { kind: 'daily', at: '06:00', days: [0, 1, 2, 3, 4, 5, 6] }],
    ['Every Monday and Thursday at 09:00', { kind: 'daily', at: '09:00', days: [1, 4] }],
    ['Weekly on Friday at 17:00', { kind: 'daily', at: '17:00', days: [5] }],
    ['Every tues, thurs at 12am', { kind: 'daily', at: '00:00', days: [2, 4] }],
    ['Every 6 hours', { kind: 'hours', hours: 6 }],
    ['Every hour', { kind: 'hours', hours: 1 }],
    ['Once on 2026-12-01 at 08:00', { kind: 'once', at: '2026-12-01T08:00' }],
    ['When a file lands in inbox', { kind: 'file', folder: 'inbox' }],
    ["After Robin's price check", { kind: 'after', job: "Robin's price check" }],
    ['After Morning brief has run', { kind: 'after', job: 'Morning brief' }],
    ['By hand', { kind: 'hand' }],
  ];
  for (const [words, t] of cases) {
    assert.deepEqual(parseTrigger(words), t, words);
    assert.deepEqual(parseTrigger(triggerWords(t)), t, `back: ${words}`);
  }
  for (const bad of ['Every blursday at 07:00', 'Every day at 25:00', 'Every 30 hours', 'Once on 2026-02-30 at 08:00', 'Sometimes', 'When a file lands in ../secret']) assert.ok('error' in parseTrigger(bad), bad);
  assert.equal(timeOf('7.05pm'), '19:05');
  assert.equal(timeOf('13pm'), null);
});

test('next time across midnight, the weekend and the end of the month', () => {
  const t = parseTrigger('Every weekday at 07:00') as Trigger;
  // Friday 23:59 -> Monday 07:00.
  assert.equal(show(nextTime(t, local(2026, 11, 27, 23, 59))), show(local(2026, 11, 30, 7, 0)));
  // Exactly at the time: the next one, never the same minute again.
  assert.equal(show(nextTime(t, local(2026, 11, 30, 7, 0))), show(local(2026, 12, 1, 7, 0)));
  const h = parseTrigger('Every 6 hours') as Trigger;
  assert.equal(show(nextTime(h, local(2026, 11, 30, 23, 0))), show(local(2026, 12, 1, 0, 0)));
  const once = parseTrigger('Once on 2026-12-01 at 08:00') as Trigger;
  assert.equal(nextTime(once, local(2026, 12, 1, 8, 0)), null);
});

test('daylight saving in Sydney: 07:00 stays 07:00, a skipped time runs after the gap, a doubled time runs once', () => {
  const seven = parseTrigger('Every day at 07:00') as Trigger;
  // Clocks go forward on Sunday 4 October 2026 at 02:00.
  const sat = nextTime(seven, local(2026, 10, 2, 8));
  const sun = nextTime(seven, sat!);
  assert.equal(new Date(sun!).getHours(), 7);
  assert.equal(sun! - sat!, 23 * 3600_000);
  const half = parseTrigger('Every day at 02:30') as Trigger;
  const gap = nextTime(half, local(2026, 10, 4, 0, 0))!;
  assert.equal(new Date(gap).getDate(), 4);
  assert.equal(new Date(gap).getHours(), 3);
  // Clocks go back on Sunday 5 April 2026 at 03:00 (02:30 comes twice): one run that day.
  const first = nextTime(half, local(2026, 4, 5, 0, 0))!;
  const next = nextTime(half, first)!;
  assert.equal(new Date(next).getDate(), 6);
});

test('a PC off for two days runs a missed time once, not once for each time it missed', () => {
  const t = parseTrigger('Every day at 07:00') as Trigger;
  const made = local(2026, 11, 20, 12);
  const first = dueNow([t], [], made);
  assert.equal(first.fire, false);
  assert.equal(show(first.next[0]), show(local(2026, 11, 21, 7)));
  // Off from the 20th until the 23rd at 09:00: two times missed, one run.
  const back = dueNow([t], first.next, local(2026, 11, 23, 9));
  assert.equal(back.fire, true);
  assert.equal(back.missed, true);
  assert.equal(show(back.next[0]), show(local(2026, 11, 24, 7)));
  const again = dueNow([t], back.next, local(2026, 11, 23, 9, 1));
  assert.equal(again.fire, false);
});

test('two triggers due in the same minute fire one run', () => {
  const a = parseTrigger('Every day at 07:00') as Trigger;
  const b = parseTrigger('Every weekday at 07:00') as Trigger;
  const at = local(2026, 11, 30, 7, 0);
  const r = dueNow([a, b, { kind: 'hand' }], [at, at, null], at + 30_000);
  assert.equal(r.fire, true);
  assert.equal(r.next[2], null);
  // A Once that has fired stays done.
  const once = parseTrigger('Once on 2026-12-01 at 08:00') as Trigger;
  const o = dueNow([once], [local(2026, 12, 1, 8)], local(2026, 12, 1, 8, 1));
  assert.equal(o.fire, true);
  assert.equal(o.next[0], null);
  assert.equal(dueNow([once], o.next, local(2026, 12, 2)).fire, false);
});

test('a file-landed trigger fires once per file, not for files already there', () => {
  const first = filesDue(undefined, ['old.txt']);
  assert.deepEqual(first.run, []);
  const second = filesDue(first.seen, ['old.txt', 'new.pdf']);
  assert.deepEqual(second.run, ['new.pdf']);
  assert.deepEqual(filesDue(second.seen, ['old.txt', 'new.pdf']).run, []);
  // Taken out and put back: new again.
  const gone = filesDue(second.seen, ['old.txt']);
  assert.deepEqual(filesDue(gone.seen, ['old.txt', 'new.pdf']).run, ['new.pdf']);
  // Many at once: five now, the rest next time.
  const many = filesDue([], Array.from({ length: 8 }, (_, i) => `f${i}.txt`));
  assert.equal(many.run.length, 5);
  assert.equal(filesDue(many.seen, Array.from({ length: 8 }, (_, i) => `f${i}.txt`)).run.length, 3);
});

test('an After trigger names the job, its agent, or both', () => {
  const ran = { name: 'Price check', agentName: 'Robin Hart' };
  for (const yes of ["Robin's price check", 'Price check', 'robin hart', 'Robin', 'Robin Hart price check']) assert.ok(afterMatches(yes, ran), yes);
  for (const no of ['Fern', 'Morning brief', '']) assert.ok(!afterMatches(no, ran), no);
});
