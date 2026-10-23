// The office chat's lines (public/banter.js): a plain line for each real change in what a hire does, then the six
// characters' banter for TOMLIN's own events. Loaded the way the page loads it (a script that sets window.officeBanter).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const code = readFileSync(new URL('../public/banter.js', import.meta.url), 'utf8');
const sandbox: { window: Record<string, any> } = { window: {} };
runInNewContext(code, sandbox);
const raw = sandbox.window.officeBanter;
/** The script's arrays and objects come from its own sandbox: copied here so deepEqual compares values, not realms. */
const J = (x: unknown) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const B = new Proxy(raw, { get: (t, k) => (typeof t[k] === 'function' ? (...a: unknown[]) => J(t[k](...a)) : t[k]) });

/** A random stand-in that plays back the numbers given, then repeats the last. */
const seq = (...n: number[]) => { let i = 0; return () => n[Math.min(i++, n.length - 1)]; };
const VOICES = ['punny', 'dry', 'sunny', 'quiet', 'lead', 'bold'];
const row = (o: Record<string, unknown> = {}) => ({ id: 'tessa', name: 'Tessa', role: 'Coder', doing: 'resting', pc: null, pcId: '', chat: null, busy: null, ...o });

test('every TOMLIN event has lines in all six voices, and replies from someone', () => {
  for (const kind of ['failed', 'tests-failed', 'job-done', 'picture', 'pc-off', 'late', 'vending', 'stopped', 'bug', 'failed-monday', 'tests-failed-monday', 'job-done-friday']) {
    const lines = B.LINES[kind];
    assert.ok(lines, kind);
    for (const v of VOICES) assert.ok([...(lines[v] || []), ...(lines.any || [])].length, `${kind}:${v}`);
  }
  assert.equal(B.CHARACTERS.length, 6);
  // The new one says hello (the office already does); the others answer.
  assert.ok(Object.keys(B.REPLIES.hire).length >= 6);
});

test('no line names a brand, a film or a song, and none says something TOMLIN does not do', () => {
  const all = JSON.stringify([B.LINES, B.REPLIES, B.EXCHANGES, B.COMEBACKS, B.AT_EASE]);
  assert.doesNotMatch(all, /CrowdStrike|Red Bull|Monster|Starbucks|Nescaf|Coca|Pepsi|Office Space|Back to the Future|Terminator/i);
  // TOMLIN has no push, commit or deploy of its own: those AHO lines are not carried over.
  assert.doesNotMatch(all, /\bpush(ed|ing)?\b|\bcommit/i);
});

test('the desk answer always follows "It worked on my desk." when someone is near', () => {
  const bold = B.CHARACTERS.find((c: { id: string }) => c.id === 'bold');
  const near = [{ character: B.CHARACTERS[0], name: 'Owen' }];
  const own = [...B.LINES['tests-failed'].bold, ...B.LINES['tests-failed'].any];
  const at = own.indexOf('It worked on my desk.');
  assert.ok(at >= 0);
  // talk check, no exchange, then the pick lands on the desk line.
  const out = B.plan({ kind: 'tests-failed' }, bold, near, 'Rae', seq(0, 0.99, (at + 0.5) / own.length));
  assert.deepEqual(out, [{ by: -1, text: 'It worked on my desk.' }, { by: 0, text: "Well, we're not shipping YOUR DESK now, are we?" }]);
});

test('day lines: a failed step or failed tests on a Monday about half the time, a job done on a Friday always', () => {
  const mon = '2026-10-19T10:00:00', fri = '2026-10-23T10:00:00', tue = '2026-10-20T10:00:00';
  assert.equal(B.dayKind({ kind: 'failed' }, mon, () => 0.2).kind, 'failed-monday');
  assert.equal(B.dayKind({ kind: 'failed' }, mon, () => 0.8).kind, 'failed');
  assert.equal(B.dayKind({ kind: 'tests-failed' }, mon, () => 0.2).kind, 'tests-failed-monday');
  assert.equal(B.dayKind({ kind: 'job-done', job: 'J' }, fri, () => 0.99).kind, 'job-done-friday');
  assert.equal(B.dayKind({ kind: 'job-done', job: 'J' }, fri, () => 0.99).job, 'J');
  assert.equal(B.dayKind({ kind: 'job-done' }, tue, () => 0).kind, 'job-done');
});

