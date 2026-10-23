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

test('A1: a lock is a PIN or a password; a password is any length of 1 or more and keeps its spaces', async () => {
  const { cleanSecret, cleanKind } = await import('../src/lock.ts');
  assert.equal(cleanKind('password'), 'password');
  assert.equal(cleanKind('pin'), 'pin');
  assert.equal(cleanKind(undefined), 'pin', 'a file from before A1 (no kind) is a PIN');
  assert.equal(cleanKind('other'), 'pin');
  // A PIN keeps its rules: 4 to 12 digits, 4 allowed.
  assert.equal(cleanSecret('pin', ' 12 34 '), '1234');
  assert.equal(cleanSecret('pin', '123'), null);
  assert.equal(cleanSecret('pin', 'abcd'), null);
  // A password: nothing refused but empty (or too long to be one).
  assert.equal(cleanSecret('password', 'a'), 'a');
  assert.equal(cleanSecret('password', 'my dog Rex'), 'my dog Rex');
  assert.equal(cleanSecret('password', '1234'), '1234');
  assert.equal(cleanSecret('password', ''), null);
  assert.equal(cleanSecret('password', undefined), null);
  assert.equal(cleanSecret('password', 'x'.repeat(2000)), null);
});

test('A1: the strength line says weak, OK or strong, and refuses nothing', async () => {
  const { strength } = await import('../src/lock.ts');
  for (const w of ['a', '1234', 'password', 'aaaaaaaaaaaa', 'qwerty']) assert.equal(strength(w), 'weak', w);
  for (const w of ['Rex2019dog', 'blue-kettle7']) assert.equal(strength(w), 'OK', w);
  for (const w of ['maple river cloud stone', 'T7#qL!m2v@Rz9']) assert.equal(strength(w), 'strong', w);
});

test('A1: Generate gives plain words, picked at random from a long list', async () => {
  const { generateWords, WORDS } = await import('../src/lock.ts');
  assert.ok(new Set(WORDS).size >= 1000, `${new Set(WORDS).size} words`);
  assert.equal(new Set(WORDS).size, WORDS.length, 'no word twice in the list');
  for (const w of WORDS) assert.match(w, /^[a-z]{3,8}$/, w);
  const four = generateWords(4);
  assert.equal(four.split(' ').length, 4);
  for (const w of four.split(' ')) assert.ok(WORDS.includes(w), w);
  assert.equal(generateWords(5).split(' ').length, 5);
  assert.notEqual(generateWords(4), generateWords(4));
});

test('A1: hashSecret and secretMatches are the PIN helpers under their new names', async () => {
  const { hashSecret, secretMatches } = await import('../src/lock.ts');
  assert.equal(hashSecret, hashPin);
  assert.equal(secretMatches, pinMatches);
  const f = await hashSecret('long pass phrase');
  assert.equal(await secretMatches('long pass phrase', f), true);
  assert.equal(await secretMatches('long pass phrasE', f), false);
});
