import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const { test: match } = await load('regex.js');

// Every case is checked against JavaScript's own RegExp, which agrees on this subset.
const CASES = [
  ['abc', 'xxabcxx'], ['abc', 'ab'], ['^abc', 'abcd'], ['^abc', 'xabc'], ['abc$', 'xabc'], ['abc$', 'abcx'], ['^$', ''], ['^$', 'a'],
  ['a.c', 'abc'], ['a.c', 'ac'], ['ab*c', 'ac'], ['ab*c', 'abbbc'], ['ab+c', 'ac'], ['ab+c', 'abbc'], ['ab?c', 'ac'], ['ab?c', 'abbc'],
  ['cat|dog', 'hotdog'], ['cat|dog', 'bird'], ['^(cat|dog)s?$', 'dogs'], ['^(cat|dog)s?$', 'cats!'], ['(ab)+', 'ababab'], ['^(ab)+$', 'aba'],
  ['[abc]+', 'zzzb'], ['[^abc]+', 'abc'], ['^[a-c]+$', 'abcabc'], ['^[a-c]+$', 'abcd'], ['[0-9]+', 'room 42'], ['^[0-9]+$', '42a'],
  ['\\d+', 'a1'], ['\\d+', 'abc'], ['^\\w+$', 'snake_case9'], ['^\\w+$', 'no way'], ['\\s', 'a b'], ['\\s', 'ab'], ['a\\.b', 'a.b'], ['a\\.b', 'axb'],
  ['a\\*', 'a*'], ['(a|b)*c', 'ababc'], ['(a|b)*c', 'abab'], ['^(a|ab)(c|bcd)(d*)$', 'abcd'], ['x*', ''], ['^x*$', 'xxy'],
  ['^(\\d+)-(\\d+)$', '10-20'], ['^(\\d+)-(\\d+)$', '10-'], ['colou?r', 'color'], ['colou?r', 'colouur'], ['^.*$', 'anything at all'], ['^.+$', ''],
  ['a|b|c', 'xcx'], ['(|a)b', 'b'], ['^(a?)*b$', 'aab'], ['[a-z]+@[a-z]+\\.com', 'me@site.com'], ['[a-z]+@[a-z]+\\.com', 'me@site.org'],
  ['^[^@ ]+@[^@ ]+$', 'a@b'], ['^[^@ ]+@[^@ ]+$', 'a b@c'], ['\\\\', 'a\\b'], ['[.]', 'a.b'], ['[.]', 'ab'], ['[\\d]+', 'x9'], ['^(a(b(c)))$', 'abc'],
];

test('agrees with RegExp on a table of patterns', () => {
  const wrong = [];
  for (const [p, s] of CASES) {
    let got;
    try { got = match(p, s); } catch (e) { got = `threw ${e.message}`; }
    const want = new RegExp(p).test(s);
    if (got !== want) wrong.push(`/${p}/ on "${s}": got ${got}, want ${want}`);
  }
  assert.deepEqual(wrong, []);
});

test('a pattern that makes a backtracking engine stall finishes at once', () => {
  const t = Date.now();
  assert.equal(match('^(a*)*b$', 'a'.repeat(40)), false);
  assert.equal(match('^(a|aa)+$', 'a'.repeat(40) + 'b'), false);
  assert.equal(match('(x+x+)+y', 'x'.repeat(40)), false);
  assert.ok(Date.now() - t < 2000, `took ${Date.now() - t} ms`);
});

test('a long text is matched in reasonable time', () => {
  const t = Date.now();
  assert.equal(match('needle$', 'hay'.repeat(100000) + 'needle'), true);
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
});

test('a broken pattern throws an error', () => {
  for (const p of ['(', 'a)', '[abc', '*a', '+']) assert.throws(() => match(p, 'a'), Error, p);
});
