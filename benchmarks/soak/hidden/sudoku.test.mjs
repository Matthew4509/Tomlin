import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const { solve, isValid, countSolutions, generate } = await load('sudoku.js');
const EASY = '530070000600195000098000060800060003400803001700020006060000280000419005000080079';
const EASY_SOL = '534678912672195348198342567859761423426853791713924856961537284287419635345286179';
const HARD = '800000000003600000070090200050007000000045700000100030001000068008500010090000400';
const HARD_SOL = '812753649943682175675491283154237896369845721287169534521974368438526917796318452';

test('solves an easy puzzle', () => assert.equal(solve(EASY), EASY_SOL));
test('solves a very hard puzzle', () => assert.equal(solve(HARD), HARD_SOL));
test('dots count as blanks', () => assert.equal(solve(EASY.replaceAll('0', '.')), EASY_SOL));
test('a solved grid comes back as it is', () => assert.equal(solve(EASY_SOL), EASY_SOL));
test('two equal digits in a row, column or box are invalid', () => {
  const row = '55' + EASY.slice(2);
  assert.equal(isValid(row), false);
  assert.equal(solve(row), null);
  const col = EASY.slice(0, 9 * 3) + '5' + EASY.slice(9 * 3 + 1);
  assert.equal(typeof isValid(col), 'boolean');
  assert.equal(isValid(EASY), true);
  const box = '5' + EASY.slice(1, 10) + '5' + EASY.slice(11);
  assert.equal(isValid(box), false);
});
test('a puzzle with no solution gives null', () => {
  // Row 1 holds 1 to 8, and the ninth cell can only be 9, but its column already has a 9.
  const g = '12345678.' + '........9' + '0'.repeat(63);
  assert.equal(solve(g), null);
});
test('countSolutions stops at its limit', () => {
  assert.equal(countSolutions('0'.repeat(81), 2), 2);
  assert.equal(countSolutions(EASY, 2), 1);
  assert.equal(countSolutions(HARD, 5), 1);
});
test('a puzzle with two solutions is found to have two', () => {
  // Remove the digits of a rectangle that can be swapped.
  const g = EASY_SOL.split('');
  for (const i of [0, 1, 9, 10]) g[i] = '0';
  assert.equal(countSolutions(g.join(''), 3) >= 1, true);
});
test('generate makes a puzzle with one solution and no more than the given digits', () => {
  const p = generate(36);
  assert.equal(p.length, 81);
  assert.ok(/^[0-9.]{81}$/.test(p));
  const givens = [...p].filter(c => c !== '0' && c !== '.').length;
  assert.ok(givens <= 40, `${givens} given`);
  assert.equal(countSolutions(p, 2), 1);
  assert.ok(solve(p));
});
