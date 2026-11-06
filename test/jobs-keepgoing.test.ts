// Jobs that run unattended (6 Nov build tests, faults 2 and 6): every stop needed a manual Continue (4 for the fitness
// app, 2 for Flappy), and the default 8,192 context cut long edits off until it was raised to 32,768 by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JOB_CTX, KEEP_GOING_STOPS, keepGoing, raiseContext } from '../src/jobs.ts';

test('keepGoing: a first stop is tried again by itself; the same check failing again stops it (the two-tries rule)', () => {
  const idCheck = 'app.js: no page has an element with the id "chart-canvas"';
  assert.equal(keepGoing([], [idCheck]), true);
  assert.equal(keepGoing([[idCheck]], [idCheck]), false);
  // Numbers (lines, counts) do not make it a different check.
  assert.equal(keepGoing([['game.js (node): line 12: SyntaxError']], ['game.js (node): line 40: SyntaxError']), false);
  // A different check after the first stop: one more go.
  assert.equal(keepGoing([[idCheck]], ['The answer was cut off at its length limit, so a file may be unfinished.']), true);
  // Never more than KEEP_GOING_STOPS goes by itself for one step.
  assert.equal(KEEP_GOING_STOPS, 2);
  assert.equal(keepGoing([['a'], ['b']], ['c']), false);
});

test('keepGoing: a step that may already be done stops at once (press Mark done)', () => {
  assert.equal(keepGoing([], ['It came back unchanged twice, so the step may already be done: if the files already do what the step asks, press Mark done.', 'The answer changed nothing: every file came back exactly as it was.']), false);
});

test('raiseContext: a small context and a file over 4,000 characters go to 32,768 when the memory is free; else nothing', () => {
  const GB = 2 ** 30;
  assert.equal(JOB_CTX, 32_768);
  assert.equal(raiseContext(8192, 6_000, 0.8 * GB, 10 * GB), 32_768);
  assert.equal(raiseContext(16_384, 12_000, 0.5 * GB, 10 * GB), 32_768);
  // Big enough already, or small files: no reload.
  assert.equal(raiseContext(32_768, 50_000, 0, 10 * GB), null);
  assert.equal(raiseContext(65_536, 50_000, 0, 10 * GB), null);
  assert.equal(raiseContext(8192, 3_000, 0.8 * GB, 10 * GB), null);
  // Not enough free memory for the bigger cache plus a 1 GB margin.
  assert.equal(raiseContext(8192, 6_000, 0.8 * GB, 1.5 * GB), null);
});

test('the Jobs page has a "Keep going" tick, on by default, and LETS GO sends it', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../public/jobs.js', import.meta.url), 'utf8');
  assert.match(html, /<label class="check" id="job-keep-going-row"><input type="checkbox" id="job-keep-going" checked> Keep going/);
  assert.match(js, /'\/api\/jobs\/run', \{[^}]*keepGoing: \$\('#job-keep-going'\)\.checked/);
});
