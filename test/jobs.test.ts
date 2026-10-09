import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixMessage, parseReview, relativeImports, reviewUser, swapCount, testFixStep, workerRole } from '../src/jobs.ts';
import { addNote, applyEdit, dropNote, cleanFiles, crossCheck, factsOf, cleanRole, jobId, nextIndex, parsePlan, parseResult, planPath, validId, workerSystem, workerUser, type Job } from '../src/jobs.ts';

const job = (steps: Job['steps']): Job => ({ id: '20261003-1200-abcd', goal: 'a tip calculator page', created: '', updated: '', notes: '', steps });

test('a job id is dated, checked, and its plan lives under jobs/', () => {
  const id = jobId(new Date(2026, 9, 3, 9, 5), 0.5);
  assert.equal(id, '20261003-0905-8000');
  assert.ok(validId(id));
  for (const bad of ['../x', '20261003-0905-80000', '', 7]) assert.equal(validId(bad), false);
  assert.equal(planPath(id), 'jobs/20261003-0905-8000/plan.json');
});

test('step files: plain workspace text files only, no plan files, at most four', () => {
  assert.deepEqual(cleanFiles('src/app.js, `index.html`, ../x.js, run.exe, jobs/a/plan.json, src/app.js'), ['src/app.js', 'index.html']);
  assert.deepEqual(cleanFiles(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']), ['a.md', 'b.md', 'c.md', 'd.md']);
  assert.deepEqual(cleanFiles('tool.py; notes.txt'), ['tool.py', 'notes.txt']);
});

test('roles come from the word, or a guess from the files', () => {
  assert.equal(cleanRole('Developer', []), 'coder');
  assert.equal(cleanRole('Copywriter', []), 'writer');
  assert.equal(cleanRole('logo designer', []), 'designer');
  assert.equal(cleanRole('Illustrator', []), 'artist');
  assert.equal(cleanRole('', ['app.js']), 'coder');
  assert.equal(cleanRole('?', ['about.md']), 'writer');
});

test('the manager\'s STEP blocks parse into steps, with wrapped lines joined', () => {
  const steps = parsePlan(`Here is the plan.

**STEP 1:** Page layout
ROLE: Coder
FILES: index.html, style.css
BRIEF: Make a page with two number boxes
and a result line.
CHECK: Open index.html and see the boxes.

STEP 2: Calculation
ROLE: coder
FILES: app.js
BRIEF: Work out the tip.
CHECK: 50 at 10% shows 5.

STEP: Help text
ROLE: writer
FILES: help.md
BRIEF: Two short paragraphs.`);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[0].files, ['index.html', 'style.css']);
  assert.equal(steps[0].brief, 'Make a page with two number boxes and a result line.');
  assert.equal(steps[0].role, 'coder');
  assert.equal(steps[1].check, '50 at 10% shows 5.');
  assert.equal(steps[2].role, 'writer');
  assert.equal(steps[2].status, 'todo');
});

test('empty FILES are taken from the brief; a step with files is never a picture step; a real picture step keeps no files', () => {
  const [a, b, c] = parsePlan(`STEP: The sums
ROLE: coder
FILES:
BRIEF: In app.js, write calculateTip and update index.html.
STEP: Styling
ROLE: designer
FILES: style.css
BRIEF: Centre the box.
STEP: Header picture
ROLE: artist
BRIEF: A warm cafe table, for hero.png in index.html.`);
  assert.deepEqual(a.files, ['app.js', 'index.html']);
  assert.equal(b.role, 'coder');
  assert.deepEqual([c.role, c.files], ['artist', []]);
});

test('a file name that is prompt text is not taken as a file; a sane name, a folder and the app\'s own stamped names are', () => {
  const [a, b] = parsePlan(`STEP: Write the story
ROLE: writer
FILES: A short story about a fox who learns to read under the old oak tree at night.md, story.md
BRIEF: Write the story.
STEP: Notes
ROLE: writer
FILES: Write two plain paragraphs about the fox.md
BRIEF: Two paragraphs, saved in notes-on-fox.md.`);
  assert.deepEqual(a.files, ['story.md']);
  // Nothing sane in FILES: the file named in the brief is used instead.
  assert.deepEqual(b.files, ['notes-on-fox.md']);
  assert.deepEqual(cleanFiles('my notes on the trip.md, src/app.js, ../escape.md, C:/x.md, run.exe, specialists/writer/2026-10-07-1530 A fox and an owl meet at night.md'),
    ['my notes on the trip.md', 'src/app.js', 'specialists/writer/2026-10-07-1530 A fox and an owl meet at night.md']);
  assert.deepEqual(cleanFiles(`${'x'.repeat(61)}.md, ${'y'.repeat(60)}.md`), [`${'y'.repeat(60)}.md`]);
});

test('a picture step must say what to draw: an empty one is left out of the plan', () => {
  const steps = parsePlan(`STEP: Page
ROLE: coder
FILES: index.html
BRIEF: Make the page.
STEP: Picture
ROLE: artist
BRIEF:
STEP: Draw the logo
ROLE: designer
STEP: Hero image
ROLE: artist
BRIEF: A warm cafe table with two cups, morning light.
STEP: A red fox at dusk
ROLE: artist`);
  assert.deepEqual(steps.map(s => s.title), ['Page', 'Hero image', 'A red fox at dusk']);
  assert.equal(steps[2].brief, 'A red fox at dusk');
});

test('a plain numbered list still gives steps; nothing usable gives none', () => {
  const steps = parsePlan('1. Write the page\n2. Add the sums\n3) Test on a phone');
  assert.deepEqual(steps.map(s => s.title), ['Write the page', 'Add the sums', 'Test on a phone']);
  assert.deepEqual(parsePlan('I am not sure what you mean.'), []);
  assert.equal(parsePlan(Array.from({ length: 12 }, (_, i) => `STEP: s${i}\nROLE: coder`).join('\n')).length, 8);
});

test('notes keep one line per finished step and drop the oldest when long', () => {
  let notes = addNote('', 1, 'Layout', 'Made index.html with ids bill and tip.');
  notes = addNote(notes, 2, 'Sums', '');
  assert.equal(notes, 'Step 1 (Layout): Made index.html with ids bill and tip.\nStep 2 (Sums): done.');
  for (let i = 3; i < 40; i++) notes = addNote(notes, i, 'x', 'y'.repeat(100));
  assert.ok(notes.length <= 1600);
  assert.ok(notes.startsWith('Step ') && !notes.includes('Step 1 '));
});

test('the names other files need are read from the saved file by code', () => {
  const html = '<link rel="stylesheet" href="style.css"><input id="billAmount"><select id=\'tipPercentage\'></select><span id="total"></span><script src="app.js"></script>';
  assert.equal(factsOf('index.html', html), 'index.html: ids billAmount, tipPercentage, total; loads style.css, app.js');
  const js = 'const bill = document.getElementById("billAmount");\nfunction update() {}\nexport async function save() {}\nclass Calc {}\n  const inner = 1;\ndocument.querySelector("#total");';
  assert.equal(factsOf('src/app.js', js), 'src/app.js: defines bill, update, save, Calc; uses ids billAmount, total');
  assert.equal(factsOf('tool.py', 'def main():\n  pass\nclass Tip:\n  def inner(self): pass'), 'tool.py: defines main, Tip');
  assert.equal(factsOf('style.css', '.card, #total { color: red }\nbody { margin: 0 }\n.card:hover { x: 1 }'), 'style.css: styles .card, #total');
  assert.equal(factsOf('notes.md', '# Hi'), '');
  assert.equal(addNote('', 1, 'Page', 'Made the page.', ['index.html: ids a', '']), 'Step 1 (Page): Made the page.\n  index.html: ids a');
});

test('the cross-file check finds an id nobody defines and a file nobody loads, and stays quiet otherwise', () => {
  const page = '<input id="billAmount"><span id="total"></span><script src="app.js"></script>';
  assert.deepEqual(crossCheck({
    'index.html': page,
    'app.js': 'document.getElementById("billAmount"); document.querySelector("#result-display");',
    'style.css': '#billInput { x: 1 } #total { y: 2 } .card {}',
    'src/server.js': 'getElementById("nothing")',
    'lib/util.js': '',
  }), [
    'app.js looks up "result-display", but no page has an element with that id.',
    'style.css styles #billInput, but no page has that id.',
    'style.css is not loaded by any page (index.html).',
    'src/server.js looks up "nothing", but no page has an element with that id.',
  ]);
  assert.deepEqual(crossCheck({ 'index.html': `${page}<link rel="stylesheet" href="./style.css">`, 'app.js': 'getElementById("total")', 'style.css': '#total {}' }), []);
  assert.deepEqual(crossCheck({ 'app.js': 'getElementById("x")' }), []);
  assert.deepEqual(crossCheck({ 'web/index.html': '<script src="js/app.js"></script>', 'web/js/app.js': '' }), []);
  // Tests are never loaded by a page.
  assert.deepEqual(crossCheck({ 'index.html': '<p></p>', 'tip.test.mjs': '', 'test_tip.js': '' }), []);
});

test('a file\'s names are listed once, the newest', () => {
  let notes = addNote('', 1, 'Page', 'a', ['index.html: ids a']);
  notes = addNote(notes, 2, 'Page again', 'b', ['index.html: ids b']);
  assert.equal(notes, 'Step 1 (Page): a\nStep 2 (Page again): b\n  index.html: ids b');
});

test('an edit keeps finished steps in front and replaces the rest', () => {
  const done = { ...parsePlan('STEP: one\nFILES: a.md')[0], status: 'done' as const, summary: 'did a' };
  const j = job([done, ...parsePlan('STEP: two\nSTEP: three')]);
  const r = applyEdit(j, [{ title: 'three', role: 'writer', files: 'c.md', brief: 'b' }, { title: '' }, { title: 'two' }]);
  assert.ok(Array.isArray(r));
  assert.deepEqual(r.map(s => s.title), ['one', 'three', 'two']);
  assert.equal(r[0].summary, 'did a');
  assert.ok('error' in (applyEdit(j, 'no') as object));
  assert.equal(nextIndex({ ...j, steps: r }), 1);
});

test('a worker sees its brief, its files and the notes, and is told the file form', () => {
  const step = parsePlan('STEP: Sums\nROLE: coder\nFILES: app.js, index.html\nBRIEF: Add the tip sum.')[0];
  const sys = workerSystem('You are a coder.', { ...job([step]), notes: 'Step 1 (Layout): ids bill, tip.' }, step, 1);
  assert.match(sys, /only these files: app\.js, index\.html/);
  assert.match(sys, /=== FILE: path ===/);
  assert.match(sys, /ids bill, tip/);
  const user = workerUser(step, { 'app.js': null, 'index.html': '<p>hi</p>' });
  assert.match(user, /File app\.js does not exist yet/);
  assert.match(user, /=== FILE: index\.html ===\n<p>hi<\/p>/);
});

test('a worker answer gives only the allowed files, whole, and the summary', () => {
  const r = parseResult(`Sure.
=== FILE: app.js ===
\`\`\`js
const tip = (b, p) => b * p / 100;
\`\`\`
=== END FILE ===
=== FILE: ../evil.js ===
x
=== END FILE ===
=== FILE: other.js ===
y
=== END FILE ===
SUMMARY: Added tip(b, p) in app.js.`, ['app.js']);
  assert.deepEqual(r.files, [{ path: 'app.js', text: 'const tip = (b, p) => b * p / 100;\n' }]);
  assert.deepEqual(r.dropped, ['../evil.js', 'other.js']);
  assert.equal(r.summary, 'Added tip(b, p) in app.js.');
});

test('a block with no END line still ends at the next file or the summary; an echoed instruction is not the summary', () => {
  const r = parseResult(`=== FILE: index.html ===
<p>old</p>
=== FILE: app.js ===
let a = 1;
SUMMARY: Then one last line: SUMMARY: Made app.js with a.`, ['app.js']);
  assert.deepEqual(r.files, [{ path: 'app.js', text: 'let a = 1;\n' }]);
  assert.deepEqual(r.dropped, ['index.html']);
  assert.equal(r.summary, 'Made app.js with a.');
});

test('the names saved by earlier steps sit next to the brief; the step\'s own file is left out', () => {
  const step = parsePlan('STEP: Sums\nROLE: coder\nFILES: app.js\nBRIEF: Add the tip sum.')[0];
  const notes = addNote(addNote('', 1, 'Page', 'ok', ['index.html: ids billAmount, total']), 2, 'Old js', 'ok', ['app.js: defines x']);
  const user = workerUser(step, { 'app.js': null }, notes);
  assert.match(user, /Use exactly these names[^]*- index\.html: ids billAmount, total/);
  assert.doesNotMatch(user, /app\.js: defines x/);
  assert.match(user, /Write only app\.js\. Do not write any other file[^\n]*$/);
  assert.doesNotMatch(workerUser(step, { 'app.js': null }), /exactly these names/);
});

test('the swap count follows the waiting steps in order; done and picture steps need no model', () => {
  const steps = parsePlan('STEP: a\nROLE: coder\nFILES: a.js\nSTEP: b\nROLE: writer\nFILES: b.md\nSTEP: c\nROLE: coder\nFILES: c.js\nSTEP: pic\nROLE: artist\nBRIEF: A fox asleep under a lamp.\nSTEP: d\nROLE: coder\nFILES: d.js');
  steps[0].status = 'done';
  const models = { coder: 'big', writer: 'small' } as Record<string, string>;
  assert.deepEqual(swapCount(steps, 'big', r => models[r]), { swaps: 2, loads: ['small', 'big'] });
  assert.deepEqual(swapCount(steps, null, () => ''), { swaps: 0, loads: [] });
  assert.equal(workerRole(steps[3]), null);
});

test('a retry tells the worker what failed, last', () => {
  assert.equal(fixMessage(['app.js (node --check): SyntaxError: Unexpected token'], ['app.js']), 'Your last answer failed these checks:\n- app.js (node --check): SyntaxError: Unexpected token\n\nGive app.js again, whole and fixed, in the same form, then the SUMMARY line.');
});

test('the reviewer\'s verdict is read; an answer out of form is "unclear", not a pass', () => {
  assert.deepEqual(parseReview('**VERDICT: OK**'), { ok: true, problems: [] });
  assert.deepEqual(parseReview('VERDICT: PROBLEMS\n- app.js looks up result-display, which index.html does not have\n- No total line'), { ok: false, problems: ['app.js looks up result-display, which index.html does not have', 'No total line'] });
  assert.deepEqual(parseReview('VERDICT: problems'), { ok: false, problems: ['The reviewer said there are problems but did not say what they are.'] });
  assert.deepEqual(parseReview('VERDICT: PROBLEMS\n- tip.mjs\n- `app.js`'), { ok: false, problems: ['The reviewer said there are problems but did not say what they are.'] });
  assert.equal(parseReview('Looks good to me!').ok, null);
  const step = parsePlan('STEP: Sums\nFILES: app.js\nBRIEF: Add it.')[0];
  const msg = reviewUser({ ...job([step]), notes: addNote('', 1, 'Page', 'ok', ['index.html: ids total']) }, step, [{ path: 'app.js', text: 'x'.repeat(50) }], ['app.js looks up "a"'], 20);
  assert.match(msg, /index\.html: ids total/);
  assert.match(msg, /already found:\n- app\.js looks up "a"/);
  assert.match(msg, /x{20}\n\[\.\.\. cut/);
});

test('failing tests become a new coder step with the output and the files it names', () => {
  const j = job(parsePlan('STEP: code\nROLE: coder\nFILES: src/tip.js'));
  const s = testFixStep(j, 'node --test', 'not ok 1 - adds\n  at tip.test.js:3\n  at src/tip.js:7', ['src/tip.js', 'tip.test.js', 'jobs/x/plan.json']);
  assert.deepEqual(s.files, ['src/tip.js', 'tip.test.js']);
  assert.match(s.brief, /not ok 1 - adds/);
  assert.deepEqual(testFixStep(j, 'npm test', 'boom', ['src/tip.js']).files, ['src/tip.js']);
  assert.ok(testFixStep(j, 'npm test', 'y'.repeat(5000), []).brief.length <= 1600);
  // The start of the output is kept (it names what failed).
  assert.match(testFixStep(j, 'x', `500 !== 5${'z'.repeat(3000)}`, []).brief, /500 !== 5/);
});

test('a failing test brings the code it imports into the fix step, code first', () => {
  const j = job([]);
  const files = ['tip.mjs', 'tip.test.mjs', 'lib/util.js', 'other.js'];
  const s = testFixStep(j, 'node --test', '✖ 10 per cent of 50 is 5\ntest at tip.test.mjs:5:1\n500 !== 5', files, { 'tip.test.mjs': 'import { tip } from "./tip.mjs";\nconst u = require("./lib/util");' });
  assert.deepEqual(s.files, ['tip.mjs', 'lib/util.js', 'tip.test.mjs']);
  assert.deepEqual(relativeImports('tests/test_tip.py', 'from .tip import tip\n', ['tests/tip.py']), ['tests/tip.py']);
  assert.deepEqual(relativeImports('a/b.test.js', 'import x from "../c.js"; import y from "react";', ['c.js']), ['c.js']);
});

test('one allowed file and a plain code fence: the fence is the file; no summary line: the prose is', () => {
  const r = parseResult('Here it is:\n```python\nprint(1)\n```\nIt prints one.', ['tool.py']);
  assert.deepEqual(r.files, [{ path: 'tool.py', text: 'print(1)\n' }]);
  assert.equal(r.summary, 'Here it is: It prints one.');
  assert.deepEqual(parseResult('```\nx\n```', ['a.js', 'b.js']).files, []);
});

test('a step done again keeps one line in the notes, and loses it while it waits', () => {
  let notes = addNote('', 1, 'Page', 'a', ['index.html: ids a']);
  notes = addNote(notes, 2, 'Script', 'b', ['app.js: defines go']);
  const waiting = dropNote(notes, 1);
  assert.equal(waiting, '  index.html: ids a\nStep 2 (Script): b\n  app.js: defines go');
  notes = addNote(waiting, 1, 'Page', 'c', ['index.html: ids c']);
  assert.equal(notes, 'Step 2 (Script): b\n  app.js: defines go\nStep 1 (Page): c\n  index.html: ids c');
  assert.equal(dropNote('Step 10 (x): y', 1), 'Step 10 (x): y');
});

test('a file that comes back under half its size is a failed check (a fragment would lose the rest)', async () => {
  const { shrunk } = await import('../src/jobs.ts');
  const page = 'x'.repeat(8887);
  assert.match(shrunk({ 'page.html': page }, [{ path: 'page.html', text: 'y'.repeat(413) }])[0], /^page\.html came back at 413 characters, from 8,887: most of the file was left out/);
  // A small change, a new file, a short file, or a file that grew: no complaint.
  assert.deepEqual(shrunk({ 'page.html': page, 'a.js': null, 'b.css': 'z'.repeat(300) }, [{ path: 'page.html', text: 'y'.repeat(5000) }, { path: 'a.js', text: 'q' }, { path: 'b.css', text: 'w' }]), []);
});
