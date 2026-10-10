import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Q from '../src/queue.ts';
import type { QItem, Queue } from '../src/queue.ts';

const at = '2026-10-07T10:00:00.000Z';
let n = 0;
function item(o: Partial<QItem> = {}): QItem {
  n++;
  return { id: `i${n}`, kind: 'picture', state: 'waiting', title: `picture ${n}`, added: at, project: '', ...o };
}
const q = (items: QItem[], paused = false): Queue => ({ paused, items });
/** Lanes by item id, for toStart. */
const lanes = (map: Record<string, string[]>) => (it: QItem) => map[it.id] ?? ['here'];

test('one item at a time on each PC; items for different PCs start side by side', () => {
  const a = item(), b = item(), c = item();
  const got = Q.toStart(q([a, b, c]), lanes({ [a.id]: ['pc:w'], [b.id]: ['pc:w'], [c.id]: ['here'] }), new Set());
  assert.deepEqual(got.map(x => x.id), [a.id, c.id]);
});

test('a later item never overtakes a waiting one for the same PC, even when that one may not start yet', () => {
  const a = item({ after: Date.now() + 60_000 }), b = item();
  const got = Q.toStart(q([a, b]), lanes({ [a.id]: ['pc:w'], [b.id]: ['pc:w'] }), new Set());
  assert.deepEqual(got, []);
});

test('a running item and work outside the queue hold their PC', () => {
  const r = item({ state: 'running', lanes: ['pc:w'] }), a = item(), b = item();
  const got = Q.toStart(q([r, a, b]), lanes({ [a.id]: ['pc:w'], [b.id]: ['here'] }), new Set(['here']));
  assert.deepEqual(got, []);
});

test('a project needs the one job lane and its step PC: two projects never run together', () => {
  const p1 = item({ kind: 'project', project: 'p1' }), p2 = item({ kind: 'project', project: 'p2' }), pic = item();
  const got = Q.toStart(q([p1, p2, pic]), lanes({ [p1.id]: ['jobs', 'here'], [p2.id]: ['jobs', 'pc:w'], [pic.id]: ['pc:w'] }), new Set());
  // p2 waits for the job lane and keeps its place on pc:w, so the picture there waits behind it.
  assert.deepEqual(got.map(x => x.id), [p1.id]);
});

test('a project waiting for its own picture holds no place; the picture runs', () => {
  const pic = item({ id: 'pic' });
  const p = item({ kind: 'project', project: 'p', waitFor: 'pic' });
  const order = q([p, pic]);
  assert.deepEqual(Q.toStart(order, lanes({ [p.id]: ['jobs', 'pc:w'], pic: ['pc:w'] }), new Set()).map(x => x.id), ['pic']);
  // Its picture done: the project goes on.
  pic.state = 'done';
  assert.deepEqual(Q.toStart(order, lanes({ [p.id]: ['jobs', 'pc:w'] }), new Set()).map(x => x.id), [p.id]);
});

test('paused: nothing starts', () => {
  assert.deepEqual(Q.toStart(q([item()], true), () => ['here'], new Set()), []);
});

test('up and down move a waiting line past the next waiting one only', () => {
  const a = item(), r = item({ state: 'running' }), b = item(), c = item();
  const list = q([a, r, b, c]);
  assert.equal(Q.move(list, b.id, -1), true);
  assert.deepEqual(list.items.map(x => x.id), [b.id, a.id, r.id, c.id]);
  assert.equal(Q.move(list, b.id, -1), false, 'already first');
  assert.equal(Q.move(list, r.id, 1), false, 'a running line does not move');
  assert.equal(Q.move(list, c.id, 1), false, 'already last');
});

test('a full list drops the oldest finished lines, and refuses when all are still to do', () => {
  const list = q([item({ state: 'done' }), ...Array.from({ length: Q.MAX_ITEMS - 1 }, () => item())]);
  assert.equal(Q.makeRoom(list, 1), true);
  assert.equal(list.items.length, Q.MAX_ITEMS - 1);
  assert.equal(Q.makeRoom(list, 2), false);
});

