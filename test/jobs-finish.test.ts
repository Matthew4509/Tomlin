// Jobs that finish (6 Nov 2026, from the build test on the P2000): the page's real ids reach a script step, a cut-off
// answer says what raising the context buys, and an answer that changes nothing twice stops the retries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextAdvice, pageIds, pageNote, repeatsNoChange } from '../src/jobs.ts';

const HTML = '<main><form id="workout-form"><input id="date"><button id="save-btn">Log</button></form><canvas id="volume-chart"></canvas><canvas id="volume-chart"></canvas></main>';

test('pageIds: every id of the page once, in order', () => {
  assert.deepEqual(pageIds(HTML), ['workout-form', 'date', 'save-btn', 'volume-chart']);
  assert.deepEqual(pageIds('<p>no ids</p>'), []);
  assert.deepEqual(pageIds(`<div ID='Upper' class="x">`), ['Upper']);
});

test('pageNote: a script or style step is told the page\'s ids, and to use no others', () => {
  const note = pageNote({ 'index.html': HTML, 'app.js': 'x' }, ['app.js']);
  assert.match(note, /index\.html/);
  assert.match(note, /volume-chart/);
  assert.match(note, /no other id|only these/i);
});

test('pageNote: nothing when the step already holds the page, has no script or style, or there is no page', () => {
  assert.equal(pageNote({ 'index.html': HTML }, ['index.html', 'app.js']), '');
  assert.equal(pageNote({ 'index.html': HTML }, ['notes.md']), '');
  assert.equal(pageNote({ 'app.js': 'x' }, ['app.js']), '');
  assert.equal(pageNote({ 'index.html': '<p>none</p>' }, ['app.js']), '');
});

test('pageNote: a long list of ids is cut, not allowed to fill the context', () => {
  const many = Array.from({ length: 400 }, (_, i) => `<i id="item-number-${i}"></i>`).join('');
  assert.ok(pageNote({ 'index.html': many }, ['app.js']).length < 2500);
});

test('contextAdvice: a small context is told what a bigger one buys; a big one is left alone', () => {
  const small = contextAdvice(8192);
  assert.match(small, /8,192/);
  assert.match(small, /16,384/);
  assert.equal(contextAdvice(16384), '');
  assert.equal(contextAdvice(32768), '');
});

test('repeatsNoChange: only the same "changed nothing" answer twice in a row', () => {
  const none = ['The answer changed nothing: every file came back exactly as it was.'];
  assert.equal(repeatsNoChange(none, none), true);
  assert.equal(repeatsNoChange(none, []), false);
  assert.equal(repeatsNoChange(none, ['a.js (node): SyntaxError']), false);
  assert.equal(repeatsNoChange([...none, 'a.js (node): SyntaxError'], none), false);
  assert.equal(repeatsNoChange([], []), false);
});

test('workspaceNote: a new job in a workspace that already holds files is told, with a way out', async () => {
  const { workspaceNote } = await import('../src/jobs.ts');
  assert.equal(workspaceNote([]), '');
  assert.equal(workspaceNote(['jobs/x/plan.json']), '');
  const n = workspaceNote(['index.html', 'game.js', 'style.css', 'jobs/x/plan.json']);
  assert.match(n, /index\.html/);
  assert.match(n, /3 files/);
  assert.match(n, /own folder|clear/i);
  assert.ok(workspaceNote(Array.from({ length: 30 }, (_, i) => `f${i}.txt`)).length < 400, 'a long list is cut');
});

test('planSystem: the planner is told not to add a step that only tests or reviews', async () => {
  const { planSystem } = await import('../src/jobs.ts');
  assert.match(planSystem([]), /only tests|only checks|only reviews/i);
});

test('droppedDefinitions: top-level functions, classes and the program start that a change removed', async () => {
  const { droppedDefinitions } = await import('../src/jobs.ts');
  const before = `import x\n\ndef handle_home():\n    pass\n\nclass Store:\n    def inner(self): pass\n\nasync def later(): pass\n\nif __name__ == '__main__':\n    run()\n`;
  const after = `import x\n\ndef handle_home():\n    pass\n\nclass Store:\n    def inner(self): pass\n`;
  assert.deepEqual(droppedDefinitions(before, after), ['later', 'the program start (if __name__ == "__main__")']);
  assert.deepEqual(droppedDefinitions(before, before), []);
  assert.deepEqual(droppedDefinitions(before, after.replace('handle_home', 'handle_index')).includes('handle_home'), true);
  // a method inside a class is not top level, so removing it is not reported
  assert.deepEqual(droppedDefinitions('class A:\n    def m(self): pass\n', 'class A:\n    pass\n'), []);
  // JavaScript
  assert.deepEqual(droppedDefinitions('function a(){}\nexport async function b(){}\n', 'function a(){}\n'), ['b']);
  // a new file has nothing to drop
  assert.deepEqual(droppedDefinitions('', 'def a(): pass'), []);
});
