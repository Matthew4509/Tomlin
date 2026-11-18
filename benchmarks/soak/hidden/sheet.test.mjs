import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const mod = await load('sheet.js');
const Sheet = mod.Sheet ?? mod.default;
const fresh = () => new Sheet();

test('numbers, text and empty cells', () => {
  const s = fresh();
  s.set('A1', '5');
  s.set('A2', 'hello');
  assert.equal(s.get('A1'), 5);
  assert.equal(s.get('A2'), 'hello');
  assert.equal(s.get('Z9'), '');
});
test('formulas with precedence, brackets and unary minus', () => {
  const s = fresh();
  s.set('A1', '=2+3*4');
  s.set('A2', '=(2+3)*4');
  s.set('A3', '=-A1+20');
  s.set('A4', '=10/4');
  assert.equal(s.get('A1'), 14);
  assert.equal(s.get('A2'), 20);
  assert.equal(s.get('A3'), 6);
  assert.equal(s.get('A4'), 2.5);
});
test('references, an empty cell counts as 0, and changes flow through chains', () => {
  const s = fresh();
  s.set('A1', '10');
  s.set('B1', '=A1*2');
  s.set('C1', '=B1+1');
  s.set('D1', '=Z9+1');
  assert.equal(s.get('C1'), 21);
  assert.equal(s.get('D1'), 1);
  s.set('A1', '100');
  assert.equal(s.get('B1'), 200);
  assert.equal(s.get('C1'), 201);
});
test('SUM, MIN, MAX and AVERAGE over a range', () => {
  const s = fresh();
  s.set('A1', '4');
  s.set('A2', '8');
  s.set('A3', '=A1+A2');
  s.set('B1', '=SUM(A1:A3)');
  s.set('B2', '=MIN(A1:A3)');
  s.set('B3', '=MAX(A1:A3)');
  s.set('B4', '=AVERAGE(A1:A3)');
  assert.equal(s.get('B1'), 24);
  assert.equal(s.get('B2'), 4);
  assert.equal(s.get('B3'), 12);
  assert.equal(s.get('B4'), 8);
});
test('a range over two columns', () => {
  const s = fresh();
  s.set('A1', '1');
  s.set('B1', '2');
  s.set('A2', '3');
  s.set('B2', '4');
  s.set('C1', '=SUM(A1:B2)');
  assert.equal(s.get('C1'), 10);
});
test('a cycle is #CYCLE in every cell of it, and mending it mends them', () => {
  const s = fresh();
  s.set('C1', '=C2');
  s.set('C2', '=C1');
  assert.equal(s.get('C1'), '#CYCLE');
  assert.equal(s.get('C2'), '#CYCLE');
  s.set('C2', '1');
  assert.equal(s.get('C1'), 1);
  const t = fresh();
  t.set('A1', '=A1+1');
  assert.equal(t.get('A1'), '#CYCLE');
});
test('an error spreads to what uses it', () => {
  const s = fresh();
  s.set('A1', '=1/0');
  s.set('A2', '=A1+1');
  assert.equal(s.get('A1'), '#DIV/0');
  assert.equal(s.get('A2'), '#DIV/0');
});
test('a bad formula is #ERR, not an exception', () => {
  const s = fresh();
  assert.doesNotThrow(() => s.set('A1', '=2+'));
  assert.equal(s.get('A1'), '#ERR');
  assert.doesNotThrow(() => s.set('A2', '=NOPE(1)'));
  assert.equal(s.get('A2'), '#ERR');
});
test('a text cell used in arithmetic is #VALUE', () => {
  const s = fresh();
  s.set('A1', 'hello');
  s.set('A2', '=A1+1');
  assert.equal(s.get('A2'), '#VALUE');
});
test('a long chain updates without overflowing the stack', () => {
  const s = fresh();
  s.set('A1', '1');
  for (let i = 2; i <= 2000; i++) s.set(`A${i}`, `=A${i - 1}+1`);
  assert.equal(s.get('A2000'), 2000);
  s.set('A1', '11');
  assert.equal(s.get('A2000'), 2010);
});
test('cell names are not case sensitive', () => {
  const s = fresh();
  s.set('a1', '3');
  s.set('b1', '=A1*3');
  assert.equal(s.get('B1'), 9);
});
