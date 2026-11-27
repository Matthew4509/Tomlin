// Reference pictures sent with a picture asked of a linked PC (src/drawrefs.ts), and kept with a queued picture
// (src/queue.ts). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DRAW_BODY, REF_BYTES_MOST, REFS_SENT_MOST, cleanRefImages } from '../src/drawrefs.ts';
import { REFS_MOST } from '../src/cards.ts';
import { cleanItem } from '../src/queue.ts';

import sharp from 'sharp';

const HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n: number) => Buffer.concat([HEAD, Buffer.alloc(n, 7)]).toString('base64');
// A whole PNG: eight PNG bytes and then rubbish is not one (src/drawrefs.ts isSoundPng).
const REAL = (await sharp({ create: { width: 32, height: 32, channels: 3, background: '#336699' } }).png().toBuffer()).toString('base64');

test('only base64 PNGs of 4 MB or less go to the runner, at most four', () => {
  const ok = REAL;
  assert.deepEqual(cleanRefImages([png(1000)]), [], 'a PNG head and then rubbish');
  assert.deepEqual(cleanRefImages([ok]), [ok]);
  assert.deepEqual(cleanRefImages('not a list'), []);
  assert.deepEqual(cleanRefImages([42, null, ok]), [ok]);
  assert.deepEqual(cleanRefImages([Buffer.from('GIF89a-not-a-png').toString('base64')]), []);
  assert.deepEqual(cleanRefImages(['not base64!']), []);
  assert.deepEqual(cleanRefImages([png(REF_BYTES_MOST + 1)]), []);
  assert.equal(cleanRefImages([ok, ok, ok, ok, ok, ok]).length, REFS_SENT_MOST);
});

test('a draw request with four of the largest pictures fits the draw door', () => {
  assert.equal(REFS_SENT_MOST, REFS_MOST);
  const one = Math.ceil(REF_BYTES_MOST / 3) * 4;
  // Sealed, the request is base64 again.
  assert.ok(DRAW_BODY >= Math.ceil((REFS_SENT_MOST * one * 4) / 3));
  assert.ok(DRAW_BODY < 64 * 2 ** 20);
});

test('a queued picture keeps its @Name pictures as workspace paths, never one outside it', () => {
  const it = cleanItem({ id: 'abc123', kind: 'picture', title: 'Ember', refs: ['story/specialists/characters/Ember/front.png', '../secret.png', 'C:\\Windows\\x.png', '/etc/x.png', 'a/../../b.png', 7] });
  assert.deepEqual(it?.refs, ['story/specialists/characters/Ember/front.png']);
  assert.equal(cleanItem({ id: 'abc123', kind: 'picture', title: 'Ember', refs: [] })?.refs, undefined);
});

test('the pictures go to a linked PC only when it says draw-refs, and its note says when they were left out', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'jobrun', 'links.ts'), 'utf8');
  assert.match(src, /can\.includes\(DRAW_REFS_CAN\)/);
  assert.match(src, /without the reference pictures: it runs an older TOMLIN/);
  const node = readFileSync(join(import.meta.dirname, '..', 'src', 'jobrun', 'node.ts'), 'utf8');
  assert.match(node, /p === '\/worker\/draw' \? DRAW_BODY/);
  assert.match(node, /cleanRefImages\(b\.refImages\)/);
});
