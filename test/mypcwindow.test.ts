// The My PC window, what matters first (drawn in docs/mockups/my-pc-window.html, approved 2 Nov): is it working, what can
// it run, who works on it; the rest under folds, nothing taken away. Read from the page's own file; walked in the browser
// on a throwaway copy. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pcs = readFileSync(new URL('../public/pcs.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const drawn = /body\.replaceChildren\(head,[^\n]*/.exec(pcs)?.[0] ?? '';

test('the order: the PC, its models, its staff, then the folds', () => {
  const at = (s: string) => drawn.indexOf(s);
  assert.ok(drawn, 'the window is drawn in one place');
  for (const [a, b] of [['head', 'modelsPart(v)'], ['modelsPart(v)', 'peoplePart(v)'], ['peoplePart(v)', 'detailsFold'], ['detailsFold', 'nameFold'], ['nameFold', 'fold']]) {
    assert.ok(at(a) >= 0 && at(b) > at(a), `${a} comes before ${b}`);
  }
});

test('nothing is taken away: specs, tokens, most-used models and the name all sit under a fold', () => {
  const details = /const detailsFold = [\s\S]*?;\n/.exec(pcs)?.[0] ?? '';
  for (const part of ['specsPart(v)', 'strip', 'tokenLine', '...up', 'topPart(v)']) assert.ok(details.includes(part), part);
  assert.match(/const nameFold = [\s\S]*?;\n/.exec(pcs)?.[0] ?? '', /profileBlock\(v\)/);
  assert.match(pcs, /summary[^\n]*'Details'/);
  assert.match(pcs, /summary[^\n]*'Name and photo'/);
});

test('the top says it at a glance: a picture, the name, on or off, one line of specs, the version', () => {
  const head = /const head = el\('div', \{ class: 'pc-head' \}[\s\S]*?\n\s*manage\);/.exec(pcs)?.[0] ?? '';
  assert.match(head, /pcPicture\(v\)/);
  // The buttons of a linked PC sit in a row under it: Update (a tick when up to date) and Shut down.
  const row = /const actions = null|let actions = null;[\s\S]*?\n    \}\n/.exec(pcs)?.[0] ?? '';
  for (const word of ["'Shut down'", "'Up to date'", 'v.off?.can', 'powerOffWithPin']) assert.ok(row.includes(word), word);
  assert.match(pcs, /body\.replaceChildren\(head, actions \?\? ''/);
  assert.match(css, /\.pc-actions \{[^}]*flex-wrap: wrap/);
  assert.match(head, /specLine\(v\)/);
  assert.match(pcs, /const specLine = v =>/);
  assert.match(css, /\.pc-head-pic/);
});

test('a model is one line: what it is, how fast, what it needs; the rest behind "…", Test speed on show', () => {
  const row = /function modelRow\(v, x\) \{[\s\S]*?\n  \}/.exec(pcs)![0];
  assert.match(row, /el\('details', \{ class: 'pc-model-more' \}/);
  assert.match(row, /el\('summary', \{.*text: '…'/);
  assert.match(row, /x\.kind === 'image' \? 'Pictures' : 'Chat'/);
  assert.doesNotMatch(row, /v\.here \? 'Installed'/, '"Installed" on every line says nothing');
});

test('search, filters and sort only appear once there are many models', () => {
  const part = /function modelsPart\(v\) \{[\s\S]*?\n  \}/.exec(pcs)![0];
  assert.match(part, /const many = v\.models\.length > 6;/);
  assert.match(part, /many \? search : null/);
  assert.match(part, /many \? el\('div', \{ class: 'pc-tools' \}/);
  assert.match(part, /`Models \(\$\{shown\}\)`/);
  assert.match(part, /'Get a model'/);
  assert.match(/const none = [\s\S]*?;\n/.exec(pcs)![0], /No models on this PC yet/);
});

test('staff say who, with Hire beside the heading', () => {
  const part = /function peoplePart\(v\) \{[\s\S]*?\n  \}/.exec(pcs)![0];
  assert.match(part, /`Staff on this PC \(\$\{v\.staff\.length\}\)`/);
  assert.match(part, /text: 'Hire staff here'/);
});

test('a nearly full disk comes out of the fold by itself', () => {
  assert.match(pcs, /const LOW_DISK = 10 \* 2 \*\* 30;/);
  assert.match(pcs, /v\.disk && v\.disk\.free < LOW_DISK/);
});

test('Hire staff says plainly where the other models are', () => {
  const hire = readFileSync(new URL('../public/hire.js', import.meta.url), 'utf8');
  assert.match(hire, /available from across your network./);
  assert.doesNotMatch(hire, /has not got. Copy one there/);
});

test('a PC that did not answer: its reason takes a full row, so the name and the Off chip keep their room', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.pc-dlg \.pc-head-name \+ \.pc-head-ver\.fault-line \{[^}]*grid-column: 1 \/ -1/);
  assert.match(css, /\.pc-head-chip \{ white-space: nowrap; \}/);
});

test('a version or build mismatch takes a full row under the name, specs and button (they wrapped a word to a line)', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const pcs = readFileSync(new URL('../public/pcs.js', import.meta.url), 'utf8');
  assert.match(pcs, /!fine && !v\.fault \? ' long-line' : ''/);
  assert.match(css, /\.pc-dlg \.pc-head-name \+ \.pc-head-ver\.long-line \{[^}]*grid-column: 1 \/ -1[^}]*grid-row: 2/);
});

test('Models: free space on each drive is said above Free up space (a PC that lists no drives gives its one drive)', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const part = /function modelsPart\(v\) \{[\s\S]*?\n  \}\n/.exec(pcs)?.[0] ?? '';
  assert.match(part, /el\('div', \{ class: 'pc-free' \}, freeSpaceLine\(v\), free\)/, 'the line sits in the same column as the button, above it');
  const line = /function freeSpaceLine\(v\) \{[\s\S]*?\n  \}\n/.exec(pcs)?.[0] ?? '';
  assert.match(line, /v\.drives\?\.length/);
  assert.match(line, /Free space: \$\{words\}/);
  assert.match(line, /on the drive it keeps its data on/, 'an older PC names the one drive it reports');
  assert.match(css, /\.pc-free \{[^}]*flex-direction: column/);
  assert.match(css, /\.pc-free \.pc-free-space \{[^}]*font-size: 12px/, 'no text under 12px');
});