test('read from disk: unknown kinds dropped, bad fields left out; running goes back in line after a restart', () => {
  const got = Q.cleanQueue({ paused: true, items: [{ id: 'a', kind: 'picture', state: 'running', title: 'x', added: at, project: 'p1', width: 99999, lanes: ['pc:w', 'evil lane'] }, { id: 'b', kind: 'rocket' }, null] });
  assert.equal(got.paused, true);
  assert.equal(got.items.length, 1);
  assert.equal(got.items[0].width, undefined);
  assert.deepEqual(got.items[0].lanes, ['pc:w']);
  const back = Q.afterRestart(got);
  assert.equal(back.items[0].state, 'waiting');
  assert.match(back.items[0].note ?? '', /runs again/);
});

test('Home lines: photos per project, documents, replies per chat, then what did not finish; seen and cancelled left out', () => {
  const list = q([
    item({ state: 'done', project: 'harbor', projectName: 'Harbor Bakery blog', prompt: 'an upright piano', handed: 'harbor/specialists/images/a.png', ended: '2026-10-07T11:00:00.000Z' }),
    item({ state: 'done', project: 'harbor', projectName: 'Harbor Bakery blog', prompt: 'a tuning fork', handed: 'harbor/specialists/images/b.png' }),
    item({ state: 'done', project: 'gt', projectName: 'Garden Tools', prompt: 'a garden rake' }),
    item({ state: 'done', kind: 'project', project: 'gt', projectName: 'Garden Tools', result: 'All 5 steps done.' }),
    item({ state: 'done', kind: 'chat', chat: 'c1', result: 'Rowan answered.' }),
    item({ state: 'failed', title: 'a lighthouse', error: '"Worker PC" said: out of memory' }),
    item({ state: 'done', seen: true }),
    item({ state: 'cancelled' }),
    item({ state: 'waiting' }),
  ]);
  const lines = Q.homeLines(list, c => (c === 'c1' ? 'Blog intro' : ''));
  assert.deepEqual(lines.map(l => l.text), [
    'Review photos for Harbor Bakery blog.',
    'Review photos for Garden Tools.',
    'Review documents for Garden Tools.',
    'Reply and answer: Blog intro.',
    'Did not finish: a lighthouse.',
  ]);
  assert.match(lines[0].detail, /^2 pictures drawn: "an upright piano", "a tuning fork" · in Harbor Bakery blog's specialists\\images$/);
  assert.match(lines[1].detail, /0 of 1 in Garden Tools's specialists\\images/);
  assert.equal(lines[0].ids.length, 2);
});

test('a line ends with one full stop, never after a question mark', () => {
  const lines = Q.homeLines(q([item({ state: 'done', kind: 'chat', chat: 'c', result: 'Wren answered.' }), item({ state: 'failed', title: 'why is it slow?' })]), () => 'why do pianos go out of tune?');
  assert.deepEqual(lines.map(l => l.text), ['Reply and answer: why do pianos go out of tune?', 'Did not finish: why is it slow?']);
});

test('a picture model reloading after a Cancel is tried again, not failed', () => {
  assert.equal(Q.forNow('"Test Node" said: The picture model was unloaded before the picture started.'), true);
});

test('busy or off for now is tried again; a real fault is not', () => {
  assert.equal(Q.forNow('"Worker PC": that PC is busy answering something else. Try again in a moment.'), true);
  assert.equal(Q.forNow('The linked PC "Worker PC" could not be reached at http://x (fetch failed).'), true);
  assert.equal(Q.forNow('Another project is working now (busy)'), true);
  assert.equal(Q.forNow('That artist is no longer on the team.'), false);
  assert.equal(Q.forNow('The picture failed in the image runner: bad model.'), false);
});

test('the count line says what is in line, and paused', () => {
  assert.equal(Q.countLine(q([])), 'Nothing in line');
  assert.equal(Q.countLine(q([item({ state: 'running' }), item(), item()], true)), 'Paused · 1 running · 2 waiting');
});

test('a queued chat line says how far its answer is, not Starting until it ends', () => {
  let st = 'Starting';
  st = Q.chatStage('chat', { chat: 'c1' }, st);
  assert.equal(st, 'Starting');
  st = Q.chatStage('status', { text: 'Loading Qwen3.5-0.8B on this PC…' }, st);
  assert.equal(st, 'Loading Qwen3.5-0.8B on this PC');
  st = Q.chatStage('brain', { ran: 'on this PC · Qwen3.5-0.8B', chat: 'c1' }, st);
  assert.equal(st, 'Asked: on this PC · Qwen3.5-0.8B');
  assert.equal(Q.chatStage('thinking', { text: 'hmm', seconds: 4.4 }, st), 'Working it out (4 s)');
  assert.equal(Q.chatStage('text', { text: 'Hello' }, st), 'Writing the answer');
  assert.equal(Q.chatStage('impact', {}, 'Writing the answer'), 'Writing the answer');
});

test('a queued chat message run again: done with a whole answer; sent again after Stop, with the half answer taken out', () => {
  const since = '2026-10-10T10:00:00.000Z';
  const ask = { role: 'user', content: 'Write the intro', at: '2026-10-10T10:01:00.000Z', from: 'the queue' };
  const before = { role: 'assistant', content: 'An older answer', at: '2026-10-10T09:00:00.000Z' };
  assert.deepEqual(Q.runAgain([before], 'Write the intro', since), [], 'not sent yet: nothing to take out');
  assert.equal(Q.runAgain([before, ask, { role: 'assistant', content: 'The intro.', at: '2026-10-10T10:02:00.000Z' }], 'Write the intro', since), 'done');
  assert.equal(Q.runAgain([before, ask, { role: 'assistant', content: '', at: '2026-10-10T10:02:00.000Z', waiting: { rid: 'r1' } }], 'Write the intro', since), 'done', 'owed by a linked PC: it comes by itself');
  // Stop (the queue's Pause) part way, then Resume: the half answer is not the answer.
  assert.deepEqual(Q.runAgain([before, ask, { role: 'assistant', content: 'The in', at: '2026-10-10T10:02:00.000Z', stopped: true }], 'Write the intro', since), [1, 2]);
  assert.deepEqual(Q.runAgain([before, ask, { role: 'assistant', content: ' ', at: '2026-10-10T10:02:00.000Z' }], 'Write the intro', since), [1, 2]);
  assert.deepEqual(Q.runAgain([before, ask], 'Write the intro', since), [1], 'closed before any answer');
  assert.deepEqual(Q.runAgain([before, { ...ask, from: undefined }], 'Write the intro', since), [], 'typed by him, not the queue');
});

test('two queued items with the same words are two messages; an answer to a later message is not the stopped one\'s', () => {
  const since = '2026-10-10T10:00:00.000Z';
  const a = { role: 'user', content: 'Go on', at: '2026-10-10T10:05:00.000Z', from: 'the queue', queued: 'qa' };
  const answerA = { role: 'assistant', content: 'And then...', at: '2026-10-10T10:06:00.000Z' };
  // Item b was added (since) before item a ran: a's line is at or after b's since, with the same words.
  assert.deepEqual(Q.runAgain([a, answerA], 'Go on', since, 'qb'), [], 'b is not sent yet: a\'s answer is not b\'s');
  assert.equal(Q.runAgain([a, answerA], 'Go on', since, 'qa'), 'done');
  const b = { ...a, at: '2026-10-10T10:07:00.000Z', queued: 'qb' };
  assert.deepEqual(Q.runAgain([a, answerA, b, { role: 'assistant', content: 'Half', at: '2026-10-10T10:08:00.000Z', stopped: true }], 'Go on', since, 'qb'), [2, 3]);
  // A line from before the id was kept is still found by its words.
  const old = { role: 'user', content: 'Go on', at: '2026-10-10T10:05:00.000Z', from: 'the queue' };
  assert.equal(Q.runAgain([old, answerA], 'Go on', since, 'qa'), 'done');
  // Stopped, then he typed something himself and it was answered: the queued message still has no whole answer.
  const stoppedA = { role: 'assistant', content: 'And th', at: '2026-10-10T10:06:00.000Z', stopped: true };
  const his = { role: 'user', content: 'Something else', at: '2026-10-10T10:09:00.000Z' };
  const hisAnswer = { role: 'assistant', content: 'Sure.', at: '2026-10-10T10:10:00.000Z' };
  assert.deepEqual(Q.runAgain([a, stoppedA, his, hisAnswer], 'Go on', since, 'qa'), [0, 1]);
});
