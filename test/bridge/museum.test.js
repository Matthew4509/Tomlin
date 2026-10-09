// The museum (test/museum/, run by tools/benchmark.js) as a test: every case is well formed, every class in
// test/museum/baseline.json is still caught, no fixed copy is flagged, and the must-stay-quiet cases stay quiet
// (apart from the false flags the baseline already names, which a later phase is to fix).
// After a phase adds rules: run `node tools/benchmark.js`, then add the newly caught ids to baseline.json.
// Run: node test/museum.test.js   (no packages; about 15 s).
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { loadCases, run, report } = require('../../tools/bridge/benchmark');

const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'museum', 'baseline.json'), 'utf8'));
let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };

(async () => {
  const cases = loadCases();
  check('every case has an id, a bucket, a title and both copies (or quiet files)', () => {
    for (const c of cases) assert(c.id && c.title && (c.quiet ? c.files : (c.bad && c.good && /^[RXL]$/.test(c.bucket))), c.id);
  });
  check('every case names the faults it was built from', () => { for (const c of cases) assert(Array.isArray(c.examples), c.id); });
  check('the baseline names only cases that exist', () => {
    const ids = new Set(cases.map(c => c.id));
    for (const id of [...baseline.caught, ...baseline.knownFalseFlags]) assert(ids.has(id), id);
  });
  const results = await run(cases);
  const byId = new Map(results.map(r => [r.c.id, r]));
  check('no case failed to run', () => { const bad = results.filter(r => r.error); assert(!bad.length, bad.map(r => r.c.id + ': ' + r.error).join('; ')); });
  check('every class in the baseline is still caught', () => {
    const lost = baseline.caught.filter(id => !byId.get(id).caught);
    assert(!lost.length, 'no longer caught: ' + lost.join(', '));
  });
  check('no fixed copy is flagged', () => {
    const noisy = results.filter(r => !r.quiet && r.noisy);
    assert(!noisy.length, noisy.map(r => r.c.id + ' (' + r.noise.map(f => f.rule + ' ' + f.where).join(', ') + ')').join('; '));
  });
  check('the must-stay-quiet cases stay quiet (known false flags apart)', () => {
    const flagged = results.filter(r => r.quiet && r.noisy && !baseline.knownFalseFlags.includes(r.c.id));
    assert(!flagged.length, flagged.map(r => r.c.id + ' (' + r.noise.map(f => f.rule).join(',') + ')').join('; '));
  });
  check('a known false flag that is fixed is taken off the baseline', () => {
    const fixed = baseline.knownFalseFlags.filter(id => !byId.get(id).noisy);
    assert(!fixed.length, 'now quiet, remove from knownFalseFlags: ' + fixed.join(', '));
  });
  const newly = results.filter(r => r.caught && !baseline.caught.includes(r.c.id)).map(r => r.c.id);
  if (newly.length) console.log('note: caught now and not in the baseline yet (add them): ' + newly.join(', '));
  console.log('\n' + report(results, false).text.split('\n').slice(0, 5).join('\n'));
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
})();