test('a server event is told in plain words, naming the chat or the job', () => {
  const line = (e: Record<string, unknown>) => B.eventLine(e);
  assert.equal(line({ kind: 'step-start', n: 2, job: 'Shop site', step: 'Write the contact page' }), 'Started step 3 of "Shop site": Write the contact page.');
  assert.equal(line({ kind: 'step-done', n: 2, job: 'Shop site' }), 'Finished step 3 of "Shop site". It needs your review.');
  assert.equal(line({ kind: 'step-failed', n: 2, job: 'Shop site' }), 'Step 3 of "Shop site" stopped: it needs you.');
  assert.equal(line({ kind: 'stopped', n: 2, job: 'Shop site' }), 'Stopped step 3 of "Shop site", as you asked.');
  assert.equal(line({ kind: 'tests-failed', job: 'Shop site' }), 'The tests failed on "Shop site".');
  assert.equal(line({ kind: 'job-done', job: 'Shop site' }), 'Every step of "Shop site" is done.');
  assert.equal(line({ kind: 'bug', n: 0, job: 'Shop site', problems: 1 }), 'Found 1 problem in step 1 of "Shop site".');
  assert.equal(line({ kind: 'bug', n: 0, job: 'Shop site', problems: 3 }), 'Found 3 problems in step 1 of "Shop site".');
  assert.equal(line({ kind: 'answered', chat: 'Kitchen quote' }), 'Answered in "Kitchen quote".');
  assert.equal(line({ kind: 'picture', chat: 'Logo ideas' }), 'Picture drawn for "Logo ideas".');
  assert.equal(line({ kind: 'chat-failed', chat: 'Logo ideas' }), 'Could not answer in "Logo ideas": it needs you.');
  assert.equal(line({ kind: 'answered' }), 'Answered you.');
  // Each has the banter it starts (none for a step starting or finishing: that is just work).
  assert.equal(B.banterKind({ kind: 'step-failed' }), 'failed');
  assert.equal(B.banterKind({ kind: 'chat-failed' }), 'failed');
  assert.equal(B.banterKind({ kind: 'picture' }), 'picture');
  assert.equal(B.banterKind({ kind: 'step-start' }), null);
  assert.equal(B.banterKind({ kind: 'answered' }), null);
});

test('one line per real change in what a hire does: the start of a piece of work, not each phase', () => {
  const ch = (was: unknown, now: unknown, ctx = {}) => B.changes(was, now, ctx).map((c: { text: string }) => c.text);
  // A new hire, but not on the first list (everyone is new then).
  assert.deepEqual(ch(null, row(), {}), ['Joined the team as Coder.']);
  assert.deepEqual(B.changes(null, row(), {})[0].event, { kind: 'hire' });
  assert.deepEqual(ch(null, row(), { first: true }), []);
  // An answer: one line when it starts, nothing as it goes from reading to thinking to typing.
  assert.deepEqual(ch(row(), row({ doing: 'researching', chat: 'Kitchen quote' })), ['Answering you in "Kitchen quote".']);
  assert.deepEqual(ch(row({ doing: 'researching', chat: 'Kitchen quote' }), row({ doing: 'thinking', chat: 'Kitchen quote' })), []);
  assert.deepEqual(ch(row({ doing: 'thinking', chat: 'Kitchen quote' }), row({ doing: 'typing', chat: 'Kitchen quote' })), []);
  // The model loading first, then the answer: both said.
  assert.deepEqual(ch(row(), row({ doing: 'arriving', pc: 'Worker PC' })), ['Loading my model on Worker PC.']);
  assert.deepEqual(ch(row({ doing: 'arriving' }), row({ doing: 'typing', chat: 'Kitchen quote' })), ['Answering you in "Kitchen quote".']);
  // The end of an answer is the server's event (Answered), never guessed from the list.
  assert.deepEqual(ch(row({ doing: 'typing', chat: 'Kitchen quote' }), row()), []);
  assert.deepEqual(ch(row(), row({ doing: 'waiting', pc: 'Worker PC' })), ['Waiting for Worker PC: another answer is on it first.']);
  assert.deepEqual(ch(row(), row({ doing: 'drawing', chat: 'Logo ideas' })), ['Drawing a picture for "Logo ideas".']);
  // A PC off: the line and the banter; back on: the line.
  assert.deepEqual(ch(row({ pc: 'Worker PC' }), row({ doing: 'off', pc: 'Worker PC' })), ['My PC (Worker PC) is off.']);
  assert.deepEqual(B.changes(row(), row({ doing: 'off' }), {})[0].event, { kind: 'pc-off' });
  assert.deepEqual(ch(row({ doing: 'off', pc: 'Worker PC' }), row({ pc: 'Worker PC' })), ['Worker PC is back on. Back at my desk.']);
  assert.deepEqual(ch(row({ pc: 'Worker PC' }), row({ doing: 'owner', pc: 'Worker PC' })), ["Worker PC's owner is using it, so I'm away."]);
  assert.deepEqual(ch(row(), row({ pcId: 'e31acc07', pc: 'Worker PC' })), ['Moved to Worker PC.']);
  assert.deepEqual(ch(row({ pcId: 'e31acc07', pc: 'Worker PC' }), row()), ['Moved to My PC.']);
  // A project step: said by the server's event; the list's own words only when no event came with it.
  assert.deepEqual(ch(row(), row({ doing: 'working', busy: 'Step 2 of Shop site' }), { stepEvent: true }), []);
  assert.deepEqual(ch(row(), row({ doing: 'working', busy: 'Step 2 of Shop site' })), ['Working: Step 2 of Shop site.']);
  // Nothing changed: nothing said.
  assert.deepEqual(ch(row({ doing: 'typing', chat: 'A' }), row({ doing: 'typing', chat: 'A' })), []);
});

