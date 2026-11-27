// A2: 10 recovery codes for the app lock. Shown once, kept only as salted hashes, each one works once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_ALPHABET, CODE_COUNT, cleanCode, codesLeft, hashCodes, makeCodes, RecoveryCodes, type CodesFile } from '../src/recovery.ts';

test('10 codes, XXXXX-XXXXX, from an alphabet without 0, O, 1, I or L, none the same', () => {
  assert.equal(CODE_COUNT, 10);
  for (const c of '0O1IL') assert.ok(!CODE_ALPHABET.includes(c), c);
  assert.ok(CODE_ALPHABET.length >= 30, 'about 50 bits a code');
  const codes = makeCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) {
    assert.match(c, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/, c);
    for (const ch of c.replace('-', '')) assert.ok(CODE_ALPHABET.includes(ch), ch);
  }
});

test('a code is read with or without its dash, in either case, with spaces; anything else is not a code', () => {
  assert.equal(cleanCode('ABCDE-FGHJK'), 'ABCDEFGHJK');
  assert.equal(cleanCode(' abcde fghjk '), 'ABCDEFGHJK');
  assert.equal(cleanCode('abcdefghjk'), 'ABCDEFGHJK');
  assert.equal(cleanCode('ABCDE-FGHJ'), null);
  assert.equal(cleanCode('ABCDE-FGHJ0'), null);
  assert.equal(cleanCode('ABCDE-FGHJI'), null);
  assert.equal(cleanCode(undefined), null);
});

test('only salted hashes are kept: no code is in the file, each has its own salt', async () => {
  const codes = makeCodes();
  const file = await hashCodes(codes);
  const text = JSON.stringify(file);
  for (const c of codes) {
    assert.ok(!text.includes(c), c);
    assert.ok(!text.includes(c.replace('-', '')), c);
  }
  assert.equal(file.codes.length, 10);
  assert.equal(new Set(file.codes.map(c => c.salt)).size, 10);
  for (const c of file.codes) assert.deepEqual(Object.keys(c).sort(), ['cost', 'hash', 'salt', 'used']);
  assert.equal(codesLeft(file), 10);
});

test('each code works once; a wrong one works never; the set saves after each use', async () => {
  const codes = makeCodes();
  let saved: CodesFile | null = null;
  const set = new RecoveryCodes(await hashCodes(codes), async f => {
    saved = f;
  });
  assert.equal(await set.use('ABCDE-FGHJK'), false);
  assert.equal(await set.use(null), false);
  assert.equal(await set.use(codes[3]), true);
  assert.equal(set.left(), 9);
  assert.equal(saved && codesLeft(saved), 9, 'the used code is crossed off on disk');
  assert.equal(await set.use(codes[3]), false, 'used once already');
  assert.equal(await set.use(codes[3].toLowerCase().replace('-', ' ')), false, 'the same code written another way');
  // check: right or wrong without using it.
  assert.equal(await set.check(codes[4]), true);
  assert.equal(set.left(), 9);
});

test('the same code sent twice at once is used only once', async () => {
  const codes = makeCodes();
  const set = new RecoveryCodes(await hashCodes(codes), async () => undefined);
  const r = await Promise.all([set.use(codes[0]), set.use(codes[0]), set.use(codes[0])]);
  assert.deepEqual(r.filter(Boolean).length, 1);
  assert.equal(set.left(), 9);
});

test('when the use cannot be saved, the code is not taken as used (and does not open)', async () => {
  const codes = makeCodes();
  const set = new RecoveryCodes(await hashCodes(codes), async () => {
    throw new Error('disk full');
  });
  await assert.rejects(set.use(codes[1]), /disk full/);
  assert.equal(set.left(), 10);
});

test('a new set voids the old one', async () => {
  const first = makeCodes();
  const set = new RecoveryCodes(await hashCodes(first), async () => undefined);
  const second = makeCodes();
  set.replace(await hashCodes(second));
  assert.equal(await set.use(first[0]), false);
  assert.equal(await set.use(second[0]), true);
});

test('the lock screen asks for a recovery code in two boxes of five with the dash between, and moves between them', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const lock = readFileSync(new URL('../public/lock.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(html, /<input id="applock-code-a"[^>]*maxlength="11"[^>]*>\n\s+<span class="code-dash" aria-hidden="true">-<\/span>\n\s+<input id="applock-code-b"[^>]*maxlength="5"/);
  assert.doesNotMatch(html, /id="applock-code"/);
  // Sent as XXXXX-XXXXX; the server reads it without the dash either way.
  assert.match(lock, /code: recoveryCodeTyped\(\),/);
  assert.match(lock, /if \(v\.length >= 5\) \{\n\s+codeBoxB\.focus\(\);/);
  assert.match(lock, /if \(e\.key === 'Backspace' && !codeBoxB\.value\) \{/);
  // A whole code pasted fills both boxes; the same split the input handler does.
  const codeChars = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pasted = codeChars('abcde-fghjk');
  assert.deepEqual([pasted.slice(0, 5), pasted.slice(5, 10)], ['ABCDE', 'FGHJK']);
  assert.match(lock, /const codeChars = v => v\.toUpperCase\(\)\.replace\(\/\[\^A-Z0-9\]\/g, ''\);/);
  const { cleanCode } = await import('../src/recovery.ts');
  assert.equal(cleanCode('ABCDE-FGHJK'), cleanCode('ABCDEFGHJK'));
});
