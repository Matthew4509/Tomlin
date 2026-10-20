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

test('the PIN is kept as a salted hash that only the same PIN matches', async () => {
  const f = await hashPin('4321');
  // No field holds the PIN itself (the hex hash may happen to contain those four digits, so each value is compared whole).
  for (const v of Object.values(f)) assert.notEqual(String(v), '4321');
  assert.deepEqual(Object.keys(f).sort(), ['cost', 'hash', 'salt']);
  assert.equal(await pinMatches('4321', f), true);
  assert.equal(await pinMatches('4322', f), false);
  // The same PIN with another salt gives another hash.
  assert.notEqual((await hashPin('4321')).hash, f.hash);
});

test('S5: a new PIN hash is made at a higher scrypt cost, kept in the file; an older file (no cost) still opens and asks to be made again', async () => {
  const { PIN_COST, needsRehash } = await import('../src/lock.ts');
  const { scryptSync } = await import('node:crypto');
  assert.ok(PIN_COST >= 2 ** 17);
  const f = await hashPin('135790');
  assert.equal(f.cost, PIN_COST);
  assert.equal(await pinMatches('135790', f), true);
  assert.equal(await pinMatches('135791', f), false);
  assert.equal(needsRehash(f), false);
  // A file written before 2.0.56: scrypt's default cost, no cost field.
  const old = { salt: 'abcd', hash: scryptSync('2468', 'abcd', 32).toString('hex') };
  assert.equal(await pinMatches('2468', old), true);
  assert.equal(await pinMatches('2469', old), false);
  assert.equal(needsRehash(old), true);
  // A cost that is not a sane power of two is not used (a damaged or doctored file).
  assert.equal(await pinMatches('2468', { ...old, cost: 3 }), false);
});
