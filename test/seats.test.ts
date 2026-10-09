import { test } from 'node:test';
import assert from 'node:assert/strict';
import { biggest, cardFns, crossFile, fitStep, fnCheck, fnsIn, groupFiles, sizePlan, smallestFit, splitStep, stepRoom, workersLine, type Seat } from '../src/seats.ts';
import { cleanStep, MAX_STEPS, planSystem, type Step } from '../src/jobs.ts';

const step = (title: string, files: string[], brief = 'Do it.'): Step => cleanStep({ title, files, brief, role: 'coder' })!;
const seat = (ref: string, ctx: number, o: Partial<Seat> = {}): Seat => ({ ref, label: ref, ctx, params: null, ready: false, ...o });
const roomOf = (s: Seat) => stepRoom(s.ctx);

test('the room for one step: what it reads in, bigger with a bigger context (a long file goes back as edit blocks)', () => {
  const r4 = stepRoom(4096), r8 = stepRoom(8192), r32 = stepRoom(32768), r262 = stepRoom(262144);
  assert.ok(r4 < r8 && r8 < r32 && r32 < r262, `${r4} ${r8} ${r32} ${r262}`);
  assert.equal(r32, Math.round((32768 - 10922 - 1500) * 2.2));
  // The packet front takes room from a small model.
  assert.ok(stepRoom(8192, 2600) < stepRoom(8192, 0));
});

test('files are grouped in order to fit a room; a file alone too big gives null', () => {
  const sizes = { 'a.html': 3000, 'b.css': 2500, 'c.js': 4000 };
  assert.deepEqual(groupFiles(['a.html', 'b.css', 'c.js'], sizes, 6000), [['a.html', 'b.css'], ['c.js']]);
  assert.equal(groupFiles(['a.html', 'b.css', 'c.js'], sizes, 3000), null);
  assert.deepEqual(groupFiles(['a.html', 'b.css'], sizes, 3000), [['a.html'], ['b.css']]);
  // A file not made yet counts nothing.
  assert.deepEqual(groupFiles(['new.js', 'a.html'], sizes, 3000), [['new.js', 'a.html']]);
});

test('a split step: each part changes only its own files and is told what the others change', () => {
  const s = step('Restyle the site', ['index.html', 'style.css', 'app.js']);
  const parts = splitStep(s, [['index.html'], ['style.css', 'app.js']]);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map(p => p.files), [['index.html'], ['style.css', 'app.js']]);
  assert.match(parts[0].title, /\(part 1 of 2\)$/);
  assert.match(parts[0].brief, /^Do it\.\n\nThis is part 1 of 2 of this step: change only index\.html\. The other part changes style\.css, app\.js: do not write them/);
  assert.ok(parts.every(p => p.status === 'todo' && p.brief.length <= 1600));
});

test('fitStep: fits its own worker as it is', () => {
  const own = seat('small', 8192);
  assert.deepEqual(fitStep(step('Page', ['a.html']), { 'a.html': 3000 }, own, [own, seat('big', 32768)], roomOf, 'biggest', 4), { kind: 'fits', seat: own });
});

test('fitStep: too big for its worker is split by files, the parts staying with that worker (small steps to small workers)', () => {
  const own = seat('small', 8192);
  const f = fitStep(step('Page and style', ['a.html', 'b.css']), { 'a.html': 5000, 'b.css': 5000 }, own, [own, seat('big', 32768)], roomOf, 'biggest', 4);
  assert.equal(f.kind, 'split');
  assert.deepEqual(f.kind === 'split' && f.groups, [['a.html'], ['b.css']]);
});

test('fitStep: one file too big for its worker goes to the smallest worker it fits, a loaded one first', () => {
  const own = seat('small', 8192);
  const mid = seat('mid', 16384);
  const big = seat('big', 32768, { ready: true });
  const f = fitStep(step('Long page', ['a.html']), { 'a.html': 9000 }, own, [own, mid, big], roomOf, 'picked', 4);
  assert.equal(f.kind, 'move');
  assert.equal(f.kind === 'move' && f.seat.ref, 'big');
  const g = fitStep(step('Long page', ['a.html']), { 'a.html': 9000 }, own, [own, mid, seat('big', 32768)], roomOf, 'picked', 4);
  assert.equal(g.kind === 'move' && g.seat.ref, 'mid');
  assert.match(g.kind === 'move' ? g.why : '', /more than small can read in one step/);
});

test('fitStep: a file no worker can take stops before it runs, naming the file and the most any worker takes', () => {
  const own = seat('small', 8192);
  const f = fitStep(step('Huge page', ['a.html']), { 'a.html': 60000 }, own, [own, seat('big', 32768, { label: 'Qwen 30B on node 3' })], roomOf, 'biggest', 4);
  assert.equal(f.kind, 'none');
  assert.match(f.kind === 'none' ? f.why : '', /a\.html holds 60,000 characters: no worker here can read that file in one step .* about 44,761, on Qwen 30B on node 3, 32,768-token context/);
});

