// A5: an admin PC whose owner had turned admin access off before there was no switch (2.1.31) is told, once, that it is on
// now: the key made from that file says so until a new key is made by hand. Behaviour, not source text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostKey, type KeyFile } from '../src/hostpin.ts';

test('a file that said off: told until a new key is made by hand; a plain file never is', async () => {
  const saved: KeyFile[] = [];
  const save = async (f: KeyFile) => void saved.push(f);
  const k = new HostKey({ off: true }, save);
  assert.equal(k.made, false);
  assert.equal(k.wasOff, true);
  // Made the first time a linked PC needs it: the file keeps that it was off before.
  const used = await k.use();
  assert.ok(used?.secret);
  assert.equal(saved.at(-1)?.offBefore, true);
  assert.equal(k.wasOff, true);
  // Read again from that file (TOMLIN started again): still told.
  assert.equal(new HostKey(saved.at(-1), save).wasOff, true);
  // Make a new key (the person acted on the Admin PC row): no longer told.
  await k.reset();
  assert.equal(saved.at(-1)?.offBefore, undefined);
  assert.equal(k.wasOff, false);
  // Never off: never told.
  const plain = new HostKey(null, save);
  await plain.use();
  assert.equal(plain.wasOff, false);
  assert.equal(saved.at(-1)?.offBefore, undefined);
});

test('the key is not given out while this PC is locked, off file or not', async () => {
  const k = new HostKey({ off: true }, async () => undefined, () => false);
  assert.equal(await k.use(), null);
  assert.equal(k.peek(), null);
});