test('payday: the figures are their real tokens today; nothing when they are the same', () => {
  const out = B.payday([{ name: 'A', today: 3_100_000 }, { name: 'B', today: 2_400_000 }, { name: 'C', today: 450_000 }]);
  assert.deepEqual(out.map((l: { by: number }) => l.by).slice(0, 3), [0, 1, 2]);
  assert.equal(out[0].text, "I'm excited, I'm getting paid 3.10M tokens...");
  assert.equal(out[2].text, '2.40M? I\'m on 450K. Wait, you lot are getting paid?');
  assert.equal(out.at(-1).text, "Well, there's always the odd pizza.");
  assert.deepEqual(B.payday([{ name: 'A', today: 1000 }, { name: 'B', today: 1000 }]), []);
  assert.deepEqual(B.payday([{ name: 'A', today: 1000 }]), []);
});

test('chit-chat lines for every place they rest in the office', () => {
  for (const spot of ['coffee', 'vending', 'lunch', 'tv', 'library', 'chat', 'nap', 'treadmill', 'weights', 'arcade', 'window', 'pizza', 'break', 'beach', 'volley', 'stretch']) assert.ok(B.AT_EASE[spot]?.length, spot);
});

test('a chit-chat line is not said again within 10 minutes by anyone; a work line only skips its own straight repeat', () => {
  const now = 1_000_000_000;
  const said = [
    { id: 'qwen', text: 'Coffee first, then answers.', kind: 'chat', at: now - 3 * 60_000 },
    { id: 'tessa', text: 'Answered in "A".', kind: 'work', at: now - 60_000 },
  ];
  // The same chit-chat from someone else 3 minutes later: left out (his paste: two hires, the same line, minutes apart).
  assert.equal(B.saidLately(said, { id: 'qwen35', text: 'Coffee first, then answers.', kind: 'chat' }, now), true);
  // And from the same person: left out.
  assert.equal(B.saidLately(said, { id: 'qwen', text: 'Coffee first, then answers.', kind: 'chat' }, now), true);
  // Ten minutes on: allowed again.
  assert.equal(B.saidLately(said, { id: 'qwen', text: 'Coffee first, then answers.', kind: 'chat' }, now + 8 * 60_000), false);
  // A work line: only the person's own straight repeat is left out; a later real one with other lines between is said.
  assert.equal(B.saidLately(said, { id: 'tessa', text: 'Answered in "A".', kind: 'work' }, now), true);
  assert.equal(B.saidLately([...said, { id: 'tessa', text: 'Answering you in "A".', kind: 'work', at: now }], { id: 'tessa', text: 'Answered in "A".', kind: 'work' }, now), false);
  // Waiting in the queue counts too (no time yet).
  assert.equal(B.saidLately([{ id: 'x', text: 'Leg day.', kind: 'chat' }], { id: 'y', text: 'Leg day.', kind: 'chat' }, now), true);
});

test('general chit-chat is spaced out across the office', () => {
  assert.equal(B.CHIT_GAP_MS, 90_000);
});
