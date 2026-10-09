// Big files in jobs (PLAN F10 G2): the step room grows with the context, and a file too long to write out whole is
// changed by find-and-replace blocks that code checks before anything is saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, budget, cleanStep, editFiles, fixMessage, parseEdits, parseResult, workerSystem, workerUser, type Job } from '../src/jobs.ts';
import { stepRoom } from '../src/seats.ts';

test('the step room grows with the context: 64K reads about 4x the files of 16K', () => {
  assert.equal(budget(8192).answer, 3000, 'small contexts as before');
  assert.equal(budget(16384).answer, 6000);
  assert.equal(budget(65536).answer, 21845);
  assert.equal(budget(262144).answer, 32768, 'never past the step ceiling');
  const r16 = stepRoom(16384), r64 = stepRoom(65536);
  assert.ok(r64 / r16 > 4 && r64 / r16 < 5, `${r64} / ${r16}`);
  assert.ok(stepRoom(262144) > stepRoom(65536));
});

test('editFiles: new and short files go whole; a file past 4/5 of the answer goes by edit blocks', () => {
  const texts = { 'big.js': 'x'.repeat(20000), 'small.css': 'y'.repeat(1000), 'new.html': null };
  assert.deepEqual(editFiles(['big.js', 'small.css', 'new.html'], texts, 13200), ['big.js']);
  assert.deepEqual(editFiles(['small.css'], texts, 13200), []);
  // Two middling files: the shorter goes whole, the other by edits.
  assert.deepEqual(editFiles(['a', 'b'], { a: 'a'.repeat(7000), b: 'b'.repeat(6000) }, 13200), ['a']);
});

const file = ['function a() {', '  return 1;', '}', '', 'function b() {', '  return 2;', '}', ''].join('\n');

test('applyEdits: one exact match is replaced; nothing else changes', () => {
  const r = applyEdits('app.js', file, [{ find: 'function b() {\n  return 2;\n}', replace: 'function b() {\n  return 3;\n}' }]);
  assert.ok('text' in r);
  assert.equal('text' in r && r.text, file.replace('return 2', 'return 3'));
});

test('applyEdits: a FIND that is not in the file is refused, naming its first line', () => {
  const r = applyEdits('app.js', file, [{ find: 'function c() {', replace: 'x' }]);
  assert.ok('problems' in r);
  assert.match('problems' in r ? r.problems[0] : '', /app\.js, edit 1: the SEARCH lines are not in app\.js \(the first is "function c\(\) \{"\)/);
});

test('applyEdits: a FIND in two places is refused; spaces at line ends are forgiven', () => {
  const twice = applyEdits('app.js', file, [{ find: '}', replace: '};' }]);
  assert.match('problems' in twice ? twice.problems[0] : '', /in 2 places/);
  const spaced = applyEdits('app.js', file.replace('  return 1;', '  return 1;   '), [{ find: 'function a() {\n  return 1;\n}', replace: 'function a() {\n  return 10;\n}' }]);
  assert.ok('text' in spaced && spaced.text.includes('return 10;'));
});

test('applyEdits: blocks apply in order; one bad block changes nothing', () => {
  const r = applyEdits('app.js', file, [{ find: 'return 1;', replace: 'return 11;' }, { find: 'return 11;', replace: 'return 12;' }]);
  assert.ok('text' in r && r.text.includes('return 12;'));
  const bad = applyEdits('app.js', file, [{ find: 'return 1;', replace: 'return 11;' }, { find: 'nope', replace: '' }]);
  assert.ok('problems' in bad);
});

const answer = `I changed b.
=== EDIT: app.js ===
<<<<<<< FIND
  return 2;
=======
  return 3;
>>>>>>> REPLACE
<<<<<<< SEARCH
function a() {
=======
function a(x) {
>>>>>>> REPLACE
=== END EDIT ===
=== EDIT: other.js ===
<<<<<<< FIND
a
=======
b
>>>>>>> REPLACE
=== FILE: style.css ===
body { color: red; }
=== END FILE ===
SUMMARY: b now returns 3; a takes x.`;

test('parseEdits and parseResult: blocks for allowed files, the rest named as dropped; FILE blocks still read', () => {
  const e = parseEdits(answer, ['app.js']);
  assert.deepEqual(e.edits, [{ path: 'app.js', find: '  return 2;', replace: '  return 3;' }, { path: 'app.js', find: 'function a() {', replace: 'function a(x) {' }]);
  assert.deepEqual(e.dropped, ['other.js']);
  const r = parseResult(answer, ['app.js', 'style.css'], ['app.js']);
  assert.equal(r.edits?.length, 2);
  assert.deepEqual(r.files, [{ path: 'style.css', text: 'body { color: red; }\n' }]);
  assert.equal(r.summary, 'b now returns 3; a takes x.');
  assert.deepEqual(r.dropped, ['other.js']);
  // Without edit files, nothing changes from before.
  assert.equal(parseResult(answer, ['style.css']).edits, undefined);
});

test('the worker is told which files go whole and which by EDIT blocks; a retry asks for the blocks again', () => {
  const job: Job = { id: 'j', goal: 'Fix it', created: '', updated: '', notes: '', steps: [] };
  const step = cleanStep({ title: 'Change b', role: 'coder', files: ['app.js', 'style.css'], brief: 'Make b return 3.' })!;
  job.steps = [step];
  const sys = workerSystem('You write code.', job, step, 1, '', ['app.js']);
  assert.match(sys, /Give style\.css IN FULL/);
  assert.match(sys, /app\.js is too long to write out whole: change it with one or more EDIT blocks/);
  const user = workerUser(step, { 'app.js': file, 'style.css': '' }, '', [], ['app.js']);
  assert.match(user, /Current app\.js \(too long to write out whole: change it with EDIT blocks\)/);
  assert.match(user, /Change app\.js with EDIT blocks only, never the whole file\. End with the SUMMARY line\.$/);
  assert.match(fixMessage(['x'], ['app.js', 'style.css'], ['app.js']), /Give style\.css again, whole and fixed, in the same form, and every EDIT block for app\.js again/);
  // No edit files: as before.
  assert.match(workerSystem('You write code.', job, step, 1), /Give each file you write IN FULL/);
});
