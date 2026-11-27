// Joining a shot list's clips into one WebM (src/webmjoin.ts): the frames are copied as they are, shot after shot,
// and each clip's clusters start where the clips before it end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JOIN_MOST, joinWebm, parseWebm } from '../src/webmjoin.ts';

const clip = new Uint8Array(readFileSync(new URL('./fixtures/fake-clip.webm', import.meta.url)));

test('a clip is read: one VP8 track, its size, its clusters and how long it runs', () => {
  const p = parseWebm(clip);
  assert.ok(!('error' in p), 'error' in p ? p.error : '');
  assert.equal(p.codec, 'V_VP8');
  assert.ok(p.width > 0 && p.height > 0);
  assert.ok(p.clusters.length >= 1 && p.clusters.every(c => c.blocks.length >= 1));
  assert.ok(p.length > 0);
});

test('three clips joined: every frame, in order, the clusters moved on by the clips before, the length added up', () => {
  const one = parseWebm(clip);
  assert.ok(!('error' in one));
  const j = joinWebm([{ name: 'Shot 1', bytes: clip }, { name: 'Shot 2', bytes: clip }, { name: 'Shot 3', bytes: clip }]);
  assert.ok(!('error' in j), 'error' in j ? j.error : '');
  const back = parseWebm(new Uint8Array(j.bytes));
  assert.ok(!('error' in back), 'error' in back ? back.error : '');
  assert.equal(back.codec, one.codec);
  assert.equal(back.width, one.width);
  assert.equal(back.height, one.height);
  assert.equal(back.clusters.length, one.clusters.length * 3);
  const frames = (p: typeof one) => p.clusters.reduce((n, c) => n + c.blocks.length, 0);
  assert.equal(frames(back), frames(one) * 3);
  // The frames are the same bytes, and each copy's clusters start one clip later.
  assert.deepEqual(Buffer.from(back.clusters[one.clusters.length].blocks[0]), Buffer.from(one.clusters[0].blocks[0]));
  assert.equal(back.clusters[one.clusters.length].time, one.clusters[0].time + one.length);
  assert.equal(back.clusters[one.clusters.length * 2].time, one.clusters[0].time + one.length * 2);
  assert.equal(back.length, one.length * 3);
  assert.equal(j.seconds, Math.round((one.length * 3 * one.scale) / 1e8) / 10);
});

test('a clip of another size is named and refused; one clip, or one that is not a WebM, is refused', () => {
  const one = parseWebm(clip);
  assert.ok(!('error' in one));
  // The same clip with another width: the PixelWidth element's value changed in place.
  const other = Uint8Array.from(clip);
  const at = Buffer.from(other).indexOf(Buffer.from([0xb0]), Buffer.from(other).indexOf(Buffer.from([0xe0])));
  const len = other[at + 1] & 0x7f;
  other[at + 1 + len] ^= 0x01;
  const j = joinWebm([{ name: 'Shot 1', bytes: clip }, { name: 'Shot 2', bytes: other }]);
  assert.ok('error' in j);
  assert.match(j.error, /^Shot 2 is \d+×\d+ and Shot 1 is \d+×\d+: one video needs one size\./);
  assert.match((joinWebm([{ name: 'Shot 1', bytes: clip }]) as { error: string }).error, /Two clips or more/);
  assert.match((joinWebm([{ name: 'Shot 1', bytes: clip }, { name: 'Shot 2', bytes: new Uint8Array([1, 2, 3]) }]) as { error: string }).error, /^Shot 2 cannot be joined: it is not a WebM video\./);
  assert.ok(JOIN_MOST >= 512 * 1024 * 1024);
});

test('the shot list joins its made shots on the server, and the page has the button', () => {
  const server = readFileSync(new URL('../src/server/shots.ts', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../public/shots.js', import.meta.url), 'utf8');
  assert.match(server, /'\/api\/shots\/join': async/);
  // The kept take of each made shot, skipped ones left out, a shot not made named.
  assert.match(server, /if \(s\.state === 'skipped'\) continue;/);
  assert.match(server, /const take = s\.takes\.find\(t => t\.clip === s\.kept\) \?\? s\.takes\.at\(-1\);/);
  // Shots not made yet are left out and named, so the list can be watched before it is finished.
  assert.match(server, /if \(s\.state !== 'done' \|\| !take\) \{\s*out\.push\(i \+ 1\);\s*continue;/);
  assert.match(server, /\(not made yet: \$\{listWords\(out\)\}\)/);
  // Onto the Videos shelf and into the project, as any clip.
  assert.match(server, /await clipShelf\.add\(clip\);/);
  assert.match(server, /await clipHooks\.made\?\.\(clip, join\(clipShelf\.dir, file\)\)/);
  assert.match(page, /b\('Join the shots into one video'/);
  assert.match(page, /\{ off: made < 2 \}\)\);/);
});
