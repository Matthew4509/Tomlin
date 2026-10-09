// A PC's name, make / model and photo as you know it (src/pcprofile.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { PcProfileStore, cleanProfile, isPcKey, photoPng, profileView, shownName, PHOTO_SIZE } from '../src/pcprofile.ts';

test('keys, cleaning and the name shown', () => {
  for (const ok of ['here', 'c0ffee42', 'a-b-1']) assert.ok(isPcKey(ok), ok);
  for (const bad of ['', '../x', 'Here', 'a/b', 'x'.repeat(65), '-a']) assert.ok(!isPcKey(bad), bad);
  assert.deepEqual(cleanProfile({ name: '  Study\nlaptop  ', model: 'Dell  OptiPlex 9020', photo: 'yesterday', extra: 1 }), { name: 'Study laptop', model: 'Dell OptiPlex 9020', photo: '' });
  assert.equal(cleanProfile({ name: 'x'.repeat(99) }).name.length, 40);
  assert.equal(shownName(cleanProfile({ name: 'Gaming PC', model: 'HP Z240' }), 'Worker PC'), 'Gaming PC');
  assert.equal(shownName(cleanProfile({ model: 'HP Z240' }), 'Worker PC'), 'HP Z240');
  assert.equal(shownName(undefined, 'Worker PC'), 'Worker PC');
  assert.equal(profileView('here', cleanProfile({})).photo, null);
});

test('a photo is turned into the kept square; anything else says why', async () => {
  const jpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 30, g: 60, b: 90 } } }).jpeg().toBuffer();
  const png = await photoPng(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
  const meta = await sharp(png).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, PHOTO_SIZE);
  assert.equal(meta.height, PHOTO_SIZE);
  await assert.rejects(photoPng('data:text/html;base64,PGgxPg=='), /PNG, JPEG, WebP or GIF/);
  await assert.rejects(photoPng(`data:image/png;base64,${Buffer.from('not a picture').toString('base64')}`), /could not be read as a picture/);
  await assert.rejects(photoPng(42), /PNG, JPEG, WebP or GIF/);
});

test('the store keeps words and photo apart, and forgets a PC', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pcprofile-'));
  try {
    const store = new PcProfileStore(dir);
    assert.deepEqual(await store.all(), {});
    await store.setWords('here', { name: 'Study laptop', model: 'Dell Latitude' });
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    const withPhoto = await store.setPhoto('c0ffee42', png, new Date('2026-10-08T10:00:00.000Z'));
    assert.equal(withPhoto.photo, '2026-10-08T10:00:00.000Z');
    // Changing the words keeps the photo; a name only leaves the make / model alone.
    await store.setWords('c0ffee42', { name: 'Gaming PC' });
    await store.setWords('here', { model: '' });
    const all = await new PcProfileStore(dir).all();
    assert.deepEqual(all.here, { name: 'Study laptop', model: '', photo: '' });
    assert.deepEqual(all['c0ffee42'], { name: 'Gaming PC', model: '', photo: '2026-10-08T10:00:00.000Z' });
    assert.ok(await store.photoPath('c0ffee42'));
    assert.equal(await store.photoPath('here'), null);
    await assert.rejects(store.setWords('../x', { name: 'x' }), /No such PC/);
    // Photo off, then the PC forgotten: nothing left behind.
    await store.setPhoto('c0ffee42', null);
    assert.equal(existsSync(join(dir, 'c0ffee42.png')), false);
    await store.forget('c0ffee42');
    assert.deepEqual(Object.keys(await store.all()), ['here']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
