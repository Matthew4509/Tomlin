// A setup code as it is typed: like a Windows key, the dash comes by itself and the fifth character is in the second
// group. Read from the page's own file; typed in the browser on a throwaway copy. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const app = read('app.js');
const source = /function shapeCode\(text, deleting = false\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? 'function shapeCode() { return null; }';
const shapeCode = new Function(`${source}; return shapeCode;`)() as (text: string, deleting?: boolean) => string;

test('the dash comes by itself, and the fifth character is in the second group', () => {
  assert.equal(shapeCode('A'), 'A');
  assert.equal(shapeCode('ABC'), 'ABC');
  assert.equal(shapeCode('ABCD'), 'ABCD-', 'the next character already goes in the second group');
  assert.equal(shapeCode('ABCDE'), 'ABCD-E');
  assert.equal(shapeCode('ABCD-E'), 'ABCD-E');
  assert.equal(shapeCode('ABCDEFGH'), 'ABCD-EFGH');
});

test('small letters, spaces and a pasted code all come out the same, and no more than 8 characters are kept', () => {
  assert.equal(shapeCode('abcd-efgh'), 'ABCD-EFGH');
  assert.equal(shapeCode(' abcd efgh '), 'ABCD-EFGH');
  assert.equal(shapeCode('ABCD-EFGH-JK'), 'ABCD-EFGH');
  assert.equal(shapeCode('a!b@c#d$e'), 'ABCD-E');
});

test('Backspace can go back past the dash', () => {
  assert.equal(shapeCode('ABCD-', true), 'ABCD', 'the dash goes, so the next Backspace takes the D');
  assert.equal(shapeCode('ABC', true), 'ABC');
  assert.equal(shapeCode('ABCD-E', true), 'ABCD-E');
});

test('both boxes for a setup code do it, wherever the box is drawn from', () => {
  assert.match(read('index.html'), /id="node-addr-code"[^>]*data-setup-code/);
  assert.match(read('home.js'), /el\('input', \{[^}]*'data-setup-code': ''[^}]*'aria-label': `Setup code of/);
  assert.match(app, /document\.addEventListener\('input', e => \{[\s\S]*?matches\?\.\('\[data-setup-code\]'\)/);
});
