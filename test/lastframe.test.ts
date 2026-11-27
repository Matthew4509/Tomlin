// A shot list carries on from the last frame of the shot before, read on the server (src/webmjoin.ts lastFrameWebp:
// stable-diffusion.cpp writes every frame as a VP8 key frame, which is a WebP picture's insides), and a blank frame is
// never carried on from (src/colourmatch.ts isBlank): a hidden page read a black frame and the next shot lost the fox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { lastFrameWebp, parseWebm, vp8Webp } from '../src/webmjoin.ts';
import { blankFrame, carryFrame, isBlank } from '../src/colourmatch.ts';

const fixture = new Uint8Array(readFileSync(new URL('./fixtures/fake-clip.webm', import.meta.url)));

/** An EBML element with an eight-byte size. */
function el(id: number[], ...parts: Uint8Array[]): Buffer {
  const body = Buffer.concat(parts);
  const size = Buffer.alloc(8);
  size[0] = 0x01;
  for (let i = 7, v = body.length; i >= 1; i--, v = Math.floor(v / 256)) size[i] = v & 0xff;
  return Buffer.concat([Buffer.from(id), size, body]);
}

/** A picture's VP8 key frame, as sharp writes it inside a lossy WebP. */
async function vp8Of(png: Buffer): Promise<Buffer> {
  const webp = await sharp(png).webp({ quality: 90 }).toBuffer();
  assert.equal(webp.toString('latin1', 12, 16), 'VP8 ', 'sharp wrote a simple lossy WebP');
  return webp.subarray(20, 20 + webp.readUInt32LE(16));
}

/** A WebM with the fixture's header and track, and one cluster of these frames (each a key frame). */
function webmOf(frames: Buffer[]): Uint8Array {
  const p = parseWebm(fixture);
  assert.ok(!('error' in p));
  const blocks = frames.map((f, i) => el([0xa3], Buffer.from([0x81, 0, i * 40, 0x80]), f));
  const cluster = el([0x1f, 0x43, 0xb6, 0x75], el([0xe7], Buffer.from([0])), ...blocks);
  return new Uint8Array(Buffer.concat([Buffer.from(p.header), el([0x18, 0x53, 0x80, 0x67], Buffer.from(p.tracks), cluster)]));
}

const picture = (r: number, g: number, b: number) => sharp({ create: { width: 64, height: 48, channels: 3, background: { r, g, b } } })
  .composite([{ input: Buffer.from('<svg width="64" height="48"><circle cx="20" cy="24" r="14" fill="#e06010"/><rect x="38" y="8" width="20" height="32" fill="#2050c0"/></svg>') }])
  .png().toBuffer();

test('the last frame of a clip whose frames are key frames is read as a picture, with no page and no decoder', async () => {
  const first = await vp8Of(await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer());
  const lastPng = await picture(200, 220, 240);
  const clip = webmOf([first, await vp8Of(lastPng)]);
  const webp = lastFrameWebp(clip);
  assert.ok(!('error' in webp), 'error' in webp ? webp.error : '');
  const meta = await sharp(webp).metadata();
  assert.equal(meta.width, 64);
  assert.equal(meta.height, 48);
  // It is the last frame (the picture), not the first (black): close to the picture it was made from.
  const got = await sharp(webp).removeAlpha().raw().toBuffer();
  const want = await sharp(lastPng).removeAlpha().raw().toBuffer();
  let d = 0;
  for (let i = 0; i < want.length; i++) d += Math.abs(got[i] - want[i]);
  assert.ok(d / want.length < 8, `the frame read is the picture (mean difference ${(d / want.length).toFixed(1)})`);
});

test('a clip it cannot read that way is said, so the page reads it instead (not a key frame, not VP8, not a WebM)', () => {
  // The fixture's frames are VP8 that refer to the frame before: its last is not a key frame.
  assert.deepEqual(lastFrameWebp(fixture), { error: 'its last frame is not a key frame' });
  assert.deepEqual(lastFrameWebp(new Uint8Array([1, 2, 3])), { error: 'it is not a WebM video' });
});

test('a VP8 frame is wrapped as RIFF WEBP with one VP8 chunk, padded to an even length', () => {
  const w = vp8Webp(new Uint8Array([1, 2, 3]));
  assert.equal(w.toString('latin1', 0, 4), 'RIFF');
  assert.equal(w.toString('latin1', 8, 16), 'WEBPVP8 ');
  assert.equal(w.readUInt32LE(16), 3);
  assert.equal(w.length, 20 + 4);
  assert.equal(w.readUInt32LE(4), w.length - 8);
});

test('a black or flat frame is blank and is never colour matched into a flat grey; a real frame is not blank', async () => {
  const black = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
  const grey = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 96, g: 96, b: 98 } } }).png().toBuffer();
  assert.equal(await blankFrame(black), true);
  assert.equal(await blankFrame(grey), true);
  assert.equal(await blankFrame(await picture(30, 60, 120)), false);
  assert.equal(isBlank({ mean: [0, 0, 0], std: [0, 0, 0] }), true);
  const ref = { mean: [96, 96, 98] as [number, number, number], std: [40, 40, 40] as [number, number, number], from: 'picture' as const, key: 'k', at: '' };
  assert.equal((await carryFrame(black, { ref, key: 'k', picture: null })).png, null);
});

test('the server reads the last frame itself and refuses a blank one; the page never reads one while hidden', () => {
  const server = readFileSync(new URL('../src/server/shots.ts', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../public/shots.js', import.meta.url), 'utf8');
  assert.match(server, /setInterval\(\(\) => void framesHere\(\), 3000\)/);
  // A blank frame read from the clip itself is the clip's real end: the next shot fails with words (audit LF-07).
  assert.match(server, /if \(await blankFrame\(png\)\.catch\(\(\) => false\)\) \{[\s\S]{0,200}await shots\.blankEnd\(/);
  assert.match(server, /if \(await blankFrame\(png\)\.catch\(\(\) => true\)\) return \{ status: 400/);
  assert.match(server, /'\/api\/shots\/frame': async[\s\S]{0,300}takeFrame\(/);
  assert.match(page, /if \(app\.lockShown \|\| !app\.lastFrameOf \|\| document\.hidden\) return;/);
  // The PC that runs a list is kept awake while it runs (test copies never ask Windows).
  assert.match(server, /const listAwake = process\.env\.TOMLIN_HOME \|\| process\.env\.TOMLIN_DATA \? null : keepAwakeHolder\(\);/);
});
