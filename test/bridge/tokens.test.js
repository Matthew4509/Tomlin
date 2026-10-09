// Tests for lib/tokens.js: transcripts are read in 1 MB pieces, so lines longer than a piece and characters split
// between two pieces must come through whole. Run: node test/tokens.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { eachLine } = require('../../src/bridge/tokens');

let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-tokens-'));
// Removed however the test ends (a failed check or a crash too); a folder something still holds gets a few tries.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} });
const lines = f => { const out = []; eachLine(f, l => out.push(l)); return out; };

check('every line comes back, the last one without a newline too', () => {
  const f = path.join(tmp, 'a.jsonl');
  fs.writeFileSync(f, 'one\ntwo\n\nthree');
  assert.deepStrictEqual(lines(f), ['one', 'two', 'three']);
});
check('a line longer than the 1 MB piece comes back whole', () => {
  const f = path.join(tmp, 'b.jsonl');
  const big = 'x'.repeat(3 * 1024 * 1024 + 17);
  fs.writeFileSync(f, 'first\n' + big + '\nlast\n');
  const got = lines(f);
  assert.strictEqual(got.length, 3);
  assert.strictEqual(got[1].length, big.length);
  assert.strictEqual(got[2], 'last');
});
check('a character split between two pieces is not broken', () => {
  const f = path.join(tmp, 'c.jsonl');
  // "é" is 2 bytes and "€" 3: start them one byte before the 1 MB mark so they straddle it.
  const pad = 'a'.repeat(1024 * 1024 - 1);
  fs.writeFileSync(f, pad + 'é€ok\nnext\n');
  const got = lines(f);
  assert.strictEqual(got[0].slice(-4), 'é€ok');
  assert.strictEqual(got[1], 'next');
});
check('a missing file is no lines, not an error', () => assert.deepStrictEqual(lines(path.join(tmp, 'none.jsonl')), []));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
