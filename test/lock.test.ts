// The app lock's PIN helpers: the PIN is kept only as a salted hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPin, hashPin, pinMatches } from '../src/lock.ts';

test('a PIN is 4 to 12 digits; spaces are taken out; anything else is refused', () => {
  assert.equal(cleanPin('1234'), '1234');
  assert.equal(cleanPin(' 12 34 56 '), '123456');
  assert.equal(cleanPin('123'), null);
  assert.equal(cleanPin('1234567890123'), null);
  assert.equal(cleanPin('12a4'), null);
  assert.equal(cleanPin(undefined), null);
});

test('the PIN is kept as a salted hash that only the same PIN matches', () => {
  const f = hashPin('4321');
  assert.doesNotMatch(JSON.stringify(f), /4321/);
  assert.equal(pinMatches('4321', f), true);
  assert.equal(pinMatches('4322', f), false);
  // The same PIN with another salt gives another hash.
  assert.notEqual(hashPin('4321').hash, f.hash);
});
