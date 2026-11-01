// The window for moving a hire to another PC: a linked PC slow to say what it has is waited for, never refused, and when
// it really offers nothing the window says what is true. Read from the page's own file; walked in the browser on a
// throwaway copy with the PC's answer held back. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const home = readFileSync(new URL('../public/home.js', import.meta.url), 'utf8');
const move = /async function deskMove\(s, pc, pcName\) \{[\s\S]*?\n\}\n/.exec(home)![0];

test('no words about logging in or permissions: neither is what stops a move', () => {
  assert.doesNotMatch(move, /can't log in|check its permissions/);
});

test('a linked PC with nothing listed yet is asked again before anything is said', () => {
  const waits = move.indexOf('what models it has');
  const says = move.indexOf('is not answering just now');
  assert.ok(waits > 0, 'it says it is asking');
  assert.ok(says > waits, 'the verdict comes after the asking');
  assert.match(move, /if \(!moveDlg\.open\) return;/, 'Cancel while it asks ends it');
  assert.match(move, /\$\('#desk-move-go'\)\.hidden = true;/, 'nothing to press while it asks');
});

test('when it really offers nothing, it says which: not answering, or no models yet, with Try again', () => {
  assert.match(move, /is not answering just now/);
  assert.match(move, /has no \$\{[^}]*\} models yet\. Send one there from Models\./);
  assert.match(move, /text: 'Try again'/);
  assert.match(move, /team\.data\?\.pcs\?\.find\(p => p\.id === pc\)\?\.ok/);
});