test('fitStep: a split may not take the job past the step limit; then it moves', () => {
  const own = seat('small', 8192);
  const f = fitStep(step('Page and style', ['a.html', 'b.css']), { 'a.html': 5000, 'b.css': 5000 }, own, [own, seat('big', 32768)], roomOf, 'picked', MAX_STEPS);
  assert.equal(f.kind === 'move' && f.seat.ref, 'big');
});

test('a fix across files is a big reading job: the biggest worker with the switch on biggest, never split', () => {
  const own = seat('small', 8192);
  const fix = step('Fix the failing tests (npm test)', ['tip.mjs', 'tip.test.mjs']);
  assert.equal(crossFile(fix), true);
  assert.equal(crossFile(step('Fix the typo', ['a.md'])), false);
  const pool = [own, seat('big', 32768)];
  const a = fitStep(fix, { 'tip.mjs': 500, 'tip.test.mjs': 500 }, own, pool, roomOf, 'biggest', 4);
  assert.equal(a.kind === 'move' && a.seat.ref, 'big');
  // Switch on "picked": it stays with its own worker while it fits...
  assert.equal(fitStep(fix, { 'tip.mjs': 500, 'tip.test.mjs': 500 }, own, pool, roomOf, 'picked', 4).kind, 'fits');
  // ...and when it does not fit, it moves whole (not split).
  const c = fitStep(fix, { 'tip.mjs': 5000, 'tip.test.mjs': 5000 }, own, pool, roomOf, 'picked', 4);
  assert.equal(c.kind === 'move' && c.seat.ref, 'big');
});

test('biggest: most context, then most parameters; smallestFit prefers a loaded worker', () => {
  assert.equal(biggest([seat('a', 8192, { params: 9 }), seat('b', 32768, { params: 0.8 }), seat('c', 32768, { params: 4 })])!.ref, 'c');
  assert.equal(biggest([]), null);
  assert.equal(smallestFit([seat('a', 16384), seat('b', 32768, { ready: true })], 5000, roomOf)!.ref, 'b');
  assert.equal(smallestFit([seat('a', 8192)], 50000, roomOf), null);
});

test('sizePlan splits existing files too big for their worker at plan time, and leaves the rest', () => {
  const steps = [step('Page and style', ['a.html', 'b.css']), step('Script', ['c.js'])];
  const r = sizePlan(steps, { 'a.html': 5000, 'b.css': 5000 }, () => stepRoom(8192));
  assert.deepEqual(r.steps.map(s => s.files), [['a.html'], ['b.css'], ['c.js']]);
  assert.deepEqual(r.split, [{ title: 'Page and style', parts: 2 }]);
  // Unknown room (a picture step, no worker): unchanged.
  assert.equal(sizePlan(steps, { 'a.html': 5000, 'b.css': 5000 }, () => null).steps.length, 2);
});

test('the planner is told each worker\'s limit per step', () => {
  const line = workersLine([{ who: 'The coder (Sam)', seat: seat('q', 8192, { label: 'Qwen3.5-0.8B' }), room: 6215 }]);
  assert.match(line, /The coder \(Sam\): Qwen3\.5-0\.8B \(8,192-token context\), at most about 6,215 characters of files in one step\./);
  assert.equal(workersLine([]), '');
  assert.match(planSystem(['a.html (3,000 characters)'], line), /a\.html \(3,000 characters\)[\s\S]*Each worker reads all the files of its step/);
  assert.doesNotMatch(planSystem([]), /\n\n$/);
});

test('F-numbers: read from text and from the Scope card', () => {
  assert.deepEqual(fnsIn('F2: the sums, then F4 and F1-F3'), [1, 2, 3, 4]);
  assert.deepEqual(fnsIn('F1–F5'), [1, 2, 3, 4, 5]);
  assert.deepEqual(fnsIn('FF12x, F 3, F100'), []);
  assert.deepEqual(cardFns('# Scope\nStatement\nF1. Add the bill\nF2. Pick a tip\n- F3. Show the total\nThe F9 in a sentence'), [1, 2, 3]);
  assert.deepEqual(cardFns('F1-F3: the planner picks the three most basic things it must do (Assumed).'), [1, 2, 3]);
});

test('fnCheck: every F-number in the plan is on the card, and every one on the card is planned', () => {
  const card = 'F1. Bill\nF2. Tip\nF3. Total';
  const ok = [step('F1 Bill box', ['a.html']), step('F2 and F3: tip and total', ['app.js'])];
  assert.deepEqual(fnCheck(ok, card), []);
  const bad = [step('F1 Bill box', ['a.html']), step('F7 Share button', ['app.js'])];
  const out = fnCheck(bad, card);
  assert.match(out[0], /^F2, F3 are on the Scope card, but no step names them/);
  assert.match(out[1], /^Step 2 names F7, which is not on the Scope card \(it has F1, F2, F3\)\./);
  assert.match(fnCheck([step('Bill box', ['a.html'])], card)[0], /^No step names F1, F2, F3 from the Scope card/);
  // A skipped step does not count as planned.
  const skipped = [{ ...step('F1 Bill', ['a.html']), status: 'skipped' as const }, step('F2 F3', ['b.js'])];
  assert.match(fnCheck(skipped, card)[0], /^F1 is on the Scope card, but no step names it/);
  assert.deepEqual(fnCheck(ok, 'no functions here'), []);
});
